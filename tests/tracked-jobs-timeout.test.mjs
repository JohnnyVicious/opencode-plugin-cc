import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTrackedJob } from "../plugins/opencode/scripts/lib/tracked-jobs.mjs";
import { loadState } from "../plugins/opencode/scripts/lib/state.mjs";

describe("runTrackedJob timeout", () => {
  let workspace;
  let previousPluginData;

  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-timeout-"));
    previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(
      path.join(os.tmpdir(), "opencode-timeout-data-")
    );
  });

  after(() => {
    if (previousPluginData == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  });

  it("aborts a runner that never resolves and marks the job failed", async () => {
    const job = { id: "timeout-never-1" };

    await assert.rejects(
      runTrackedJob(
        workspace,
        job,
        () => new Promise(() => {}),
        { timeoutMs: 50 }
      ),
      /hard timeout/i
    );

    const state = loadState(workspace);
    const stored = state.jobs.find((j) => j.id === job.id);
    assert.ok(stored);
    assert.equal(stored.status, "failed");
    assert.equal(stored.phase, "failed");
    assert.match(stored.errorMessage, /hard timeout/i);
  });

  it("does not fire for runners that resolve quickly", async () => {
    const job = { id: "timeout-quick-1" };

    const result = await runTrackedJob(
      workspace,
      job,
      async () => ({ rendered: "ok" }),
      { timeoutMs: 60_000 }
    );

    assert.equal(result.rendered, "ok");
    const state = loadState(workspace);
    const stored = state.jobs.find((j) => j.id === job.id);
    assert.equal(stored.status, "completed");
  });

  it("honors OPENCODE_COMPANION_JOB_TIMEOUT_MS env override", async () => {
    const previous = process.env.OPENCODE_COMPANION_JOB_TIMEOUT_MS;
    process.env.OPENCODE_COMPANION_JOB_TIMEOUT_MS = "40";
    try {
      const job = { id: "timeout-env-1" };
      await assert.rejects(
        runTrackedJob(workspace, job, () => new Promise(() => {})),
        /hard timeout/i
      );
    } finally {
      if (previous == null) delete process.env.OPENCODE_COMPANION_JOB_TIMEOUT_MS;
      else process.env.OPENCODE_COMPANION_JOB_TIMEOUT_MS = previous;
    }
  });
});
