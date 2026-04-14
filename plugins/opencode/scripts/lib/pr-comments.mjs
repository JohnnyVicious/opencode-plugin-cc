// Post an OpenCode review back to a GitHub pull request.
//
// Structured review findings from OpenCode have a `file`, `line_start`,
// `line_end`, `confidence`, and a recommendation. We can turn them into:
//   - a summary comment on the PR with the full findings table, and
//   - inline review comments anchored to specific lines for findings
//     whose confidence exceeds the user-supplied threshold (default 0.8)
//     AND whose target line is addressable on GitHub's unified diff for
//     that PR.
//
// GitHub rejects review comments on lines that are not part of the PR's
// diff, so we parse each file's `patch` returned by the pulls/files
// endpoint to learn which RIGHT-side line numbers are addressable. A
// high-confidence finding whose line is outside the diff silently
// degrades to summary-only; we never drop the finding.
//
// We post via `gh api` piping a JSON payload on stdin rather than via
// `gh pr review`, because the CLI wrapper doesn't support inline review
// comments directly and serializing a comments array through repeated
// -f/-F flags is fragile.

import { spawn } from "node:child_process";

/**
 * Post a review to PR `prNumber`. Never throws on posting errors —
 * returns a result object the caller can log, because the review text
 * was already produced and the local run should not fail because of a
 * network or auth glitch on GitHub.
 *
 * @param {string} workspace - cwd for the `gh` invocations
 * @param {object} opts
 * @param {number} opts.prNumber
 * @param {object|null} opts.structured - parsed review JSON (or null)
 * @param {string} opts.rendered - human-readable review output (fallback
 *   when `structured` is null)
 * @param {{ providerID: string, modelID: string }|null} opts.model
 * @param {boolean} opts.adversarial
 * @param {number} [opts.confidenceThreshold=0.8]
 * @returns {Promise<{ posted: boolean, reviewUrl?: string, inlineCount: number, summaryOnlyCount: number, error?: string }>}
 */
export async function postReviewToPr(workspace, opts) {
  const {
    prNumber,
    structured,
    rendered,
    model,
    adversarial,
    confidenceThreshold = 0.8,
  } = opts;

  try {
    const prData = await fetchPrData(workspace, prNumber);

    const findings = Array.isArray(structured?.findings) ? structured.findings : [];
    const addableByFile = buildAddableLineMap(prData.files);
    const { inline, summaryOnly } = splitFindings(
      findings,
      addableByFile,
      confidenceThreshold
    );

    const summaryBody = renderSummaryBody({
      structured,
      rendered,
      model,
      adversarial,
      inlineCount: inline.length,
      summaryOnlyCount: summaryOnly.length,
      confidenceThreshold,
    });

    const payload = {
      commit_id: prData.headSha,
      event: "COMMENT",
      body: summaryBody,
      comments: inline.map(findingToInlineComment),
    };

    const resp = await ghPostReview(workspace, prNumber, payload);
    return {
      posted: true,
      reviewUrl: resp.html_url,
      inlineCount: inline.length,
      summaryOnlyCount: summaryOnly.length,
    };
  } catch (err) {
    return {
      posted: false,
      error: err.message,
      inlineCount: 0,
      summaryOnlyCount: 0,
    };
  }
}

// ---------------------------------------------------------------------
// gh plumbing
// ---------------------------------------------------------------------

/**
 * Run a `gh` subcommand and return parsed stdout. `input` is piped to
 * stdin. Rejects with a useful error on non-zero exit codes.
 */
function runGh(workspace, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("gh", args, {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `gh ${args.join(" ")} exited ${code}: ${stderr.trim() || "(no stderr)"}`
          )
        );
        return;
      }
      resolve(stdout);
    });
    if (input != null) {
      proc.stdin.write(input);
    }
    proc.stdin.end();
  });
}

