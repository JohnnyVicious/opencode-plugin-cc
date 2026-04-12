import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  markDeadPidJobFailed,
  reconcileIfDead,
  reconcileAllJobs,
  buildStatusSnapshot,
} from "../plugins/opencode/scripts/lib/job-control.mjs";
import { upsertJob, loadState, saveState } from "../plugins/opencode/scripts/lib/state.mjs";
import {
  getProcessStartToken,
  isProcessAlive,
} from "../plugins/opencode/scripts/lib/process.mjs";

// PID 999999 is virtually guaranteed to be dead on macOS/Linux (well above
// pid_max for typical configurations and any short-lived workload).
const DEAD_PID = 999_999;

describe("isProcessAlive", () => {
  it("returns false for null/undefined/invalid pids", () => {
    assert.equal(isProcessAlive(null), false);
    assert.equal(isProcessAlive(undefined), false);
    assert.equal(isProcessAlive(0), false);
    assert.equal(isProcessAlive(-1), false);
    assert.equal(isProcessAlive(NaN), false);
  });

  it("returns true for the current process", () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it("returns false when the PID start token does not match", () => {
    const token = getProcessStartToken(process.pid);
    if (!token) return;
    assert.equal(isProcessAlive(process.pid, `${token}-stale`), false);
  });

  it("returns false for a clearly dead pid", () => {
    assert.equal(isProcessAlive(DEAD_PID), false);
  });
});

describe("markDeadPidJobFailed", () => {
  let workspace;
  let previousPluginData;

  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-deadpid-"));
    previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(
      path.join(os.tmpdir(), "opencode-deadpid-data-")
    );
  });

  after(() => {
    if (previousPluginData == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  });

  beforeEach(() => {
    // Actually wipe on-disk state between tests. The prior mutator-only
    // approach left entries from earlier tests in state.json, which made
    // the suite order-dependent as soon as IDs collided or MAX_JOBS
    // pruning kicked in.
    saveState(workspace, { config: {}, jobs: [] });
  });

  it("rewrites a running job with a dead pid to failed", () => {
    upsertJob(workspace, {
      id: "task-1",
      status: "running",
      type: "task",
      pid: DEAD_PID,
    });
    const written = markDeadPidJobFailed(workspace, "task-1", DEAD_PID);
    assert.equal(written, true);

    const stored = loadState(workspace).jobs.find((j) => j.id === "task-1");
    assert.equal(stored.status, "failed");
    assert.equal(stored.phase, "failed");
    assert.equal(stored.pid, null);
    assert.match(stored.errorMessage, new RegExp(`PID ${DEAD_PID}`));
  });

  it("refuses to downgrade a terminal state", () => {
    upsertJob(workspace, {
      id: "task-2",
      status: "completed",
      type: "task",
      pid: DEAD_PID,
    });
    const written = markDeadPidJobFailed(workspace, "task-2", DEAD_PID);
    assert.equal(written, false);

    const stored = loadState(workspace).jobs.find((j) => j.id === "task-2");
    assert.equal(stored.status, "completed");
  });

  it("refuses when the pid has changed since probe", () => {
    upsertJob(workspace, {
      id: "task-3",
      status: "running",
      type: "task",
      pid: 12345,
    });
    // Probe observed DEAD_PID, but latest pid is 12345 → refuse.
    const written = markDeadPidJobFailed(workspace, "task-3", DEAD_PID);
    assert.equal(written, false);

    const stored = loadState(workspace).jobs.find((j) => j.id === "task-3");
    assert.equal(stored.status, "running");
  });

  it("refuses when the pid start token has changed since probe", () => {
    upsertJob(workspace, {
      id: "task-4",
      status: "running",
      type: "task",
      pid: 12345,
      pidStartToken: "start-a",
    });
    const written = markDeadPidJobFailed(workspace, "task-4", 12345, "start-b");
    assert.equal(written, false);

    const stored = loadState(workspace).jobs.find((j) => j.id === "task-4");
    assert.equal(stored.status, "running");
  });
});

describe("reconcileIfDead", () => {
  let workspace;
  let previousPluginData;

  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-reconcile-"));
    previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(
      path.join(os.tmpdir(), "opencode-reconcile-data-")
    );
  });

  after(() => {
    if (previousPluginData == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  });

  it("leaves a running job with a live pid alone", () => {
    upsertJob(workspace, {
      id: "live-1",
      status: "running",
      type: "task",
      pid: process.pid,
    });
    const result = reconcileIfDead(workspace, {
      id: "live-1",
      status: "running",
      pid: process.pid,
    });
    assert.equal(result.status, "running");
  });

  it("reconciles a running job with a dead pid to failed", () => {
    upsertJob(workspace, {
      id: "dead-1",
      status: "running",
      type: "task",
      pid: DEAD_PID,
    });
    const result = reconcileIfDead(workspace, {
      id: "dead-1",
      status: "running",
      pid: DEAD_PID,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.phase, "failed");
  });

  it("honors OPENCODE_COMPANION_NO_RECONCILE", () => {
    const previous = process.env.OPENCODE_COMPANION_NO_RECONCILE;
    process.env.OPENCODE_COMPANION_NO_RECONCILE = "1";
    try {
      upsertJob(workspace, {
        id: "dead-opt-out",
        status: "running",
        type: "task",
        pid: DEAD_PID,
      });
      const job = { id: "dead-opt-out", status: "running", pid: DEAD_PID };
      const result = reconcileIfDead(workspace, job);
      assert.equal(result, job);
    } finally {
      if (previous == null) delete process.env.OPENCODE_COMPANION_NO_RECONCILE;
      else process.env.OPENCODE_COMPANION_NO_RECONCILE = previous;
    }
  });

  it("leaves running jobs with no pid alone", () => {
    const job = { id: "nopid", status: "running", pid: null };
    const result = reconcileIfDead(workspace, job);
    assert.equal(result, job);
  });

  it("leaves terminal-state jobs alone", () => {
    const job = { id: "done", status: "completed", pid: DEAD_PID };
    const result = reconcileIfDead(workspace, job);
    assert.equal(result, job);
  });
});

describe("buildStatusSnapshot reconciles dead pids inline", () => {
  let workspace;
  let previousPluginData;

  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-snapshot-"));
    previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(
      path.join(os.tmpdir(), "opencode-snapshot-data-")
    );
  });

  after(() => {
    if (previousPluginData == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  });

  it("surfaces a dead-pid running job as failed in one read", () => {
    const now = new Date().toISOString();
    const jobs = [
      {
        id: "zombie",
        status: "running",
        type: "task",
        pid: DEAD_PID,
        createdAt: now,
        updatedAt: now,
      },
    ];
    upsertJob(workspace, jobs[0]);

    const snapshot = buildStatusSnapshot(jobs, workspace);
    assert.equal(snapshot.running.length, 0);
    assert.ok(snapshot.latestFinished);
    assert.equal(snapshot.latestFinished.id, "zombie");
    assert.equal(snapshot.latestFinished.status, "failed");
  });
});

describe("reconcileAllJobs", () => {
  it("returns input unchanged when empty", () => {
    assert.deepEqual(reconcileAllJobs([], "/tmp"), []);
    assert.equal(reconcileAllJobs(null, "/tmp"), null);
  });
});
