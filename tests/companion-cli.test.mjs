import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTmpDir, cleanupTmpDir, setupTestEnv } from "./helpers.mjs";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";
import { loadState, saveState } from "../plugins/opencode/scripts/lib/state.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companionScript = path.join(repoRoot, "plugins", "opencode", "scripts", "opencode-companion.mjs");
const safeCommandScript = path.join(repoRoot, "plugins", "opencode", "scripts", "safe-command.mjs");

let tmpDir;
let workspace;

beforeEach(() => {
  tmpDir = createTmpDir("companion-cli");
  workspace = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspace);
  setupTestEnv(tmpDir);
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

function runNodeScript(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: opts.cwd ?? workspace,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: tmpDir, ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });
}

describe("opencode-companion CLI", () => {
  it("worktree-cleanup rejects ambiguous job ID prefixes", async () => {
    saveState(workspace, {
      config: {},
      jobs: [
        {
          id: "task-abc",
          type: "task",
          worktreeSession: {
            worktreePath: path.join(tmpDir, "wt-a"),
            branch: "opencode/a",
            repoRoot: workspace,
          },
        },
        {
          id: "task-abd",
          type: "task",
          worktreeSession: {
            worktreePath: path.join(tmpDir, "wt-b"),
            branch: "opencode/b",
            repoRoot: workspace,
          },
        },
      ],
    });

    const result = await runCommand(
      "node",
      [companionScript, "worktree-cleanup", "task-a", "--action", "discard"],
      { cwd: workspace, env: { CLAUDE_PLUGIN_DATA: tmpDir } }
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Ambiguous job reference/);
    assert.equal(result.stdout, "");
  });

  it("setup validates all config inputs before mutating state", async () => {
    saveState(workspace, {
      config: {
        reviewGate: false,
        defaults: {
          model: "anthropic/claude-sonnet-4-5",
          agent: "build",
        },
      },
      jobs: [],
    });

    const result = await runNodeScript([
      companionScript,
      "setup",
      "--json",
      "--enable-review-gate",
      "--review-gate-max",
      "0",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /--review-gate-max must be a positive integer/);
    assert.equal(loadState(workspace).config.reviewGate, false);
    assert.equal(loadState(workspace).config.reviewGateMaxPerSession, undefined);
    assert.deepEqual(loadState(workspace).config.defaults, {
      model: "anthropic/claude-sonnet-4-5",
      agent: "build",
    });
  });

  it("setup persists default model and agent", async () => {
    const result = await runNodeScript([
      companionScript,
      "setup",
      "--json",
      "--default-model",
      "anthropic/claude-opus-4-6",
      "--default-agent",
      "plan",
    ]);

    assert.equal(result.exitCode, 0);
    const status = JSON.parse(result.stdout);
    assert.deepEqual(status.defaults, {
      model: "anthropic/claude-opus-4-6",
      agent: "plan",
    });
    assert.deepEqual(loadState(workspace).config.defaults, {
      model: "anthropic/claude-opus-4-6",
      agent: "plan",
    });
  });

  it("setup can clear default model and agent", async () => {
    saveState(workspace, {
      config: {
        defaults: {
          model: "anthropic/claude-opus-4-6",
          agent: "build",
        },
      },
      jobs: [],
    });

    const result = await runNodeScript([
      companionScript,
      "setup",
      "--json",
      "--default-model",
      "off",
      "--default-agent",
      "off",
    ]);

    assert.equal(result.exitCode, 0);
    const status = JSON.parse(result.stdout);
    assert.deepEqual(status.defaults, { model: null, agent: null });
    assert.deepEqual(loadState(workspace).config.defaults, {
      model: null,
      agent: null,
    });
  });

  it("setup rejects invalid defaults before mutating state", async () => {
    saveState(workspace, {
      config: {
        defaults: {
          model: "anthropic/claude-sonnet-4-5",
          agent: "build",
        },
      },
      jobs: [],
    });

    const result = await runNodeScript([
      companionScript,
      "setup",
      "--json",
      "--default-model",
      "claude-opus-4-6",
      "--default-agent",
      "plan",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /--default-model/);
    assert.deepEqual(loadState(workspace).config.defaults, {
      model: "anthropic/claude-sonnet-4-5",
      agent: "build",
    });
  });

  it("foreground worktree setup failure marks the created job failed", async () => {
    const result = await runNodeScript([
      companionScript,
      "task",
      "--write",
      "--worktree",
      "change something",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Failed to create worktree/);
    const state = loadState(workspace);
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].status, "failed");
    assert.equal(state.jobs[0].phase, "failed");
    assert.match(state.jobs[0].errorMessage, /Failed to create worktree/);
  });

  it("safe-command forwards setup multi-token args from stdin", async () => {
    const result = await runNodeScript(
      [safeCommandScript, "setup"],
      {
        input:
          "--enable-review-gate --review-gate-max 2 --review-gate-cooldown off " +
          "--default-model anthropic/claude-opus-4-6 --default-agent build\n",
      }
    );

    assert.equal(result.exitCode, 0);
    const status = JSON.parse(result.stdout);
    assert.equal(status.reviewGate, true);
    assert.equal(status.reviewGateMaxPerSession, 2);
    assert.equal(status.reviewGateCooldownMinutes, null);
    assert.deepEqual(status.defaults, {
      model: "anthropic/claude-opus-4-6",
      agent: "build",
    });
  });

  it("safe-command rejects shell-shaped job refs as data", async () => {
    const marker = path.join(tmpDir, "should-not-exist");
    const result = await runNodeScript(
      [safeCommandScript, "cancel"],
      { input: `$(touch ${marker})\n` }
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid job reference/);
    assert.equal(fs.existsSync(marker), false);
  });
});
