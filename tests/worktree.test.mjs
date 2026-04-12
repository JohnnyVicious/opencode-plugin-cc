import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";
import {
  createWorktreeSession,
  diffWorktreeSession,
  cleanupWorktreeSession,
} from "../plugins/opencode/scripts/lib/worktree.mjs";

let repo;

beforeEach(async () => {
  repo = createTmpDir("worktree-");
  await runCommand("git", ["init", "-q"], { cwd: repo });
  await runCommand("git", ["config", "user.email", "t@t.t"], { cwd: repo });
  await runCommand("git", ["config", "user.name", "t"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.js"), "export const a = 1;\n");
  await runCommand("git", ["add", "."], { cwd: repo });
  await runCommand("git", ["commit", "-q", "-m", "init"], { cwd: repo });
});

afterEach(() => {
  cleanupTmpDir(repo);
});

describe("worktree session", () => {
  it("creates a worktree, branch, and gitignore exclude entry", async () => {
    const session = await createWorktreeSession(repo);
    try {
      assert.ok(session.worktreePath);
      assert.match(session.branch, /^opencode\//);
      assert.ok(fs.existsSync(session.worktreePath));
      assert.ok(fs.existsSync(path.join(session.worktreePath, "a.js")));

      const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
      assert.match(exclude, /\.worktrees\//);

      // Branch exists
      const branches = await runCommand("git", ["branch"], { cwd: repo });
      assert.match(branches.stdout, new RegExp(session.branch.replace(/\//g, "\\/")));
    } finally {
      await cleanupWorktreeSession(session, { keep: false }).catch(() => {});
    }
  });

  it("diffWorktreeSession reports edits made inside the worktree", async () => {
    const session = await createWorktreeSession(repo);
    try {
      fs.writeFileSync(
        path.join(session.worktreePath, "a.js"),
        "export const a = 'CHANGED';\n"
      );
      const diff = await diffWorktreeSession(session);
      assert.match(diff.stat, /1 file changed/);
      assert.match(diff.patch, /CHANGED/);
    } finally {
      await cleanupWorktreeSession(session, { keep: false }).catch(() => {});
    }
  });

  it("cleanupWorktreeSession with keep:true applies the patch to the main tree", async () => {
    const session = await createWorktreeSession(repo);
    fs.writeFileSync(
      path.join(session.worktreePath, "a.js"),
      "export const a = 'KEPT';\n"
    );
    const result = await cleanupWorktreeSession(session, { keep: true });
    assert.equal(result.applied, true);
    // Worktree and branch should be gone.
    assert.equal(fs.existsSync(session.worktreePath), false);
    const branches = await runCommand("git", ["branch"], { cwd: repo });
    assert.doesNotMatch(branches.stdout, new RegExp(session.branch));
    // The change is staged in the main tree.
    const staged = await runCommand("git", ["diff", "--cached"], { cwd: repo });
    assert.match(staged.stdout, /KEPT/);
  });

  it("cleanupWorktreeSession with keep:false discards worktree and branch", async () => {
    const session = await createWorktreeSession(repo);
    fs.writeFileSync(
      path.join(session.worktreePath, "a.js"),
      "export const a = 'DISCARDED';\n"
    );
    await cleanupWorktreeSession(session, { keep: false });
    assert.equal(fs.existsSync(session.worktreePath), false);
    const branches = await runCommand("git", ["branch"], { cwd: repo });
    assert.doesNotMatch(branches.stdout, new RegExp(session.branch));
    // Main tree untouched.
    const staged = await runCommand("git", ["diff"], { cwd: repo });
    assert.doesNotMatch(staged.stdout, /DISCARDED/);
  });

  it("cleanupWorktreeSession with no changes is a clean no-op", async () => {
    const session = await createWorktreeSession(repo);
    const result = await cleanupWorktreeSession(session, { keep: true });
    assert.equal(result.applied, false);
    assert.equal(result.detail, "No changes to apply.");
    assert.equal(fs.existsSync(session.worktreePath), false);
  });
});