async function fetchPrData(workspace, prNumber) {
  const headJson = await runGh(workspace, [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "headRefOid",
  ]);
  let headSha;
  try {
    headSha = JSON.parse(headJson).headRefOid;
  } catch (err) {
    throw new Error(`gh pr view returned invalid JSON: ${err.message}`);
  }
  if (typeof headSha !== "string" || headSha.length === 0) {
    throw new Error(
      `gh pr view ${prNumber} did not return a headRefOid; is the PR visible to this token?`
    );
  }

  // `gh api` paginates via `--paginate`, but the pulls/files endpoint
  // returns at most 30 per page by default — bump per_page to 100 and
  // paginate so huge PRs don't lose files past the first page.
  const filesJson = await runGh(workspace, [
    "api",
    "--paginate",
    `repos/{owner}/{repo}/pulls/${prNumber}/files?per_page=100`,
  ]);
  const files = parsePaginatedJson(filesJson);
  return { headSha, files };
}

/**
 * `gh api --paginate` concatenates the per-page JSON arrays as separate
 * documents rather than a single merged array, so a naive JSON.parse
 * only sees the last page. Split on the `][` page boundary and merge.
 */
function parsePaginatedJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  // The simple case: gh emitted one page as one array.
  if (trimmed.startsWith("[") && !trimmed.includes("][")) {
    return JSON.parse(trimmed);
  }
  // Multi-page: treat `][` as a page separator and reconstitute.
  const chunks = trimmed.split(/\]\s*\[/).map((chunk, i, arr) => {
    let c = chunk;
    if (i > 0) c = `[${c}`;
    if (i < arr.length - 1) c = `${c}]`;
    return c;
  });
  const out = [];
  for (const chunk of chunks) {
    const arr = JSON.parse(chunk);
    if (Array.isArray(arr)) out.push(...arr);
  }
  return out;
}

async function ghPostReview(workspace, prNumber, payload) {
  const stdout = await runGh(
    workspace,
    [
      "api",
      "-X",
      "POST",
      `repos/{owner}/{repo}/pulls/${prNumber}/reviews`,
      "--input",
      "-",
    ],
    { input: JSON.stringify(payload) }
  );
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`gh api POST reviews returned invalid JSON: ${err.message}`);
  }
}

// ---------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------

/**
 * Parse the unified diff in a PR file's `patch` field and return the
 * set of RIGHT-side line numbers that GitHub will accept as the `line`
 * field of a review comment. Those are lines present in the diff as
 * either additions (`+`) or unchanged context (` `). Deletions (`-`)
 * only exist on the LEFT side and would need `side: "LEFT"`, which we
 * don't bother supporting — our findings target the current state of
 * the code, not the old version.
 *
 * Exported for tests.
 *
 * @param {string} patch
 * @returns {Set<number>}
 */
export function parseAddableLines(patch) {
  const addable = new Set();
  if (typeof patch !== "string" || patch.length === 0) return addable;
  const lines = patch.split("\n");
  let rightLine = 0;
  for (const line of lines) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      rightLine = Number(hunk[1]);
      continue;
    }
    if (rightLine === 0) continue;
    // Skip the `\ No newline at end of file` marker without advancing.
    if (line.startsWith("\\")) continue;
    // Diff headers like `+++ b/path` — ignored, they never appear inside
    // a hunk but defend anyway.
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      addable.add(rightLine);
      rightLine += 1;
    } else if (line.startsWith("-")) {
      // deletion — does not advance the right side
    } else if (line.startsWith(" ") || line.length === 0) {
      // context line OR a truly-empty line (`split("\n")` leaves empties
      // where the patch had blank context).
      addable.add(rightLine);
      rightLine += 1;
    }
  }
  return addable;
}

/**
 * Build `Map<filename, Set<lineNumber>>` for all files in a PR.
 * @param {Array<{ filename: string, patch?: string }>} files
 * @returns {Map<string, Set<number>>}
 */
export function buildAddableLineMap(files) {
  const map = new Map();
  if (!Array.isArray(files)) return map;
  for (const file of files) {
    if (!file || typeof file.filename !== "string") continue;
    const addable = parseAddableLines(file.patch);
    if (addable.size > 0) map.set(file.filename, addable);
  }
  return map;
}

