// Disposable git-worktree sessions for isolated write-capable rescue runs.
// Wraps the lower-level helpers in lib/git.mjs so handleTask can swap the
// working directory transparently and offer the user a keep/discard choice
// at the end.

import {
  getGitRoot,
  createWorktree,
  removeWorktree,
  deleteWorktreeBranch,
  getWorktreeDiff,
  applyWorktreePatch,
} from "./git.mjs";

/**
 * Create a new worktree session rooted at `cwd`'s repo. Throws if cwd is
 * not inside a git repository.
 * @param {string} cwd
 * @returns {Promise<{ worktreePath: string, branch: string, repoRoot: string, baseCommit: string, timestamp: number }>}
 */
export async function createWorktreeSession(cwd) {
  const repoRoot = await getGitRoot(cwd);
  if (!repoRoot) {
    throw new Error("Not a git repository — --worktree requires one.");
  }
  return createWorktree(repoRoot);
}

/**
 * Compute the diff produced inside a worktree session.
 * @param {{ worktreePath: string, baseCommit: string }} session
 * @returns {Promise<{ stat: string, patch: string }>}
 */
export async function diffWorktreeSession(session) {
  return getWorktreeDiff(session.worktreePath, session.baseCommit);
}

/**
 * Tear down a worktree session. When `keep` is true, the diff is first
 * applied back to the repo as a staged patch; on success the worktree and
 * branch are removed. On apply failure the worktree is preserved so the
 * user can recover manually.
 *
 * @param {{ worktreePath: string, branch: string, repoRoot: string, baseCommit: string }} session
 * @param {{ keep?: boolean }} [opts]
 * @returns {Promise<{ applied: boolean, detail: string }>}
 */
export async function cleanupWorktreeSession(session, opts = {}) {
  const keep = Boolean(opts.keep);

  if (keep) {
    const result = await applyWorktreePatch(
      session.repoRoot,
      session.worktreePath,
      session.baseCommit
    );
    // Only tear down when the apply succeeded or there was nothing to apply.
    // On a real apply failure we leave the worktree in place for recovery.
    if (!result.applied && result.detail !== "No changes to apply.") {
      return result;
    }
    await removeWorktree(session.repoRoot, session.worktreePath);
    await deleteWorktreeBranch(session.repoRoot, session.branch);
    return result;
  }

  await removeWorktree(session.repoRoot, session.worktreePath);
  await deleteWorktreeBranch(session.repoRoot, session.branch);
  return { applied: false, detail: "Worktree discarded." };
}
