// Git utilities for the OpenCode companion.
//
// Modified by JohnnyVicious (2026): added PR-fetch helpers (`detectPrReference`,
// `getPrInfo`, `getPrDiff`) so reviews can target a GitHub pull request via
// `gh` instead of only local working-tree state. (Apache License 2.0 §4(b)
// modification notice.)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
 *
 * When `opts.maxBytes` is set, the read is bounded at that cap. The returned
 * shape gains an `overflowed` flag in that case so callers can tell the
 * difference between "small diff, all of it" and "big diff, first N bytes".
 *
 * @param {string} cwd
 * @param {{ base?: string, cached?: boolean, maxBytes?: number }} opts
 * @returns {Promise<{ stdout: string, overflowed: boolean }>}
 */
export async function getDiff(cwd, opts = {}) {
  const args = ["diff"];
  if (opts.base) {
    args.push(`${opts.base}...HEAD`);
  } else if (opts.cached) {
    args.push("--cached");
  }
  const result = await runCommand("git", args, {
    cwd,
    maxOutputBytes: opts.maxBytes,
  });
  return { stdout: result.stdout, overflowed: Boolean(result.overflowed) };
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
 *
 * When `opts.maxBytes` is set, the read is bounded at that cap. `overflowed`
 * reports whether the full diff exceeded the cap — callers can then decide
 * to short-circuit to lightweight-mode without materializing the rest.
 *
 * @param {string} cwd
 * @param {number} prNumber
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<{ stdout: string, overflowed: boolean }>}
 */
export async function getPrDiff(cwd, prNumber, opts = {}) {
  const { stdout, stderr, exitCode, overflowed } = await runCommand(
    "gh",
    ["pr", "diff", String(prNumber)],
    { cwd, maxOutputBytes: opts.maxBytes }
  );
  // An overflow kill is not a real failure — we got the bytes we wanted.
  if (exitCode !== 0 && !overflowed) {
    throw new Error(`gh pr diff ${prNumber} failed: ${stderr.trim() || "unknown error"}`);
  }
  return { stdout, overflowed: Boolean(overflowed) };
}

// ------------------------------------------------------------------
// Worktree helpers (for --worktree isolated rescue runs)
// ------------------------------------------------------------------

function isPathPresent(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

async function getGitPath(repoRoot, gitPath) {
  const result = await runCommand("git", ["rev-parse", "--git-path", gitPath], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    throw new Error(`git rev-parse --git-path ${gitPath} failed: ${result.stderr.trim()}`);
  }
  return path.resolve(repoRoot, result.stdout.trim());
}

async function assertNoInProgressGitOperation(repoRoot) {
  const checks = [
    ["merge", "MERGE_HEAD"],
    ["rebase", "REBASE_HEAD"],
    ["rebase", "rebase-merge"],
    ["rebase", "rebase-apply"],
    ["bisect", "BISECT_LOG"],
  ];

  for (const [operation, gitPath] of checks) {
    const marker = await getGitPath(repoRoot, gitPath);
    if (isPathPresent(marker)) {
      throw new Error(
        `Cannot create an OpenCode worktree while the repository has an in-progress ${operation}. ` +
        `Finish or abort it first (${gitPath} exists).`
      );
    }
  }
}

async function branchExists(repoRoot, branch) {
  const result = await runCommand(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: repoRoot }
  );
  return result.exitCode === 0;
}

