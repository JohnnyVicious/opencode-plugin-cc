// File-system-based persistent state for the OpenCode companion.
// Mirrors the codex-plugin-cc state.mjs pattern: SHA-256 hash of workspace path,
// JSON state file, per-job files and logs.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDir, readJson, writeJson } from "./fs.mjs";

const MAX_JOBS = 50;

const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "opencode-companion");
const MIGRATION_LOCK_STALE_MS = 5 * 60 * 1000;
const MIGRATION_WAIT_MS = 2000;
const PATH_KEYS = new Set(["logFile", "dataFile"]);

function workspaceHash(workspacePath) {
  return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForMigration(primaryState) {
  const deadline = Date.now() + MIGRATION_WAIT_MS;
  while (!fs.existsSync(primaryState) && Date.now() < deadline) {
    sleepSync(25);
  }
}

function acquireMigrationLock(lockPath, primaryState) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    return fs.openSync(lockPath, "wx");
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;

    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > MIGRATION_LOCK_STALE_MS) {
        fs.rmSync(lockPath, { force: true });
        return fs.openSync(lockPath, "wx");
      }
    } catch (statErr) {
      if (statErr?.code !== "ENOENT") throw statErr;
    }

    waitForMigration(primaryState);
    return null;
  }
}

function assertSafeMigrationTree(dir) {
  for (const entry of fs.readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to migrate state containing symlink: ${entryPath}`);
    }
    if (stat.isDirectory()) {
      assertSafeMigrationTree(entryPath);
    } else if (!stat.isFile()) {
      throw new Error(`Refusing to migrate non-regular state file: ${entryPath}`);
    }
  }
}

function chmodPrivateRecursive(dir) {
  fs.chmodSync(dir, 0o700);
  for (const entry of fs.readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    const stat = fs.lstatSync(entryPath);
    if (stat.isDirectory()) {
      chmodPrivateRecursive(entryPath);
    } else if (stat.isFile()) {
      fs.chmodSync(entryPath, 0o600);
    }
  }
}

function rewritePathPrefix(value, fallbackDir, primaryDir) {
  if (typeof value !== "string") return value;
  if (value === fallbackDir) return primaryDir;
  const boundary = fallbackDir.endsWith(path.sep) ? fallbackDir : `${fallbackDir}${path.sep}`;
  if (value.startsWith(boundary)) {
    return path.join(primaryDir, value.slice(boundary.length));
  }
  return value;
}

function rewriteKnownPathValues(value, fallbackDir, primaryDir, key = null) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteKnownPathValues(item, fallbackDir, primaryDir));
  }
  if (value && typeof value === "object") {
    const rewritten = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      rewritten[childKey] = rewriteKnownPathValues(childValue, fallbackDir, primaryDir, childKey);
    }
    return rewritten;
  }
  return PATH_KEYS.has(key) ? rewritePathPrefix(value, fallbackDir, primaryDir) : value;
}

function rewriteJsonPathFile(filePath, fallbackDir, primaryDir) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const rewritten = rewriteKnownPathValues(data, fallbackDir, primaryDir);
    fs.writeFileSync(filePath, `${JSON.stringify(rewritten, null, 2)}\n`, "utf8");
  } catch {
    // non-fatal — malformed job data should not prevent state migration
  }
}

function rewriteMigratedJsonPaths(rootDir, fallbackDir, primaryDir) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        rewriteJsonPathFile(entryPath, fallbackDir, primaryDir);
      }
    }
  }
}

/**
 * One-time migration: if state for this workspace exists only in the tmpdir
 * fallback (written by a command that ran without CLAUDE_PLUGIN_DATA), copy
 * it into the persistent plugin-data dir so future reads/writes go there and
 * state survives /tmp cleanup.
 *
 * Absolute paths embedded in the migrated JSON (logFile references, job data
 * paths) are rewritten to point at the new location.
 */
function migrateTmpdirStateIfNeeded(fallbackDir, primaryDir) {
  const primaryState = path.join(primaryDir, "state.json");
  const fallbackState = path.join(fallbackDir, "state.json");
  if (fs.existsSync(primaryState) || !fs.existsSync(fallbackState)) return;

  const lockPath = `${primaryDir}.migrate.lock`;
  const stageDir = `${primaryDir}.migrate-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  let lockFd = null;
  try {
    lockFd = acquireMigrationLock(lockPath, primaryState);
    if (lockFd === null) return;
    if (fs.existsSync(primaryState) || !fs.existsSync(fallbackState)) return;

    assertSafeMigrationTree(fallbackDir);
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.cpSync(fallbackDir, stageDir, {
      recursive: true,
      verbatimSymlinks: true,
    });
    rewriteMigratedJsonPaths(stageDir, fallbackDir, primaryDir);
    chmodPrivateRecursive(stageDir);

    if (fs.existsSync(primaryDir) && !fs.existsSync(primaryState)) {
      fs.rmSync(primaryDir, { recursive: true, force: true });
    }
    fs.renameSync(stageDir, primaryDir);
  } catch {
    // If migration fails for any reason, fall through and let the caller
    // operate on whatever state is visible. A failed migration must never
    // crash a status/cancel call.
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {
        // best-effort
      }
      fs.rmSync(lockPath, { force: true });
    }
  }
}

