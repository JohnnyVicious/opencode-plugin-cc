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

// Inline-diff thresholds. When a review exceeds either, we fall back to a
// "self-collect" context that omits the full diff and asks OpenCode to
// inspect the change itself via read-only git commands. See issue #40 and
// openai/codex-plugin-cc#179.
const DEFAULT_INLINE_DIFF_MAX_FILES = 5;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

function buildCollectionGuidance(includeDiff) {
  return includeDiff
    ? "Use the repository context below as primary evidence."
    : "The repository context below is a lightweight summary. The full diff is intentionally omitted — inspect the target yourself with read-only git commands (git diff, git log, git show) before finalizing findings.";
}

/**
 * Build the review prompt for OpenCode.
 * @param {string} cwd
 * @param {object} opts
 * @param {string} [opts.base] - base branch/ref for comparison
 * @param {number} [opts.pr] - GitHub PR number to review (uses `gh pr diff`)
 * @param {boolean} [opts.adversarial] - use adversarial review prompt
 * @param {string} [opts.focus] - user-supplied focus text
 * @param {string} pluginRoot - CLAUDE_PLUGIN_ROOT for reading prompt templates
 * @returns {Promise<string>}
 */
export async function buildReviewPrompt(cwd, opts, pluginRoot) {
  let diff, status, changedFiles;
  let prInfo = null;
  let diffStat = "";

  if (opts.pr) {
    prInfo = await getPrInfo(cwd, opts.pr);
    diff = await getPrDiff(cwd, opts.pr);
    status = ""; // PR review intentionally ignores the local working tree
    changedFiles = prInfo.files;
  } else {
    diff = await getDiff(cwd, { base: opts.base });
    status = await getStatus(cwd);
    changedFiles = await getChangedFiles(cwd, { base: opts.base });
    diffStat = await getDiffStat(cwd, { base: opts.base });
  }

  // Classify the review scope. Large reviews fall back to a lightweight
  // context (stat + changed-files list + status) so the prompt doesn't blow
  // past model/provider input limits. OpenCode is then instructed to
  // inspect the diff itself via read-only git commands.
  const diffBytes = Buffer.byteLength(diff || "", "utf8");
  const maxFiles = Number.isFinite(opts.maxInlineDiffFiles)
    ? opts.maxInlineDiffFiles
    : DEFAULT_INLINE_DIFF_MAX_FILES;
  const maxBytes = Number.isFinite(opts.maxInlineDiffBytes)
    ? opts.maxInlineDiffBytes
    : DEFAULT_INLINE_DIFF_MAX_BYTES;
  const includeDiff = changedFiles.length <= maxFiles && diffBytes <= maxBytes;
  const collectionGuidance = buildCollectionGuidance(includeDiff);

  const targetLabel = prInfo
    ? `Pull request #${prInfo.number} "${prInfo.title}" (${prInfo.headRefName} -> ${prInfo.baseRefName})`
    : opts.base
      ? `Branch diff against ${opts.base}`
      : "Working tree changes";

  const reviewContext = buildReviewContext(diff, status, changedFiles, prInfo, {
    includeDiff,
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
    ?? buildReviewContext(diff, status, changedFiles, opts.prInfo, { includeDiff: true });
  const collectionGuidance = opts.collectionGuidance ?? buildCollectionGuidance(true);

  return `You are performing a code review of ${targetLabel}.

Review the following changes and provide structured feedback in JSON format matching the review-output schema.

Focus on:
- Correctness and logic errors
- Security vulnerabilities
- Performance issues
- Missing error handling
- API contract violations

Be concise and actionable. Only report real issues, not style preferences.

${collectionGuidance}

${reviewContext}`;
}

/**
 * Build the repository context block for review prompts.
 *
 * When `opts.includeDiff` is false (large-review fallback), the full `<diff>`
 * block is omitted and a `<diff_stat>` summary is emitted instead. OpenCode
 * is expected to inspect the diff itself via read-only git commands — the
 * collection-guidance line above the context makes this explicit.
 */
function buildReviewContext(diff, status, changedFiles, prInfo, opts = {}) {
  const includeDiff = opts.includeDiff !== false;
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

  if (includeDiff) {
    if (diff) {
      sections.push(`<diff>\n${diff}\n</diff>`);
    }
  } else {
    const statBody =
      opts.diffStat && opts.diffStat.length > 0
        ? opts.diffStat
        : `(diff too large to inline: ${changedFiles.length} file(s))`;
    sections.push(`<diff_stat>\n${statBody}\n</diff_stat>`);
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
