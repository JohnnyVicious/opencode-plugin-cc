// Tests for reapServerIfOurs — specifically the in-flight tracked-job
// guard that was added after a background review was killed mid-stream
// by a SessionEnd reap (issue: foreground/background SIGTERM race that
// surfaced as bare `terminated` from undici).
//
// These tests do not touch a real OpenCode server. Instead they:
//
//   1. Spawn a throwaway `sleep` child as the "server" PID so the
//      reaper has a live but kill-safe process to target.
//   2. Write server.json and state.json directly under
//      CLAUDE_PLUGIN_DATA to set up the tracked state.
//   3. Use a free high port so `isServerRunning` returns false on the
//      post-kill verification step.
//
// Tests the matrix:
//   - in-flight running job with a live companion PID → reap skipped,
//     sleeper still alive
//   - no running jobs → reap proceeds, sleeper got SIGTERM
//   - stale running job whose companion PID is dead → reap proceeds
//     (the stale entry must not block reaping forever)

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import { reapServerIfOurs } from "../plugins/opencode/scripts/lib/opencode-server.mjs";
import { saveState } from "../plugins/opencode/scripts/lib/state.mjs";

// PID 999999 is well above pid_max on typical Linux/macOS and is a
// reliably-dead sentinel.
const DEAD_PID = 999_999;

// Free high port nothing listens on. isServerRunning(TEST_HOST, this)
// should return false so the reaper's post-kill verification can
// conclude the port is empty.
const UNUSED_PORT = 24_099;
const TEST_HOST = "127.0.0.1";

function workspaceHash(workspacePath) {
  return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
}

function serverStatePathFor(pluginData, workspace) {
  return path.join(pluginData, "state", workspaceHash(workspace), "server.json");
}

function writeServerState(pluginData, workspace, state) {
  const p = serverStatePathFor(pluginData, workspace);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

function readServerState(pluginData, workspace) {
  const p = serverStatePathFor(pluginData, workspace);
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function spawnSleeper() {
  // 30s is long enough that the reaper's 1s post-kill poll will catch
  // a live process in the in-flight test, but if the kill fires the
  // sleeper should exit well within that window.
  const proc = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
  proc.unref();
  return proc;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isPidAlive(pid);
}

describe("reapServerIfOurs in-flight guard", () => {
  let workspace;
  let pluginData;
  let previousPluginData;
  let sleeper;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-reaper-ws-"));
    pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-reaper-data-"));
    previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = pluginData;
    sleeper = spawnSleeper();
  });

  afterEach(async () => {
    if (sleeper && sleeper.pid && isPidAlive(sleeper.pid)) {
      try { process.kill(sleeper.pid, "SIGKILL"); } catch {}
    }
    if (previousPluginData == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(pluginData, { recursive: true, force: true }); } catch {}
  });

  it("skips reap when a live tracked job is still running", async () => {
    // Server tracked, uptime well over the 5-min threshold.
    writeServerState(pluginData, workspace, {
      lastServerPid: sleeper.pid,
      lastServerStartedAt: Date.now() - 10 * 60 * 1000,
    });
    // In-flight job pointing at the current test process (which is
    // definitely alive) so the in-flight guard triggers.
    saveState(workspace, {
      config: {},
      jobs: [
        {
          id: "inflight-1",
          type: "task",
          status: "running",
          pid: process.pid,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    const reaped = await reapServerIfOurs(workspace, {
      host: TEST_HOST,
      port: UNUSED_PORT,
    });

    assert.equal(reaped, false, "reaper should skip when in-flight jobs exist");
    assert.equal(isPidAlive(sleeper.pid), true, "sleeper must still be alive");

    // Server state must not be cleared when reap is skipped.
    const after = readServerState(pluginData, workspace);
    assert.equal(after.lastServerPid, sleeper.pid);
  });

  it("proceeds when no running jobs reference the server", async () => {
    writeServerState(pluginData, workspace, {
      lastServerPid: sleeper.pid,
      lastServerStartedAt: Date.now() - 10 * 60 * 1000,
    });
    // No running jobs — only a completed one, which must not block.
    saveState(workspace, {
      config: {},
      jobs: [
        {
          id: "done-1",
          type: "task",
          status: "completed",
          pid: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    const reaped = await reapServerIfOurs(workspace, {
      host: TEST_HOST,
      port: UNUSED_PORT,
    });

    // We asked the reaper to SIGTERM the sleeper. Give it a moment to die.
    const died = await waitUntilDead(sleeper.pid);
    assert.equal(died, true, "sleeper must have been killed by the reaper");
    assert.equal(reaped, true, "reaper must report success when nothing was in-flight");

    // Server state must be cleared after a successful reap.
    const after = readServerState(pluginData, workspace);
    assert.equal(after.lastServerPid, null);
    assert.equal(after.lastServerStartedAt, null);
  });

  it("treats a stale `running` job with a dead PID as not-in-flight", async () => {
    writeServerState(pluginData, workspace, {
      lastServerPid: sleeper.pid,
      lastServerStartedAt: Date.now() - 10 * 60 * 1000,
    });
    // A previous companion crashed without marking its job failed.
    // The stale entry must not permanently block reaping.
    saveState(workspace, {
      config: {},
      jobs: [
        {
          id: "stale-1",
          type: "task",
          status: "running",
          pid: DEAD_PID,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    const reaped = await reapServerIfOurs(workspace, {
      host: TEST_HOST,
      port: UNUSED_PORT,
    });

    const died = await waitUntilDead(sleeper.pid);
    assert.equal(died, true, "sleeper must be killed — the stale job must not block");
    assert.equal(reaped, true);
  });

  it("does not reap when uptime is below the 5-minute threshold", async () => {
    writeServerState(pluginData, workspace, {
      lastServerPid: sleeper.pid,
      // Fresh server — uptime < 5 min.
      lastServerStartedAt: Date.now() - 30 * 1000,
    });
    saveState(workspace, { config: {}, jobs: [] });

    const reaped = await reapServerIfOurs(workspace, {
      host: TEST_HOST,
      port: UNUSED_PORT,
    });

    assert.equal(reaped, false);
    assert.equal(isPidAlive(sleeper.pid), true, "fresh server must not be killed");
  });
});