async function pruneStaleOpencodeWorktrees(repoRoot) {
  await runCommand("git", ["worktree", "prune"], { cwd: repoRoot });

  const listResult = await runCommand("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  const activeBranches = new Set();
  for (const line of listResult.stdout.split(/\r?\n/)) {
    const match = line.match(/^branch refs\/heads\/(.+)$/);
    if (match) activeBranches.add(match[1]);
  }

  const branchResult = await runCommand(
    "git",
    ["for-each-ref", "--format=%(refname:short)", "refs/heads/opencode"],
    { cwd: repoRoot }
  );
  if (branchResult.exitCode !== 0) return;

  for (const branch of branchResult.stdout.trim().split(/\r?\n/).filter(Boolean)) {
    if (activeBranches.has(branch)) continue;
    const merged = await runCommand(
      "git",
      ["merge-base", "--is-ancestor", branch, "HEAD"],
      { cwd: repoRoot }
    );
    if (merged.exitCode === 0) {
      await deleteWorktreeBranch(repoRoot, branch);
    }
  }
}

function makeWorktreeId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Create a disposable git worktree under `<repoRoot>/.worktrees/opencode-<ts>`
 * on a new `opencode/<ts>` branch. Also adds `.worktrees/` to the repo's
 * `.git/info/exclude` so the directory never shows up in `git status`.
 *
 * @param {string} repoRoot
 * @returns {Promise<{ worktreePath: string, branch: string, repoRoot: string, baseCommit: string, timestamp: number }>}
 */
export async function createWorktree(repoRoot) {
  await assertNoInProgressGitOperation(repoRoot);
  await pruneStaleOpencodeWorktrees(repoRoot);

  const worktreesDir = path.join(repoRoot, ".worktrees");
  fs.mkdirSync(worktreesDir, { recursive: true, mode: 0o700 });

  // Resolve the real git dir (handles linked worktrees where .git is a file).
  const gitDir = await getGitPath(repoRoot, ".");
  const excludePath = path.join(gitDir, "info", "exclude");
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  if (!existing.includes(".worktrees")) {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(excludePath, `${sep}.worktrees/\n`);
  }

  const baseCommitResult = await runCommand("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  if (baseCommitResult.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${baseCommitResult.stderr.trim()}`);
  }
  const baseCommit = baseCommitResult.stdout.trim();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = makeWorktreeId();
    const worktreePath = path.join(worktreesDir, `opencode-${id}`);
    const branch = `opencode/${id}`;
    if (fs.existsSync(worktreePath) || await branchExists(repoRoot, branch)) {
      continue;
    }

    const addResult = await runCommand(
      "git",
      ["worktree", "add", worktreePath, "-b", branch],
      { cwd: repoRoot }
    );
    if (addResult.exitCode === 0) {
      return { worktreePath, branch, repoRoot, baseCommit, timestamp: Date.now() };
    }

    if (!/already exists|is already checked out|invalid reference/i.test(addResult.stderr)) {
      throw new Error(`git worktree add failed: ${addResult.stderr.trim()}`);
    }
  }

  throw new Error("Unable to allocate a unique OpenCode worktree after 5 attempts.");
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
  let applied = false;
  try {
    fs.writeFileSync(patchPath, patchR.stdout, "utf8");
    const applyR = await runCommand(
      "git",
      ["apply", "--index", patchPath],
      { cwd: repoRoot }
    );
    if (applyR.exitCode !== 0) {
      const stderr = applyR.stderr.trim();
      return {
        applied: false,
        detail: formatApplyFailureDetail(stderr, patchPath),
      };
    }
    applied = true;
    return { applied: true, detail: "Changes applied and staged." };
  } finally {
    if (applied) {
      fs.rmSync(patchPath, { force: true });
    }
  }
}

function formatApplyFailureDetail(stderr, patchPath) {
  const detail = stderr || "Patch apply failed.";
  const lower = detail.toLowerCase();
  let hint = "Resolve the conflict manually, then retry with `git apply --index`.";
  if (lower.includes("binary patch") || lower.includes("without full index line")) {
    hint = "The patch appears to include binary changes; inspect the preserved worktree and copy binary files manually.";
  } else if (lower.includes("standard format") || lower.includes("corrupt patch")) {
    hint = "The generated patch is not in a format git can apply; inspect or edit the preserved patch before retrying.";
  } else if (lower.includes("permission denied")) {
    hint = "Git could not read or write a target path; check file permissions before retrying.";
  } else if (lower.includes("does not apply") || lower.includes("patch failed")) {
    hint = "The target files diverged; edit the preserved patch or apply the changes manually.";
  }
  return `${detail}\nPreserved patch: ${patchPath}\nHint: ${hint}`;
}
