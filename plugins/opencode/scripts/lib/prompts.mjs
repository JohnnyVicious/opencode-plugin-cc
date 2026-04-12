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

  const diffBytes = Buffer.byteLength(diff || "", "utf8");
  const maxFiles = Number.isFinite(opts.maxInlineDiffFiles)
    ? opts.maxInlineDiffFiles
    : DEFAULT_INLINE_DIFF_MAX_FILES;
  const maxBytes = Number.isFinite(opts.maxInlineDiffBytes)
    ? opts.maxInlineDiffBytes
    : DEFAULT_INLINE_DIFF_MAX_BYTES;
  const overFileLimit = changedFiles.length > maxFiles;
  const overByteLimit = diffBytes > maxBytes;
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
