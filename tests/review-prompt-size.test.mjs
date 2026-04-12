import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";
import { buildReviewPrompt } from "../plugins/opencode/scripts/lib/prompts.mjs";

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "opencode"
);

let tmpDir;

beforeEach(async () => {
  tmpDir = createTmpDir("review-prompt-size-");
  await runCommand("git", ["init", "-q"], { cwd: tmpDir });
  await runCommand("git", ["config", "user.email", "t@t.t"], { cwd: tmpDir });
  await runCommand("git", ["config", "user.name", "t"], { cwd: tmpDir });
  // Initial commit with 4 tracked files so subsequent tests can modify
  // without needing to stage new files.
  for (const name of ["a.js", "b.js", "c.js", "d.js"]) {
    fs.writeFileSync(path.join(tmpDir, name), `export const ${name[0]} = 1;\n`);
  }
  await runCommand("git", ["add", "."], { cwd: tmpDir });
  await runCommand("git", ["commit", "-q", "-m", "init"], { cwd: tmpDir });
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

describe("buildReviewPrompt large-diff fallback", () => {
  it("inlines the diff for a small working-tree change", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.js"), "export const a = 'INLINE_MARKER';\n");

    const prompt = await buildReviewPrompt(
      tmpDir,
      { adversarial: true, focus: "test" },
      PLUGIN_ROOT
    );

    assert.match(prompt, /<diff>/);
    assert.match(prompt, /INLINE_MARKER/);
    assert.match(prompt, /primary evidence/);
    assert.doesNotMatch(prompt, /diff too large to inline/);
  });

  it("includes a bounded diff excerpt when maxInlineDiffBytes is exceeded", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "a.js"),
      `export const a = '${"x".repeat(2048)}';\n`
    );

    const prompt = await buildReviewPrompt(
      tmpDir,
      {
        adversarial: true,
        focus: "test",
        maxInlineDiffBytes: 128,
        maxInlineDiffFiles: 100,
      },
      PLUGIN_ROOT
    );

    assert.match(prompt, /<diff_note>/);
    assert.match(prompt, /<diff>\n/);
    assert.match(prompt, /<diff_stat>/);
    assert.match(prompt, /bounded diff excerpt/);
    assert.doesNotMatch(prompt, /read-only git commands/);
    // The x-heavy content should not be inlined.
    assert.doesNotMatch(prompt, /xxxxxxxxxxxxxx/);
  });

  it("marks broad file-count reviews but keeps diff evidence in the prompt", async () => {
    // Modify 3 already-tracked files; cap at 2.
    for (const name of ["b.js", "c.js", "d.js"]) {
      fs.writeFileSync(path.join(tmpDir, name), `export const ${name[0]} = 'modified';\n`);
    }

    const prompt = await buildReviewPrompt(
      tmpDir,
      {
        adversarial: true,
        focus: "test",
        maxInlineDiffFiles: 2,
        maxInlineDiffBytes: 10_000_000,
      },
      PLUGIN_ROOT
    );

    assert.match(prompt, /<diff_note>/);
    assert.match(prompt, /<diff>\n/);
    assert.match(prompt, /modified/);
    assert.match(prompt, /broad changed-file set/);
    assert.doesNotMatch(prompt, /bounded diff excerpt/);
  });

  it("injects collection guidance into adversarial template", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.js"), "export const a = 'XXXX';\n");

    const prompt = await buildReviewPrompt(
      tmpDir,
      { adversarial: true, focus: "test" },
      PLUGIN_ROOT
    );

    // The template still has both opening/closing tags.
    assert.match(prompt, /<review_collection_guidance>/);
    assert.match(prompt, /<\/review_collection_guidance>/);
    // The placeholder must be replaced, not left as literal.
    assert.doesNotMatch(prompt, /\{\{REVIEW_COLLECTION_GUIDANCE\}\}/);
  });
});
