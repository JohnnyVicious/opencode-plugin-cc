// Process utilities for the OpenCode companion.
//
// Modified by JohnnyVicious (2026): added `getConfiguredProviders` which
// reads OpenCode's `auth.json` directly so `/opencode:setup` can detect
// configured providers without depending on the HTTP server. The
// pre-existing `client.listProviders()` path hits a schema/docs endpoint
// that does not return the user's configured credentials, which made
// `/opencode:setup` always report `providers: []`. (Apache License 2.0
// §4(b) modification notice.)

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the full path to the `opencode` binary.
 * @returns {Promise<string|null>}
 */
export async function resolveOpencodeBinary() {
  return new Promise((resolve) => {
    const proc = spawn("which", ["opencode"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", (code) => resolve(code === 0 ? out.trim() : null));
  });
}

/**
 * Check if `opencode` CLI is available.
 * @returns {Promise<boolean>}
 */
export async function isOpencodeInstalled() {
  const bin = await resolveOpencodeBinary();
  return bin !== null;
}

/**
 * Get the installed opencode version.
 * @returns {Promise<string|null>}
 */
export async function getOpencodeVersion() {
  return new Promise((resolve) => {
    const proc = spawn("opencode", ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", (code) => resolve(code === 0 ? out.trim() : null));
  });
}

/**
 * Run a command and return { stdout, stderr, exitCode }.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
export function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
  });
}

/**
 * Spawn a detached background process.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnDetached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: "ignore",
    detached: true,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });
  child.unref();
  return child;
}

/**
 * Check whether a process is still alive. Uses signal 0 which does not
 * affect the process — only probes existence.
 * @param {number | null | undefined} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (pid == null || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = dead. EPERM = exists but no permission.
    return err?.code === "EPERM";
  }
}

// ------------------------------------------------------------------
// OpenCode auth.json discovery
// ------------------------------------------------------------------

/**
 * Locate OpenCode's auth.json by trying the OS-specific candidate paths
 * (XDG_DATA_HOME first, then platform defaults). Returns the first path
 * that exists, or null if none do.
 * @returns {string | null}
 */
export function findOpencodeAuthFile() {
  const home = os.homedir();
  const candidates = [];

  if (process.env.XDG_DATA_HOME) {
    candidates.push(path.join(process.env.XDG_DATA_HOME, "opencode", "auth.json"));
  }

  if (process.platform === "darwin") {
    candidates.push(path.join(home, "Library", "Application Support", "opencode", "auth.json"));
  }

  if (process.platform === "win32") {
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, "opencode", "auth.json"));
    }
    candidates.push(path.join(home, "AppData", "Roaming", "opencode", "auth.json"));
  }

  // Linux/BSD default + macOS-with-XDG fallback.
  candidates.push(path.join(home, ".local", "share", "opencode", "auth.json"));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore unreadable candidates
    }
  }
  return null;
}

/**
 * Read OpenCode's auth.json and return the list of configured provider IDs
 * (the top-level keys). Returns an empty array if the file is missing,
 * unreadable, or not a JSON object.
 *
 * This is the same source of truth that `opencode providers list` uses.
 * It does not require the OpenCode HTTP server to be running.
 * @returns {string[]}
 */
export function getConfiguredProviders() {
  const file = findOpencodeAuthFile();
  if (!file) return [];
  try {
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return Object.keys(data);
    }
  } catch {
    // ignore parse/read errors — treat as no providers
  }
  return [];
}
