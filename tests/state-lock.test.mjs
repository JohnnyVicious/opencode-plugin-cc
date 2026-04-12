import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTmpDir, cleanupTmpDir, setupTestEnv } from "./helpers.mjs";
import {
  loadState,
  updateState,
  upsertJob,
  stateRoot,
} from "../plugins/opencode/scripts/lib/state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateModulePath = path.resolve(__dirname, "..", "plugins", "opencode", "scripts", "lib", "state.mjs");

let tmpDir;
const workspace = "/lock-test/workspace";

beforeEach(() => {
  tmpDir = createTmpDir("state-lock-");
  setupTestEnv(tmpDir);
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

describe("updateState lock", () => {
  it("creates and removes a lock file during updateState", () => {
    updateState(workspace, (state) => {
      const root = stateRoot(workspace);
      const lockPath = path.join(root, "state.json.lock");
      assert.ok(
        fs.existsSync(lockPath),
        "lock file should exist while mutator is running"
      );
      state.config.test = true;
    });

    const root = stateRoot(workspace);
    const lockPath = path.join(root, "state.json.lock");
    assert.ok(
      !fs.existsSync(lockPath),
      "lock file should be removed after updateState completes"
    );
  });

  it("removes lock file even when mutator throws", () => {
    try {
      updateState(workspace, () => {
        throw new Error("mutator explosion");
      });
    } catch {}

    const root = stateRoot(workspace);
    const lockPath = path.join(root, "state.json.lock");
    assert.ok(
      !fs.existsSync(lockPath),
      "lock file should be cleaned up after mutator error"
    );
  });

  it("cleans up stale lock files older than 30 seconds", () => {
    const root = stateRoot(workspace);
    const lockPath = path.join(root, "state.json.lock");
    fs.mkdirSync(root, { recursive: true });

    fs.writeFileSync(lockPath, "stale\n");
    const staleTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    updateState(workspace, (state) => {
      state.config.staleRecovery = true;
    });

    const loaded = loadState(workspace);
    assert.equal(loaded.config.staleRecovery, true);
    assert.ok(!fs.existsSync(lockPath), "stale lock should have been removed");
  });

  it("concurrent processes do not lose each other's writes", async () => {
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "concurrent-test-"));
    const script = path.join(scriptDir, "writer.mjs");

    const dataDir = tmpDir;

    fs.writeFileSync(
      script,
      `import { upsertJob } from "${stateModulePath}";\n` +
      `import fs from "node:fs";\n` +
      `process.env.CLAUDE_PLUGIN_DATA = "${dataDir}";\n` +
      `process.env.OPENCODE_COMPANION_SESSION_ID = "child-session";\n` +
      `const workspace = "${workspace}";\n` +
      `const marker = "${script}.ready";\n` +
      `const goSignal = "${script}.go";\n` +
      `const doneSignal = "${script}.done";\n` +
      `fs.writeFileSync(marker, "ready");\n` +
      `while (!fs.existsSync(goSignal)) await new Promise(r => setTimeout(r, 20));\n` +
      `upsertJob(workspace, { id: "child-job", status: "running", type: "task" });\n` +
      `fs.writeFileSync(doneSignal, "done");\n`
    );

    try {
      const child = fork(script, [], { stdio: "pipe" });

      const readyMarker = `${script}.ready`;
      const goMarker = `${script}.go`;
      const doneMarker = `${script}.done`;

      const readyDeadline = Date.now() + 10_000;
      while (!fs.existsSync(readyMarker) && Date.now() < readyDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(fs.existsSync(readyMarker), "child did not signal ready in time");

      fs.writeFileSync(goMarker, "go");

      const doneDeadline = Date.now() + 10_000;
      while (!fs.existsSync(doneMarker) && Date.now() < doneDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(fs.existsSync(doneMarker), "child did not finish in time");

      await new Promise((resolve) => {
        child.on("exit", resolve);
        setTimeout(() => { child.kill(); resolve(); }, 5_000);
      });

      upsertJob(workspace, { id: "parent-job", status: "completed", type: "review" });

      const state = loadState(workspace);
      const childJob = state.jobs.find((j) => j.id === "child-job");
      const parentJob = state.jobs.find((j) => j.id === "parent-job");

      assert.ok(childJob, "child job was lost — concurrent write race");
      assert.ok(parentJob, "parent job was lost — concurrent write race");
      assert.equal(childJob.status, "running");
      assert.equal(parentJob.status, "completed");
    } finally {
      try { fs.rmSync(scriptDir, { recursive: true, force: true }); } catch {}
      for (const ext of [".ready", ".go", ".done"]) {
        try { fs.rmSync(`${script}${ext}`, { force: true }); } catch {}
      }
    }
  });
});
