import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import {
  runCommand,
  getOpencodeVersion,
  findOpencodeAuthFile,
  getConfiguredProviders,
} from "../plugins/opencode/scripts/lib/process.mjs";

describe("process", () => {
  it("runCommand captures stdout", async () => {
    const { stdout, exitCode } = await runCommand("echo", ["hello"]);
    assert.equal(stdout.trim(), "hello");
    assert.equal(exitCode, 0);
  });

  it("runCommand captures exit code on failure", async () => {
    const { exitCode } = await runCommand("false", []);
    assert.notEqual(exitCode, 0);
  });

  it("runCommand captures stderr", async () => {
    const { stderr, exitCode } = await runCommand("sh", ["-c", "echo err >&2"]);
    assert.ok(stderr.includes("err"));
  });

  it("runCommand caps stdout at maxOutputBytes and reports overflowed", async () => {
    // 20k bytes of 'a' via awk — POSIX-portable, works on BSD and GNU.
    const { stdout, overflowed } = await runCommand(
      "awk",
      ["BEGIN{for(i=0;i<20000;i++)printf \"a\"}"],
      { maxOutputBytes: 1000 }
    );
    assert.equal(overflowed, true);
    assert.ok(stdout.length <= 1000, `stdout length ${stdout.length} exceeded cap 1000`);
    // The captured prefix should still be 'a' characters (partial read).
    assert.match(stdout, /^a+$/);
  });

  it("runCommand does not overflow when output is under the cap", async () => {
    const { stdout, overflowed } = await runCommand(
      "sh",
      ["-c", "printf 'hello'"],
      { maxOutputBytes: 1000 }
    );
    assert.equal(overflowed, false);
    assert.equal(stdout, "hello");
  });

  it("runCommand returns a failed result when spawn emits error", async () => {
    const result = await runCommand("__opencode_missing_command_for_test__", []);
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.overflowed, false);
    assert.match(result.stderr, /__opencode_missing_command_for_test__|not found|recognized/i);
  });

  it("getOpencodeVersion returns null when opencode cannot spawn", async () => {
    const oldPath = process.env.PATH;
    const oldPathUpper = process.env.Path;
    process.env.PATH = "";
    if (oldPathUpper !== undefined) process.env.Path = "";
    try {
      assert.equal(await getOpencodeVersion(), null);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldPathUpper === undefined) delete process.env.Path;
      else process.env.Path = oldPathUpper;
    }
  });
});

// Tests for OpenCode auth.json discovery + provider detection.
//
// We override XDG_DATA_HOME to point at an isolated tmp dir so the test
// reads our fixture instead of the developer's real ~/.local/share auth
// file. The "missing file" case is intentionally not asserted here because
// `findOpencodeAuthFile` falls through to the platform-default path
// (~/.local/share/opencode/auth.json on Linux), which may legitimately
// exist on a developer machine and would make the assertion non-portable.

describe("OpenCode provider discovery", () => {
  let tmpDir;
  let savedXdg;

  beforeEach(() => {
    tmpDir = createTmpDir("opencode-auth");
    savedXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmpDir;
  });

  afterEach(() => {
    cleanupTmpDir(tmpDir);
    if (savedXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = savedXdg;
    }
  });

  function writeAuthJson(content) {
    const dir = path.join(tmpDir, "opencode");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "auth.json"), content);
    return path.join(dir, "auth.json");
  }

  it("findOpencodeAuthFile picks up XDG_DATA_HOME first", () => {
    const expected = writeAuthJson("{}");
    const found = findOpencodeAuthFile();
    assert.equal(found, expected);
  });

  it("getConfiguredProviders returns top-level keys for valid auth.json", () => {
    writeAuthJson(JSON.stringify({ openrouter: { type: "api", key: "x" } }));
    assert.deepEqual(getConfiguredProviders(), ["openrouter"]);
  });

  it("getConfiguredProviders returns multiple providers", () => {
    writeAuthJson(
      JSON.stringify({
        openrouter: { type: "api", key: "x" },
        openai: { type: "oauth", token: "y" },
        anthropic: { type: "api", key: "z" },
      })
    );
    const providers = getConfiguredProviders().sort();
    assert.deepEqual(providers, ["anthropic", "openai", "openrouter"]);
  });

  it("getConfiguredProviders returns [] for an empty auth.json object", () => {
    writeAuthJson("{}");
    assert.deepEqual(getConfiguredProviders(), []);
  });

  it("getConfiguredProviders returns [] for malformed JSON", () => {
    writeAuthJson("not valid json {{");
    assert.deepEqual(getConfiguredProviders(), []);
  });

  it("getConfiguredProviders returns [] when auth.json is a JSON array", () => {
    writeAuthJson(JSON.stringify(["not", "an", "object"]));
    assert.deepEqual(getConfiguredProviders(), []);
  });

  it("getConfiguredProviders returns [] when auth.json is a JSON null", () => {
    writeAuthJson("null");
    assert.deepEqual(getConfiguredProviders(), []);
  });
});
