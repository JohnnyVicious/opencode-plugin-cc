import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";
import {
  getGitRoot,
  getCurrentBranch,
  getStatus,
  detectPrReference,
} from "../plugins/opencode/scripts/lib/git.mjs";

let tmpDir;

beforeEach(async () => {
  tmpDir = createTmpDir("git-test");
  // Initialize a git repo
  await runCommand("git", ["init"], { cwd: tmpDir });
  await runCommand("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: tmpDir });
  // Create initial commit
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test\n");
  await runCommand("git", ["add", "."], { cwd: tmpDir });
  await runCommand("git", ["commit", "-m", "init"], { cwd: tmpDir });
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

describe("git", () => {
  it("getGitRoot returns the repo root", async () => {
    const root = await getGitRoot(tmpDir);
    assert.ok(root);
    assert.ok(root.length > 0);
  });

  it("getCurrentBranch returns branch name", async () => {
    const branch = await getCurrentBranch(tmpDir);
    assert.ok(branch === "main" || branch === "master");
  });

  it("getStatus returns empty for clean repo", async () => {
    const status = await getStatus(tmpDir);
    assert.equal(status, "");
  });

  it("getStatus shows untracked files", async () => {
    fs.writeFileSync(path.join(tmpDir, "new-file.txt"), "hello\n");
    const status = await getStatus(tmpDir);
    assert.ok(status.includes("new-file.txt"));
  });
});

describe("detectPrReference", () => {
  it("matches 'PR #N' inside text", () => {
    const r = detectPrReference("on PR #390");
    assert.deepEqual(r, { prNumber: 390, matched: "PR #390" });
  });

  it("matches a bare 'PR #N'", () => {
    const r = detectPrReference("PR #42");
    assert.deepEqual(r, { prNumber: 42, matched: "PR #42" });
  });

  it("matches 'pr #N' lowercase", () => {
    const r = detectPrReference("pr #7");
    assert.deepEqual(r, { prNumber: 7, matched: "pr #7" });
  });

  it("matches 'PR N' without the hash", () => {
    const r = detectPrReference("PR 123");
    assert.deepEqual(r, { prNumber: 123, matched: "PR 123" });
  });

  it("matches 'pr N' lowercase without the hash", () => {
    const r = detectPrReference("pr 1");
    assert.deepEqual(r, { prNumber: 1, matched: "pr 1" });
  });

  it("matches the first PR reference inside longer focus text", () => {
    const r = detectPrReference("review PR #42 for security issues");
    assert.deepEqual(r, { prNumber: 42, matched: "PR #42" });
  });

  it("returns null when no PR reference is present", () => {
    assert.equal(detectPrReference("review the auth changes"), null);
  });

  it("does NOT match a bare '#N' issue reference", () => {
    // Issue/comment references like "fix #123" must not be misread as PRs.
    assert.equal(detectPrReference("fix #123 in the code"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(detectPrReference(""), null);
  });

  it("returns null for null/undefined input", () => {
    assert.equal(detectPrReference(null), null);
    assert.equal(detectPrReference(undefined), null);
  });

  it("matched substring can be stripped to clean focus text", () => {
    const focus = "review PR #42 for security issues";
    const detected = detectPrReference(focus);
    assert.ok(detected);
    const stripped = focus
      .replace(detected.matched, "")
      .replace(/\s+/g, " ")
      .trim();
    assert.equal(stripped, "review for security issues");
  });
});