// ---------------------------------------------------------------------
// Finding classification
// ---------------------------------------------------------------------

/**
 * Classify findings into inline-anchored vs summary-only. A finding is
 * inline-eligible iff:
 *   - confidence >= threshold, AND
 *   - its file is present in the PR diff, AND
 *   - at least one of the lines in [line_start, line_end] is addable
 *     (present in the diff as context or addition).
 *
 * Exported for tests.
 *
 * @param {any[]} findings
 * @param {Map<string, Set<number>>} addableByFile
 * @param {number} threshold
 */
export function splitFindings(findings, addableByFile, threshold) {
  const inline = [];
  const summaryOnly = [];
  if (!Array.isArray(findings)) return { inline, summaryOnly };

  for (const f of findings) {
    if (!f || typeof f !== "object") continue;

    const conf = typeof f.confidence === "number" ? f.confidence : null;
    const hasConfidence = conf != null && conf >= threshold;
    if (!hasConfidence) {
      summaryOnly.push(f);
      continue;
    }

    const file = typeof f.file === "string" ? f.file : null;
    const addable = file ? addableByFile.get(file) : null;
    if (!addable) {
      summaryOnly.push(f);
      continue;
    }

    const start = Number(f.line_start);
    const end = Number.isFinite(Number(f.line_end)) ? Number(f.line_end) : start;
    if (!Number.isFinite(start) || start <= 0) {
      summaryOnly.push(f);
      continue;
    }

    let target = null;
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    for (let ln = lo; ln <= hi; ln += 1) {
      if (addable.has(ln)) {
        target = ln;
        break;
      }
    }
    if (target == null) {
      summaryOnly.push(f);
      continue;
    }

    inline.push({ ...f, _targetLine: target });
  }

  return { inline, summaryOnly };
}

/**
 * Build an inline review comment payload from a classified finding.
 * Exported for tests.
 */
export function findingToInlineComment(finding) {
  const sevRaw = typeof finding.severity === "string" ? finding.severity : null;
  const sev = sevRaw ? sevRaw.toUpperCase() : null;
  const confPct =
    typeof finding.confidence === "number"
      ? `${Math.round(finding.confidence * 100)}%`
      : null;

  const header = [sev ? `**${sev}**` : null, finding.title ?? "Finding"]
    .filter(Boolean)
    .join(" · ");
  const meta = confPct ? `_Confidence ${confPct}_` : "";

  const body = [];
  body.push(header);
  if (meta) body.push(meta);
  body.push("");
  if (finding.body) body.push(String(finding.body));
  if (finding.recommendation) {
    body.push("");
    body.push(`**Recommendation:** ${finding.recommendation}`);
  }
  body.push("");
  body.push("_Posted by opencode-plugin-cc._");

  return {
    path: finding.file,
    line: finding._targetLine,
    side: "RIGHT",
    body: body.join("\n"),
  };
}

// ---------------------------------------------------------------------
// Summary body rendering
// ---------------------------------------------------------------------

/**
 * Build the top-level review comment body. Exported for tests.
 * @param {object} opts
 * @param {object|null} opts.structured
 * @param {string} [opts.rendered]
 * @param {{providerID: string, modelID: string}|null} opts.model
 * @param {boolean} opts.adversarial
 * @param {number} opts.inlineCount
 * @param {number} opts.summaryOnlyCount
 * @param {number} opts.confidenceThreshold
 * @returns {string}
 */
