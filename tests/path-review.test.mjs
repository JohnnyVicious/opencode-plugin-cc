import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";
import { collectFolderContext } from "../plugins/opencode/scripts/lib/fs.mjs";
import { buildReviewPrompt } from "../plugins/opencode/scripts/lib/prompts.mjs";

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "opencode"
);

let tmpDir;

beforeEach(() => {
  tmpDir = createTmpDir("path-review-");
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

describe("collectFolderContext", () => {
  it("recursively collects directory targets", async () => {
    fs.mkdirSync(path.join(tmpDir, "src", "nested"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "index.js"), "export const root = true;\n");
    fs.writeFileSync(path.join(tmpDir, "src", "nested", "child.js"), "export const child = true;\n");

    const context = await collectFolderContext(tmpDir, ["src"]);

    assert.deepEqual(context.files, ["src/index.js", "src/nested/child.js"]);
    assert.match(context.content, /root = true/);
    assert.match(context.content, /child = true/);
    assert.equal(context.overflowed, false);
  });

  it("rejects sibling paths that share the workspace prefix", async () => {
    const repo = path.join(tmpDir, "repo");
    const sibling = path.join(tmpDir, "repo-evil");
    fs.mkdirSync(repo);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, "secret.txt"), "do not read me\n");

    const context = await collectFolderContext(repo, ["../repo-evil/secret.txt"]);

    assert.deepEqual(context.files, []);
    assert.doesNotMatch(context.content, /do not read me/);
  });

  it("does not follow symlinks outside the workspace", async () => {
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    const outside = path.join(tmpDir, "outside.txt");
    fs.writeFileSync(outside, "outside secret\n");
    fs.symlinkSync(outside, path.join(repo, "inside-link.txt"));

    const context = await collectFolderContext(repo, ["inside-link.txt"]);

    assert.deepEqual(context.files, []);
    assert.doesNotMatch(context.content, /outside secret/);
  });

  it("respects gitignore rules for nested files", async () => {
    await runCommand("git", ["init", "-q"], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored/\n");
    fs.mkdirSync(path.join(tmpDir, "ignored"));
    fs.writeFileSync(path.join(tmpDir, "ignored", "secret.js"), "export const secret = true;\n");
    fs.writeFileSync(path.join(tmpDir, "visible.js"), "export const visible = true;\n");

    const context = await collectFolderContext(tmpDir, ["ignored", "visible.js"]);

    assert.deepEqual(context.files, ["visible.js"]);
    assert.doesNotMatch(context.content, /secret = true/);
    assert.match(context.content, /visible = true/);
  });

  it("skips binary files", async () => {
    fs.writeFileSync(path.join(tmpDir, "image.bin"), Buffer.from([0x01, 0x00, 0x02]));
    fs.writeFileSync(path.join(tmpDir, "text.txt"), "plain text\n");

    const context = await collectFolderContext(tmpDir, ["."]);

    assert.deepEqual(context.files, ["text.txt"]);
    assert.doesNotMatch(context.content, /image\.bin/);
    assert.match(context.content, /plain text/);
  });

  it("reports file-count overflow when maxFiles is reached", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "a.js"), "a\n");
    fs.writeFileSync(path.join(tmpDir, "src", "b.js"), "b\n");

    const context = await collectFolderContext(tmpDir, ["src"], { maxFiles: 1 });

    assert.deepEqual(context.files, ["src/a.js"]);
    assert.equal(context.overflowed, true);
    assert.equal(context.overflowedFiles, true);
    assert.equal(context.overflowedBytes, false);
  });

  it("closes binary reads and reports byte overflow for truncated content", async () => {
    fs.writeFileSync(path.join(tmpDir, "large.txt"), "x".repeat(100));

    const context = await collectFolderContext(tmpDir, ["large.txt"], { maxBytes: 10 });

    assert.deepEqual(context.files, ["large.txt"]);
    assert.equal(context.overflowed, true);
    assert.equal(context.overflowedBytes, true);
    assert.match(context.content, /truncated/);
  });
});

describe("path review prompts", () => {
  it("uses path mode even when pr is also provided", async () => {
    fs.writeFileSync(path.join(tmpDir, "target.js"), "export const target = true;\n");

    const prompt = await buildReviewPrompt(
      tmpDir,
      {
        pr: 12345,
        paths: ["target.js"],
        adversarial: true,
        focus: "path mode",
      },
      PLUGIN_ROOT
    );

    assert.match(prompt, /Review of target\.js/);
    assert.match(prompt, /<files>/);
    assert.match(prompt, /target = true/);
    assert.doesNotMatch(prompt, /<pr_metadata>/);
  });

  it("emits an incomplete-evidence note when path collection is capped", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "a.js"), "a\n");
    fs.writeFileSync(path.join(tmpDir, "src", "b.js"), "b\n");

    const prompt = await buildReviewPrompt(
      tmpDir,
      {
        paths: ["src"],
        adversarial: true,
        focus: "file cap",
        maxInlineDiffFiles: 1,
      },
      PLUGIN_ROOT
    );

    assert.match(prompt, /<content_note>/);
    assert.match(prompt, /File content is bounded/);
    assert.match(prompt, /file count limit 1 reached/);
  });
});
