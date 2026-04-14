// Prompt construction for OpenCode reviews and tasks.
//
// Modified by JohnnyVicious (2026): `buildReviewPrompt` now supports
// `opts.pr` to fetch a GitHub pull request via `gh` instead of using the
// local working tree, so reviews can target an arbitrary PR without
// checking it out. (Apache License 2.0 §4(b) modification notice.)

import fs from "node:fs";
import path from "node:path";
import {
  getDiff,
  getStatus,
  getChangedFiles,
  getDiffStat,
  getPrInfo,
  getPrDiff,
} from "./git.mjs";
import { collectFolderContext } from "./fs.mjs";

// Inline-diff thresholds. When a review exceeds either, we keep the prompt
// bounded by including a diff excerpt instead of the full diff. The review
// agent is intentionally shell-disabled, so the prompt must contain the
// evidence the model is allowed to use.
const DEFAULT_INLINE_DIFF_MAX_FILES = 5;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

function buildCollectionGuidance(diffIsComplete) {
  return diffIsComplete
    ? "Use the repository context below as primary evidence."
    : "The repository context below contains a bounded diff excerpt, not the complete diff. Only report findings supported by the provided excerpt, metadata, status, and changed-file list; explicitly say when omitted diff content prevents a conclusion.";
}

function truncateUtf8(text, maxBytes) {
  if (!text) return text;
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
}

/**
 * Build the review prompt for OpenCode.
 * @param {string} cwd
 * @param {object} opts
 * @param {string} [opts.base] - base branch/ref for comparison
 * @param {number} [opts.pr] - GitHub PR number to review (uses `gh pr diff`)
 * @param {boolean} [opts.adversarial] - use adversarial review prompt
 * @param {string} [opts.focus] - user-supplied focus text
 * @param {string[]} [opts.paths] - specific paths to review instead of git diff
 * @param {string} pluginRoot - CLAUDE_PLUGIN_ROOT for reading prompt templates
 * @returns {Promise<string>}
 */