export function renderSummaryBody(opts) {
  const {
    structured,
    rendered,
    model,
    adversarial,
    inlineCount,
    summaryOnlyCount,
    confidenceThreshold,
  } = opts;

  const lines = [];
  const title = adversarial
    ? "OpenCode Adversarial Review"
    : "OpenCode Review";

  let verdictLabel;
  if (structured?.verdict === "approve") verdictLabel = "Approve";
  else if (structured?.verdict === "needs-attention")
    verdictLabel = "Needs attention";
  else verdictLabel = "Advisory";

  lines.push(`## ${title} — ${verdictLabel}`);
  lines.push("");

  if (model?.providerID && model?.modelID) {
    lines.push(`**Model:** \`${model.providerID}/${model.modelID}\``);
    lines.push("");
  }

  if (structured?.summary) {
    lines.push(String(structured.summary));
    lines.push("");
  }

  const findings = Array.isArray(structured?.findings) ? structured.findings : [];

  if (structured && findings.length === 0) {
    lines.push("_No material findings._");
    lines.push("");
  } else if (findings.length > 0) {
    lines.push(`### Findings (${findings.length})`);
    lines.push("");
    lines.push("| # | Severity | Confidence | File | Lines | Title |");
    lines.push("|---|----------|------------|------|-------|-------|");
    findings.forEach((f, i) => {
      const sev = typeof f.severity === "string" ? f.severity.toUpperCase() : "—";
      const conf =
        typeof f.confidence === "number"
          ? `${Math.round(f.confidence * 100)}%`
          : "—";
      const file = typeof f.file === "string" ? `\`${escapeTableCell(f.file)}\`` : "—";
      const lo = Number(f.line_start);
      const hi = Number(f.line_end);
      const range = Number.isFinite(lo)
        ? Number.isFinite(hi) && hi !== lo
          ? `${lo}–${hi}`
          : `${lo}`
        : "—";
      const titleCell = escapeTableCell(f.title ?? "");
      lines.push(`| ${i + 1} | ${sev} | ${conf} | ${file} | ${range} | ${titleCell} |`);
    });
    lines.push("");

    lines.push("<details><summary>Full findings</summary>");
    lines.push("");
    findings.forEach((f, i) => {
      const sev = typeof f.severity === "string" ? f.severity.toUpperCase() : "";
      const lo = Number(f.line_start);
      const hi = Number(f.line_end);
      const range =
        Number.isFinite(lo) && Number.isFinite(hi) && hi !== lo
          ? `${lo}–${hi}`
          : Number.isFinite(lo)
            ? `${lo}`
            : "?";
      lines.push(`#### ${i + 1}. ${sev ? `${sev} — ` : ""}${f.title ?? "Finding"}`);
      if (typeof f.file === "string") {
        lines.push(`- **File:** \`${f.file}\`:${range}`);
      }
      if (typeof f.confidence === "number") {
        lines.push(`- **Confidence:** ${Math.round(f.confidence * 100)}%`);
      }
      if (f.body) {
        lines.push("");
        lines.push(String(f.body));
      }
      if (f.recommendation) {
        lines.push("");
        lines.push(`**Recommendation:** ${f.recommendation}`);
      }
      lines.push("");
    });
    lines.push("</details>");
    lines.push("");
  } else if (!structured && typeof rendered === "string" && rendered.trim()) {
    // No structured output — fall back to posting the raw rendered review.
    lines.push(
      "_The model did not return structured JSON; raw review text below._"
    );
    lines.push("");
    lines.push(rendered.trim());
    lines.push("");
  }

  const threshPct = Math.round(confidenceThreshold * 100);
  const stats = [];
  if (inlineCount > 0) {
    stats.push(
      `${inlineCount} finding${inlineCount === 1 ? "" : "s"} at or above ${threshPct}% confidence posted as inline comment${inlineCount === 1 ? "" : "s"}.`
    );
  }
  if (summaryOnlyCount > 0) {
    stats.push(
      `${summaryOnlyCount} finding${summaryOnlyCount === 1 ? "" : "s"} kept in the summary only (below threshold or outside the PR diff).`
    );
  }
  if (stats.length > 0) {
    lines.push(stats.join(" "));
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "_Advisory review generated by [opencode-plugin-cc](https://github.com/JohnnyVicious/opencode-plugin-cc)._"
  );

  return lines.join("\n");
}

function escapeTableCell(text) {
  return String(text)
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}
