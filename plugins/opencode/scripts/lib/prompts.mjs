// Prompt construction for OpenCode reviews and tasks.
//
// Modified by JohnnyVicious (2026): `buildReviewPrompt` now supports
// `opts.pr` to fetch a GitHub pull request via `gh` instead of using the
// local working tree, so reviews can target an arbitrary PR without
// checking it out. (Apache License 2.0 §4(b) modification notice.)

import fs from "node:fs";
import path from "node:path";
import { getDiff, getStatus, getChangedFiles, getPrInfo, getPrDiff } from "./git.mjs";

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

  if (opts.pr) {
    prInfo = await getPrInfo(cwd, opts.pr);
    diff = await getPrDiff(cwd, opts.pr);
    status = ""; // PR review intentionally ignores the local working tree
    changedFiles = prInfo.files;
  } else {
    diff = await getDiff(cwd, { base: opts.base });
    status = await getStatus(cwd);
    changedFiles = await getChangedFiles(cwd, { base: opts.base });
  }

  const targetLabel = prInfo
    ? `Pull request #${prInfo.number} "${prInfo.title}" (${prInfo.headRefName} -> ${prInfo.baseRefName})`
    : opts.base
      ? `Branch diff against ${opts.base}`
      : "Working tree changes";

  let systemPrompt;
  if (opts.adversarial) {
    const templatePath = path.join(pluginRoot, "prompts", "adversarial-review.md");
    systemPrompt = fs.readFileSync(templatePath, "utf8")
      .replace("{{TARGET_LABEL}}", targetLabel)
      .replace("{{USER_FOCUS}}", opts.focus || "General review")
      .replace("{{REVIEW_INPUT}}", buildReviewContext(diff, status, changedFiles, prInfo));
  } else {
    systemPrompt = buildStandardReviewPrompt(diff, status, changedFiles, { ...opts, targetLabel, prInfo });
  }

  return systemPrompt;
}

/**
 * Build a standard (non-adversarial) review prompt.
 */
function buildStandardReviewPrompt(diff, status, changedFiles, opts) {
  const targetLabel = opts.targetLabel
    ?? (opts.base ? `branch diff against ${opts.base}` : "working tree changes");

  return `You are performing a code review of ${targetLabel}.

Review the following changes and provide structured feedback in JSON format matching the review-output schema.

Focus on:
- Correctness and logic errors
- Security vulnerabilities
- Performance issues
- Missing error handling
- API contract violations

Be concise and actionable. Only report real issues, not style preferences.

${buildReviewContext(diff, status, changedFiles, opts.prInfo)}`;
}

/**
 * Build the repository context block for review prompts.
 */
function buildReviewContext(diff, status, changedFiles, prInfo) {
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