export async function buildReviewPrompt(cwd, opts, pluginRoot) {
  const maxFiles = Number.isFinite(opts.maxInlineDiffFiles)
    ? opts.maxInlineDiffFiles
    : DEFAULT_INLINE_DIFF_MAX_FILES;
  const maxBytes = Number.isFinite(opts.maxInlineDiffBytes)
    ? opts.maxInlineDiffBytes
    : DEFAULT_INLINE_DIFF_MAX_BYTES;

  let diff = "";
  let status = "";
  let changedFiles = [];
  let prInfo = null;
  let diffStat = "";
  let overByteLimit = false;
  let folderContext = null;

  // Step 1: When --path is specified, collect path context instead of git diff.
  // Paths take precedence over PR mode so a command that includes both remains
  // local and does not require gh/auth.
  if (opts.paths && opts.paths.length > 0) {
    folderContext = await collectFolderContext(cwd, opts.paths, {
      maxBytes,
      maxFiles,
    });
    changedFiles = folderContext.files;
    overByteLimit = folderContext.overflowedBytes;
    const diffBytes = folderContext.totalBytes;
    const diffIsComplete = !folderContext.overflowed;
    const collectionGuidance = buildCollectionGuidance(diffIsComplete);

    const targetLabel = `Review of ${opts.paths.join(", ")}`;

    const reviewContext = buildFolderContext(folderContext, {
      diffIsComplete,
      originalDiffBytes: diffBytes,
      maxInlineDiffBytes: maxBytes,
      maxInlineDiffFiles: maxFiles,
      overFileLimit: folderContext.overflowedFiles,
      overByteLimit: folderContext.overflowedBytes,
    });

    let systemPrompt;
    if (opts.adversarial) {
      const templatePath = path.join(pluginRoot, "prompts", "adversarial-review.md");
      systemPrompt = fs.readFileSync(templatePath, "utf8")
        .replace("{{TARGET_LABEL}}", targetLabel)
        .replace("{{USER_FOCUS}}", opts.focus || "General review")
        .replace("{{REVIEW_COLLECTION_GUIDANCE}}", collectionGuidance)
        .replace("{{REVIEW_INPUT}}", reviewContext);
    } else {
      systemPrompt = buildStandardReviewPrompt(folderContext.content, status, changedFiles, {
        ...opts,
        targetLabel,
        prInfo,
        reviewContext,
        collectionGuidance,
      });
    }

    return systemPrompt;
  }

  // Step 1: cheap metadata. The status / changed-file list / shortstat
  // reads do not materialize the full diff and are safe on any size.
  if (opts.pr) {
    prInfo = await getPrInfo(cwd, opts.pr);
    status = ""; // PR review intentionally ignores the local working tree
    changedFiles = prInfo.files;
  } else {
    status = await getStatus(cwd);
    changedFiles = await getChangedFiles(cwd, { base: opts.base });
    diffStat = await getDiffStat(cwd, { base: opts.base });
  }

  // Step 2: fetch the diff body, but bound the read at maxBytes + 1. If
  // the git/gh subprocess would produce more bytes than that, the helper
  // reports `overflowed: true` and we treat the diff as over the byte
  // limit without ever materializing the rest. Past this point we know
  // the diff string in memory is at most maxBytes + 1 bytes.
  const readCap = maxBytes + 1;
  if (opts.pr) {
    const pr = await getPrDiff(cwd, opts.pr, { maxBytes: readCap });
    diff = pr.stdout;
    overByteLimit = pr.overflowed;
  } else {
    const wt = await getDiff(cwd, { base: opts.base, maxBytes: readCap });
    diff = wt.stdout;
    overByteLimit = wt.overflowed;
  }

  const overFileLimit = changedFiles.length > maxFiles;

  // The "original" diff byte count is used for the user-facing context
  // note. When we overflowed the read, we don't know the true size — use
  // the cap as a lower bound.
  const diffBytes = overByteLimit ? readCap : Buffer.byteLength(diff, "utf8");
  const diffIsComplete = !overByteLimit;
  const diffForPrompt = overByteLimit ? truncateUtf8(diff, maxBytes) : diff;
  const collectionGuidance = buildCollectionGuidance(diffIsComplete);

  const targetLabel = prInfo
    ? `Pull request #${prInfo.number} "${prInfo.title}" (${prInfo.headRefName} -> ${prInfo.baseRefName})`
    : opts.base
      ? `Branch diff against ${opts.base}`
      : "Working tree changes";

  const reviewContext = buildReviewContext(diffForPrompt, status, changedFiles, prInfo, {
    diffIsComplete,
    originalDiffBytes: diffBytes,
    maxInlineDiffBytes: maxBytes,
    overFileLimit,
    overByteLimit,
    diffStat,
  });

  let systemPrompt;
  if (opts.adversarial) {
    const templatePath = path.join(pluginRoot, "prompts", "adversarial-review.md");
    systemPrompt = fs.readFileSync(templatePath, "utf8")
      .replace("{{TARGET_LABEL}}", targetLabel)
      .replace("{{USER_FOCUS}}", opts.focus || "General review")
      .replace("{{REVIEW_COLLECTION_GUIDANCE}}", collectionGuidance)
      .replace("{{REVIEW_INPUT}}", reviewContext);
  } else {
    systemPrompt = buildStandardReviewPrompt(diff, status, changedFiles, {
      ...opts,
      targetLabel,
      prInfo,
      reviewContext,
      collectionGuidance,
    });
  }

  return systemPrompt;
}

/**
 * Build a standard (non-adversarial) review prompt.
 */
function buildStandardReviewPrompt(diff, status, changedFiles, opts) {
  const targetLabel = opts.targetLabel
    ?? (opts.base ? `branch diff against ${opts.base}` : "working tree changes");

  const reviewContext =
    opts.reviewContext
    ?? buildReviewContext(diff, status, changedFiles, opts.prInfo, { diffIsComplete: true });
  const collectionGuidance = opts.collectionGuidance ?? buildCollectionGuidance(true);

  return `You are performing a code review of ${targetLabel}.

Respond in plain markdown prose. Do NOT wrap the review in JSON and do
NOT emit a code-fenced schema. Open with a one-line ship/no-ship
assessment in your own words.

For every material finding, use the shape below (literal headings, in
order):

### <SEVERITY> — <title>
- **File:** \`<path>\`:<line_start>-<line_end>
- **Confidence:** <low | medium | high>

<one or two paragraphs of analysis>

**Recommendation:** <concrete change>

Severity must be one of \`LOW\`, \`MEDIUM\`, \`HIGH\`, \`CRITICAL\`.

Focus on:
- Correctness and logic errors
- Security vulnerabilities
- Performance issues
- Missing error handling
- API contract violations

Be concise and actionable. Only report real issues, not style
preferences. If you have no material findings, say so directly after
the opening line and stop.

${collectionGuidance}

${reviewContext}`;
}

