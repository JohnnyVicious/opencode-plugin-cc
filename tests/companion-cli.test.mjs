import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTmpDir, cleanupTmpDir, setupTestEnv } from "./helpers.mjs";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";
import { saveState } from "../plugins/opencode/scripts/lib/state.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companionScript = path.join(repoRoot, "plugins", "opencode", "scripts", "opencode-companion.mjs");

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
});
