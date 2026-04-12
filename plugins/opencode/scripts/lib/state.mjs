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

function workspaceHash(workspacePath) {
  return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
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

  try {
    fs.mkdirSync(primaryDir, { recursive: true });
    fs.cpSync(fallbackDir, primaryDir, { recursive: true });

    const escapedFallback = fallbackDir.replaceAll("\\", "\\\\");
    const escapedPrimary = primaryDir.replaceAll("\\", "\\\\");
    const rewritePaths = (filePath) => {
      try {
        let txt = fs.readFileSync(filePath, "utf8");
        const original = txt;
        txt = txt.replaceAll(fallbackDir, primaryDir);
        if (escapedFallback !== fallbackDir) {
          txt = txt.replaceAll(escapedFallback, escapedPrimary);
        }
        if (txt !== original) fs.writeFileSync(filePath, txt, "utf8");
      } catch {
        // non-fatal — migration is best-effort
      }
    };

    rewritePaths(primaryState);
    const jobsDir = path.join(primaryDir, "jobs");
    if (fs.existsSync(jobsDir)) {
      for (const entry of fs.readdirSync(jobsDir)) {
        if (entry.endsWith(".json")) {
          rewritePaths(path.join(jobsDir, entry));
        }
      }
    }
  } catch {
    // If migration fails for any reason, fall through and let the caller
    // operate on whatever state is visible. A failed migration must never
    // crash a status/cancel call.
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