/**
 * Compute the state directory root for a workspace.
 * @param {string} workspacePath
 * @returns {string}
 */
export function stateRoot(workspacePath) {
  const hash = workspaceHash(workspacePath);
  const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  if (pluginDataDir) {
    const primaryDir = path.join(pluginDataDir, "state", hash);
    const fallbackDir = path.join(FALLBACK_STATE_ROOT_DIR, hash);
    migrateTmpdirStateIfNeeded(fallbackDir, primaryDir);
    return primaryDir;
  }

  return path.join(FALLBACK_STATE_ROOT_DIR, hash);
}

/**
 * Path to the main state.json file.
 * @param {string} root
 * @returns {string}
 */
function stateFile(root) {
  return path.join(root, "state.json");
}

/**
 * Load the state for a workspace.
 * @param {string} workspacePath
 * @returns {{ config: object, jobs: object[] }}
 */
export function loadState(workspacePath) {
  const root = stateRoot(workspacePath);
  const data = readJson(stateFile(root));
  return data ?? { config: {}, jobs: [] };
}

/**
 * Save the state for a workspace.
 * @param {string} workspacePath
 * @param {object} state
 */
export function saveState(workspacePath, state) {
  const root = stateRoot(workspacePath);
  writeJson(stateFile(root), state);
}

/**
 * Update the state atomically using a mutator function.
 * @param {string} workspacePath
 * @param {(state: object) => void} mutator
 * @returns {object} the updated state
 */
export function updateState(workspacePath, mutator) {
  const state = loadState(workspacePath);
  mutator(state);
  saveState(workspacePath, state);
  return state;
}

/**
 * Generate a unique job ID.
 * @param {string} prefix - e.g. "review", "task"
 * @returns {string}
 */
export function generateJobId(prefix) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

/**
 * Insert or update a job in the state.
 * @param {string} workspacePath
 * @param {object} job
 */
export function upsertJob(workspacePath, job) {
  updateState(workspacePath, (state) => {
    if (!state.jobs) state.jobs = [];
    const idx = state.jobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) {
      state.jobs[idx] = { ...state.jobs[idx], ...job, updatedAt: new Date().toISOString() };
    } else {
      state.jobs.push({ ...job, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    // Prune old jobs beyond MAX_JOBS
    if (state.jobs.length > MAX_JOBS) {
      state.jobs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      state.jobs = state.jobs.slice(0, MAX_JOBS);
    }
  });
}

/**
 * Get the path for a job's log file.
 * @param {string} workspacePath
 * @param {string} jobId
 * @returns {string}
 */
export function jobLogPath(workspacePath, jobId) {
  return path.join(stateRoot(workspacePath), "jobs", `${jobId}.log`);
}

/**
 * Get the path for a job's data file.
 * @param {string} workspacePath
 * @param {string} jobId
 * @returns {string}
 */
export function jobDataPath(workspacePath, jobId) {
  return path.join(stateRoot(workspacePath), "jobs", `${jobId}.json`);
}
