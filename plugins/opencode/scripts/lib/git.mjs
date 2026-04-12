// Git utilities for the OpenCode companion.
//
// Modified by JohnnyVicious (2026): added PR-fetch helpers (`detectPrReference`,
// `getPrInfo`, `getPrDiff`) so reviews can target a GitHub pull request via
// `gh` instead of only local working-tree state. (Apache License 2.0 §4(b)
// modification notice.)

import fs from "node:fs";
import path from "node:path";
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

// ------------------------------------------------------------------
// Worktree helpers (for --worktree isolated rescue runs)
// ------------------------------------------------------------------

/**
 * Create a disposable git worktree under `<repoRoot>/.worktrees/opencode-<ts>`
 * on a new `opencode/<ts>` branch. Also adds `.worktrees/` to the repo's
 * `.git/info/exclude` so the directory never shows up in `git status`.
 *
 * @param {string} repoRoot
 * @returns {Promise<{ worktreePath: string, branch: string, repoRoot: string, baseCommit: string, timestamp: number }>}
 */
export async function createWorktree(repoRoot) {
  const ts = Date.now();
  const worktreesDir = path.join(repoRoot, ".worktrees");
  fs.mkdirSync(worktreesDir, { recursive: true });

  // Resolve the real git dir (handles linked worktrees where .git is a file).
  const gitDirResult = await runCommand("git", ["rev-parse", "--git-dir"], { cwd: repoRoot });
  const rawGitDir = gitDirResult.stdout.trim();
  const gitDir = path.resolve(repoRoot, rawGitDir);
  const excludePath = path.join(gitDir, "info", "exclude");
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  if (!existing.includes(".worktrees")) {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(excludePath, `${sep}.worktrees/\n`);
  }

  const worktreePath = path.join(worktreesDir, `opencode-${ts}`);
  const branch = `opencode/${ts}`;
  const baseCommitResult = await runCommand("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  if (baseCommitResult.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${baseCommitResult.stderr.trim()}`);
  }
  const baseCommit = baseCommitResult.stdout.trim();

  const addResult = await runCommand(
    "git",
    ["worktree", "add", worktreePath, "-b", branch],
    { cwd: repoRoot }
  );
  if (addResult.exitCode !== 0) {
    throw new Error(`git worktree add failed: ${addResult.stderr.trim()}`);
  }

  return { worktreePath, branch, repoRoot, baseCommit, timestamp: ts };
}

/**
 * Remove a worktree (force). Swallows "not a working tree" so callers can
 * safely retry cleanup.
 * @param {string} repoRoot
 * @param {string} worktreePath
 */
export async function removeWorktree(repoRoot, worktreePath) {
  const { exitCode, stderr } = await runCommand(
    "git",
    ["worktree", "remove", "--force", worktreePath],
    { cwd: repoRoot }
  );
  if (exitCode !== 0 && !stderr.includes("is not a working tree")) {
    throw new Error(`git worktree remove failed: ${stderr.trim()}`);
  }
}

/**
 * Delete a branch (force). Failures are swallowed — this is best-effort
 * cleanup after the worktree has already been removed.
 */
export async function deleteWorktreeBranch(repoRoot, branch) {
  await runCommand("git", ["branch", "-D", branch], { cwd: repoRoot });
}

/**
 * Compute the diff the worktree made on top of the base commit. Stages
 * everything first so uncommitted edits (which is what OpenCode actually
 * produces) show up in the diff.
 * @returns {Promise<{ stat: string, patch: string }>}
 */
export async function getWorktreeDiff(worktreePath, baseCommit) {
  await runCommand("git", ["add", "-A"], { cwd: worktreePath });
  const statR = await runCommand(
    "git",
    ["diff", "--cached", baseCommit, "--stat"],
    { cwd: worktreePath }
  );
  if (statR.exitCode !== 0 || !statR.stdout.trim()) {
    return { stat: "", patch: "" };
  }
  const patchR = await runCommand(
    "git",
    ["diff", "--cached", baseCommit],
    { cwd: worktreePath }
  );
  return { stat: statR.stdout.trim(), patch: patchR.stdout };
}

/**
 * Apply the worktree diff back to `repoRoot` as a staged patch. Returns
 * `{ applied, detail }` — detail includes any git error when apply fails.
 */
export async function applyWorktreePatch(repoRoot, worktreePath, baseCommit) {
  await runCommand("git", ["add", "-A"], { cwd: worktreePath });
  const patchR = await runCommand(
    "git",
    ["diff", "--cached", baseCommit],
    { cwd: worktreePath }
  );
  if (patchR.exitCode !== 0 || !patchR.stdout.trim()) {
    return { applied: false, detail: "No changes to apply." };
  }
  const patchPath = path.join(
    repoRoot,
    `.opencode-worktree-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`
  );
  try {
    fs.writeFileSync(patchPath, patchR.stdout, "utf8");
    const applyR = await runCommand(
      "git",
      ["apply", "--index", patchPath],
      { cwd: repoRoot }
    );
    if (applyR.exitCode !== 0) {
      return {
        applied: false,
        detail: applyR.stderr.trim() || "Patch apply failed (conflicts?).",
      };
    }
    return { applied: true, detail: "Changes applied and staged." };
  } finally {
    fs.rmSync(patchPath, { force: true });
  }
}
