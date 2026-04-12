import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import {
  stateRoot,
  loadState,
  upsertJob,
} from "../plugins/opencode/scripts/lib/state.mjs";

let previousPluginData;

beforeEach(() => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
});

afterEach(() => {
  if (previousPluginData == null) {
    delete process.env.CLAUDE_PLUGIN_DATA;
  } else {
    process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  }
});

describe("stateRoot fallback", () => {
  it("uses os.tmpdir when CLAUDE_PLUGIN_DATA is unset", () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    const root = stateRoot("/some/workspace");
    assert.ok(root.startsWith(os.tmpdir()), `${root} does not start with ${os.tmpdir()}`);
    assert.match(root, /opencode-companion/);
  });

  it("uses CLAUDE_PLUGIN_DATA when set", () => {
    const dataDir = createTmpDir("opencode-data-");
    try {
      process.env.CLAUDE_PLUGIN_DATA = dataDir;
      const root = stateRoot("/some/workspace");
      assert.ok(root.startsWith(dataDir), `${root} does not start with ${dataDir}`);
    } finally {
      cleanupTmpDir(dataDir);
    }
  });
});

describe("stateRoot tmpdir → plugin-data migration", () => {
  let workspace;
  let dataDir;

  beforeEach(() => {
    workspace = "/migrate/test/workspace-" + Math.random().toString(16).slice(2);
    dataDir = createTmpDir("opencode-migrate-data-");
  });

  afterEach(() => {
    cleanupTmpDir(dataDir);
  });

  it("migrates existing tmpdir state to plugin-data dir", () => {
    // First, seed state in the tmpdir fallback (no CLAUDE_PLUGIN_DATA).
    delete process.env.CLAUDE_PLUGIN_DATA;
    upsertJob(workspace, { id: "pre-migration", status: "completed" });
    const fallbackDir = stateRoot(workspace);
    assert.ok(fallbackDir.startsWith(os.tmpdir()));
    const fallbackStateFile = path.join(fallbackDir, "state.json");
    assert.ok(fs.existsSync(fallbackStateFile));

    // Now set CLAUDE_PLUGIN_DATA and call stateRoot again — should migrate.
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    const primaryDir = stateRoot(workspace);
    assert.ok(primaryDir.startsWith(dataDir));
    const primaryStateFile = path.join(primaryDir, "state.json");
    assert.ok(fs.existsSync(primaryStateFile), "state.json did not migrate to primary dir");

    const migrated = loadState(workspace);
    const job = migrated.jobs.find((j) => j.id === "pre-migration");
    assert.ok(job, "migrated state does not contain seeded job");
    assert.equal(job.status, "completed");
  });

  it("rewrites absolute fallback paths in migrated JSON", () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    upsertJob(workspace, { id: "j1", status: "running" });
    const fallbackDir = stateRoot(workspace);

    // Write a job/*.json file containing an absolute reference to fallbackDir.
    const jobsDir = path.join(fallbackDir, "jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    const jobFile = path.join(jobsDir, "j1.json");
    fs.writeFileSync(
      jobFile,
      JSON.stringify({
        id: "j1",
        logFile: path.join(fallbackDir, "jobs", "j1.log"),
        errorMessage: `do not rewrite ordinary text mentioning ${fallbackDir}`,
      }),
      "utf8"
    );

    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    const primaryDir = stateRoot(workspace);
    const migratedJob = JSON.parse(
      fs.readFileSync(path.join(primaryDir, "jobs", "j1.json"), "utf8")
    );
    assert.ok(
      migratedJob.logFile.startsWith(primaryDir),
      `logFile not rewritten: ${migratedJob.logFile}`
    );
    assert.ok(!migratedJob.logFile.startsWith(fallbackDir));
    assert.equal(
      migratedJob.errorMessage,
      `do not rewrite ordinary text mentioning ${fallbackDir}`
    );
  });

  it("migrates with private directory and file modes on POSIX", () => {
    if (process.platform === "win32") return;

    delete process.env.CLAUDE_PLUGIN_DATA;
    upsertJob(workspace, { id: "mode-check", status: "completed" });

    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    const primaryDir = stateRoot(workspace);
    const primaryState = path.join(primaryDir, "state.json");

    assert.equal(fs.statSync(primaryDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(primaryState).mode & 0o777, 0o600);
  });

  it("refuses to migrate fallback state containing symlinks", () => {
    if (process.platform === "win32") return;

    delete process.env.CLAUDE_PLUGIN_DATA;
    upsertJob(workspace, { id: "symlink-check", status: "completed" });
    const fallbackDir = stateRoot(workspace);
    fs.symlinkSync("/etc/passwd", path.join(fallbackDir, "leak"));

    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    const primaryDir = stateRoot(workspace);
    assert.equal(fs.existsSync(path.join(primaryDir, "state.json")), false);
  });

  it("does not re-migrate when primary state already exists", () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    upsertJob(workspace, { id: "fallback-only", status: "completed" });

    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    // First call migrates.
    stateRoot(workspace);
    const primaryDir = stateRoot(workspace);
    upsertJob(workspace, { id: "primary-update", status: "running" });

    // Now wipe the fallback so a re-migration would be observable.
    // The existing primary state.json still has both seeded jobs.
    const state = loadState(workspace);
    assert.ok(state.jobs.find((j) => j.id === "fallback-only"));
    assert.ok(state.jobs.find((j) => j.id === "primary-update"));
    assert.ok(fs.existsSync(path.join(primaryDir, "state.json")));
  });
});