/**
 * Build the repository context block for review prompts.
 *
 * When `opts.diffIsComplete` is false, the `<diff>` block is a bounded
 * excerpt. The surrounding note tells the model not to invent findings from
 * omitted content.
 */
function buildReviewContext(diff, status, changedFiles, prInfo, opts = {}) {
  const sections = [];

  if (prInfo) {
    sections.push(
      `<pr_metadata>\n` +
      `number: ${prInfo.number}\n` +
      `title: ${prInfo.title}\n` +
      `base: ${prInfo.baseRefName}\n` +
      `head: ${prInfo.headRefName}\n` +
      `url: ${prInfo.url}\n` +
      `stats: +${prInfo.additions}/-${prInfo.deletions} across ${prInfo.changedFiles} files\n` +
      `</pr_metadata>`
    );
  }

  if (status) {
    sections.push(`<git_status>\n${status}\n</git_status>`);
  }

  if (changedFiles.length > 0) {
    sections.push(`<changed_files>\n${changedFiles.join("\n")}\n</changed_files>`);
  }

  if (opts.overFileLimit || opts.overByteLimit) {
    const reasons = [];
    if (opts.overFileLimit) reasons.push(`file count ${changedFiles.length}`);
    if (opts.overByteLimit) {
      reasons.push(`diff size ${opts.originalDiffBytes} bytes`);
    }
    const budget = opts.overByteLimit && opts.maxInlineDiffBytes
      ? `; excerpt budget ${opts.maxInlineDiffBytes} bytes`
      : "";
    const note = opts.diffIsComplete === false
      ? "Diff context is bounded"
      : "Review spans a broad changed-file set, but the diff below is complete";
    sections.push(
      `<diff_note>\n` +
      `${note} (${reasons.join(", ")}${budget}). ` +
      `Findings must be supported by the diff evidence below.\n` +
      `</diff_note>`
    );
    if (opts.diffStat) {
      sections.push(`<diff_stat>\n${opts.diffStat}\n</diff_stat>`);
    }
  }

  if (diff) {
    sections.push(`<diff>\n${diff}\n</diff>`);
  }

  return sections.join("\n\n");
}

/**
 * Build the repository context block for folder/path-based review prompts.
 * Uses <files> section instead of <diff> when context is collected from paths.
 */
function buildFolderContext(folderContext, opts = {}) {
  const sections = [];

  if (folderContext.files.length > 0) {
    sections.push(`<files_reviewed>\n${folderContext.files.join("\n")}\n</files_reviewed>`);
  }

  if (opts.overFileLimit || opts.overByteLimit) {
    const reasons = [];
    if (opts.overFileLimit) {
      const max = opts.maxInlineDiffFiles;
      reasons.push(max ? `file count limit ${max} reached` : "file count limit reached");
    }
    if (opts.overByteLimit) {
      reasons.push(`content size ${opts.originalDiffBytes} bytes`);
    }
    const budget = opts.overByteLimit && opts.maxInlineDiffBytes
      ? `; excerpt budget ${opts.maxInlineDiffBytes} bytes`
      : "";
    const note = opts.diffIsComplete === false
      ? "File content is bounded"
      : "Review spans multiple files, but all content is included";
    sections.push(
      `<content_note>\n` +
      `${note} (${reasons.join(", ")}${budget}). ` +
      `Findings must be supported by the file evidence below.\n` +
      `</content_note>`
    );
  }

  if (folderContext.content) {
    sections.push(`<files>\n${folderContext.content}\n</files>`);
  }

  return sections.join("\n\n");
}

/**
 * Build a task prompt from user input.
 * @param {string} taskText
 * @param {object} opts
 * @param {boolean} [opts.write] - whether to allow writes
 * @returns {string}
 */
export function buildTaskPrompt(taskText, opts = {}) {
  const parts = [];

  if (opts.write) {
    parts.push("You have full read/write access. Make the necessary code changes.");
  } else {
    parts.push("This is a read-only investigation. Do not modify any files.");
  }

  parts.push("");
  parts.push(taskText);

  return parts.join("\n");
}
