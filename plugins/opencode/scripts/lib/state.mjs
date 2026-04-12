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
const FALLBACK_LOCK_STALE_MS = 30_000;
const MIGRATION_LOCK_STALE_MS = 5 * 60 * 1000;
const MIGRATION_WAIT_MS = 2000;
const PATH_KEYS = new Set(["logFile", "dataFile"]);
const STATE_LOCK_STALE_MS = 30_000;
const STATE_LOCK_WAIT_MS = 5_000;
const STATE_LOCK_RETRY_MS = 50;

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

function acquireFallbackLock(fallbackDir) {
  const lockPath = `${fallbackDir}.migration.lock`;
  ensureDir(path.dirname(lockPath));
  const deadline = Date.now() + FALLBACK_LOCK_STALE_MS;
  while (true) {
    try {
      return { fd: fs.openSync(lockPath, "wx"), lockPath };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > FALLBACK_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (statErr) {
        if (statErr?.code !== "ENOENT") throw statErr;
      }
      if (Date.now() >= deadline) return null;
      sleepSync(STATE_LOCK_RETRY_MS);
    }
  }
}

function releaseFallbackLock(lock) {
  if (!lock) return;
  if (lock.fd != null) {
    try { fs.closeSync(lock.fd); } catch {}
  }
  try { fs.rmSync(lock.lockPath, { force: true }); } catch {}
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
  let fallbackLock = null;
  try {
    lockFd = acquireMigrationLock(lockPath, primaryState);
    if (lockFd === null) return;
    if (fs.existsSync(primaryState) || !fs.existsSync(fallbackState)) return;

    fallbackLock = acquireFallbackLock(fallbackDir);
    if (fallbackLock === null) return;

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
    releaseFallbackLock(fallbackLock);
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
 * Acquire an exclusive lock on the state file for a given root directory.
 * Uses a sibling `.lock` file created with O_EXCL. Stale locks older than
 * STATE_LOCK_STALE_MS are forcibly removed. Blocks up to STATE_LOCK_WAIT_MS
 * with STATE_LOCK_RETRY_MS intervals.
 *
 * @param {string} root - the stateRoot directory
 * @returns {{ fd: number, lockPath: string }}
 */
function acquireStateLock(root) {
  const lockPath = stateFile(root) + ".lock";
  ensureDir(path.dirname(lockPath));

  const deadline = Date.now() + STATE_LOCK_WAIT_MS;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      } catch {}
      return { fd, lockPath };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;

      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STATE_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (statErr) {
        if (statErr?.code !== "ENOENT") throw statErr;
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for state lock after ${Math.round(STATE_LOCK_WAIT_MS / 1000)}s: ${lockPath}. ` +
          "If no other companion process is running, delete the lock file manually."
        );
      }

      sleepSync(STATE_LOCK_RETRY_MS);
    }
  }
}

/**
 * Release a state lock previously acquired by acquireStateLock.
 * @param {{ fd: number | null, lockPath: string } | null} lock
 */
function releaseStateLock(lock) {
  if (!lock) return;
  if (lock.fd != null) {
    try { fs.closeSync(lock.fd); } catch {}
  }
  try {
    fs.rmSync(lock.lockPath, { force: true });
    const dirPath = path.dirname(lock.lockPath);
    let dirFd = null;
    try {
      dirFd = fs.openSync(dirPath, "r");
      fs.fsyncSync(dirFd);
    } catch {
      // fsync best-effort
    } finally {
      if (dirFd !== null) {
        try { fs.closeSync(dirFd); } catch {}
      }
    }
  } catch {}
}

/**
 * Load state from an already-resolved root directory (no migration check).
 * @param {string} root
 * @returns {{ config: object, jobs: object[] }}
 */
function loadStateFromRoot(root) {
  const data = readJson(stateFile(root));
  return data ?? { config: {}, jobs: [] };
}

/**
 * Save state to an already-resolved root directory (no migration check).
 * @param {string} root
 * @param {object} state
 */
function saveStateToRoot(root, state) {
  writeJson(stateFile(root), state);
}

/**
 * Load the state for a workspace.
 * @param {string} workspacePath
 * @returns {{ config: object, jobs: object[] }}
 */
export function loadState(workspacePath) {
  return loadStateFromRoot(stateRoot(workspacePath));
}

/**
 * Save the state for a workspace.
 * @param {string} workspacePath
 * @param {object} state
 */
export function saveState(workspacePath, state) {
  saveStateToRoot(stateRoot(workspacePath), state);
}

/**
 * Update the state atomically using a mutator function. Acquires an
 * exclusive file lock for the read-modify-write cycle so concurrent
 * companion processes cannot lose each other's writes.
 * @param {string} workspacePath
 * @param {(state: object) => void} mutator
 * @returns {object} the updated state
 */
export function updateState(workspacePath, mutator) {
  const root = stateRoot(workspacePath);
  const lock = acquireStateLock(root);
  try {
    const state = loadStateFromRoot(root);
    mutator(state);
    saveStateToRoot(root, state);
    return state;
  } finally {
    releaseStateLock(lock);
  }
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
