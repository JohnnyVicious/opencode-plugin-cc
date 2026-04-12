// Git utilities for the OpenCode companion.
//
// Modified by JohnnyVicious (2026): added PR-fetch helpers (`detectPrReference`,
// `getPrInfo`, `getPrDiff`) so reviews can target a GitHub pull request via
// `gh` instead of only local working-tree state. (Apache License 2.0 §4(b)
// modification notice.)

import { runCommand } from "./process.mjs";

/**
 * Get the git repository root for a given directory.
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function getGitRoot(cwd) {
  const { stdout, exitCode } = await runCommand(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd }
  );
  return exitCode === 0 ? stdout.trim() : null;
}

/**
 * Get the current branch name.
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function getCurrentBranch(cwd) {
  const { stdout, exitCode } = await runCommand(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd }
  );
  return exitCode === 0 ? stdout.trim() : null;
}

/**
 * Get the diff for review, supporting base-branch and working-tree modes.
 * @param {string} cwd
 * @param {{ base?: string, cached?: boolean }} opts
 * @returns {Promise<string>}
 */
export async function getDiff(cwd, opts = {}) {
  const args = ["diff"];
  if (opts.base) {
    args.push(`${opts.base}...HEAD`);
  } else if (opts.cached) {
    args.push("--cached");
  }
  const { stdout } = await runCommand("git", args, { cwd });
  return stdout;
}

/**
 * Get a short diff stat for size estimation.
 * @param {string} cwd
 * @param {{ base?: string, cached?: boolean }} opts
 * @returns {Promise<string>}
 */
export async function getDiffStat(cwd, opts = {}) {
  const args = ["diff", "--shortstat"];
  if (opts.base) {
    args.push(`${opts.base}...HEAD`);
  } else if (opts.cached) {
    args.push("--cached");
  }
  const { stdout } = await runCommand("git", args, { cwd });
  return stdout.trim();
}

/**
 * Measure the byte size of a git diff without streaming the full contents
 * back to the caller. Useful for "is this diff too big to inline?" checks.
 *
 * @param {string} cwd
 * @param {{ base?: string, cached?: boolean }} [opts]
 * @returns {Promise<number>}
 */
export async function getDiffByteSize(cwd, opts = {}) {
  const args = ["diff"];
  if (opts.base) args.push(`${opts.base}...HEAD`);
  else if (opts.cached) args.push("--cached");
  const { stdout } = await runCommand("git", args, { cwd });
  return Buffer.byteLength(stdout, "utf8");
}

/**
 * Get git status (short format).
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export async function getStatus(cwd) {
  const { stdout } = await runCommand(
    "git",
    ["status", "--short", "--untracked-files=all"],
    { cwd }
  );
  return stdout.trim();
}

/**
 * Get the list of changed files.
 * @param {string} cwd
 * @param {{ base?: string }} opts
 * @returns {Promise<string[]>}
 */
export async function getChangedFiles(cwd, opts = {}) {
  const args = ["diff", "--name-only"];
  if (opts.base) {
    args.push(`${opts.base}...HEAD`);
  }
  const { stdout } = await runCommand("git", args, { cwd });
  return stdout.trim().split("\n").filter(Boolean);
}

// ------------------------------------------------------------------
// gh (GitHub CLI) integration for PR review
// ------------------------------------------------------------------

/**
 * Detect a PR reference in arbitrary user text. Recognises "PR #N",
 * "PR N", "pr #N", "pr N" (case-insensitive). Returns the matched
 * substring so callers can strip it from focus text.
 * @param {string} text
 * @returns {{ prNumber: number, matched: string } | null}
 */
export function detectPrReference(text) {
  if (!text) return null;
  const m = text.match(/\bPR\s*#?(\d+)\b/i);
  if (!m) return null;
  return { prNumber: Number(m[1]), matched: m[0] };
}

/**
 * Fetch PR metadata + changed-file list via `gh pr view`.
 * The cwd must be a git repo whose `origin` remote points at the
 * GitHub repository that owns the PR.
 * @param {string} cwd
 * @param {number} prNumber
 * @returns {Promise<{ number: number, title: string, baseRefName: string, headRefName: string, url: string, additions: number, deletions: number, changedFiles: number, files: string[] }>}
 */
export async function getPrInfo(cwd, prNumber) {
  const { stdout, stderr, exitCode } = await runCommand(
    "gh",
    [
      "pr", "view", String(prNumber),
      "--json", "number,title,baseRefName,headRefName,url,additions,deletions,changedFiles,files",
    ],
    { cwd }
  );
  if (exitCode !== 0) {
    const hint = "Is `gh` installed (`gh --version`) and authenticated (`gh auth status`), and is the cwd a git repo with a remote pointing at the PR's repository?";
    throw new Error(`gh pr view ${prNumber} failed: ${stderr.trim() || "unknown error"}. ${hint}`);
  }
  let data;
  try {
    data = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`gh pr view ${prNumber} returned invalid JSON: ${err.message}`);
  }
  return {
    number: data.number,
    title: data.title,
    baseRefName: data.baseRefName,
    headRefName: data.headRefName,
    url: data.url,
    additions: data.additions,
    deletions: data.deletions,
    changedFiles: data.changedFiles,
    files: (data.files || []).map((f) => f.path).filter(Boolean),
  };
}

/**
 * Fetch the unified diff for a pull request via `gh pr diff`.
 * @param {string} cwd
 * @param {number} prNumber
 * @returns {Promise<string>}
 */
export async function getPrDiff(cwd, prNumber) {
  const { stdout, stderr, exitCode } = await runCommand(
    "gh",
    ["pr", "diff", String(prNumber)],
    { cwd }
  );
  if (exitCode !== 0) {
    throw new Error(`gh pr diff ${prNumber} failed: ${stderr.trim() || "unknown error"}`);
  }
  return stdout;
}
