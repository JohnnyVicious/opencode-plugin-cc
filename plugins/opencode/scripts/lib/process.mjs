// Process utilities for the OpenCode companion.
//
// Modified by JohnnyVicious (2026): added `getConfiguredProviders` which
// reads OpenCode's `auth.json` directly so `/opencode:setup` can detect
// configured providers without depending on the HTTP server. The
// pre-existing `client.listProviders()` path hits a schema/docs endpoint
// that does not return the user's configured credentials, which made
// `/opencode:setup` always report `providers: []`. (Apache License 2.0
// §4(b) modification notice.)

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Shell option for child_process.spawn that is correct on every platform:
 *
 * - POSIX: `false` — pass argv directly to `execvp`.
 * - Windows: if `$SHELL` points at a POSIX shell (Git Bash, MSYS), use it so
 *   users who wrote their PATH for Git Bash don't get cmd.exe behavior.
 *   Otherwise `true` falls back to Node's default (cmd.exe), which is still
 *   needed so .cmd / .bat shims resolve.
 *
 * Without this, bare names like `opencode`, `git`, `gh`, `where` spawned on
 * Windows hit ENOENT because Node won't resolve .cmd shims on its own.
 * @returns {string|true|false}
 */
export function platformShellOption() {
  if (process.platform !== "win32") return false;
  return process.env.SHELL || true;
}

/**
 * Resolve the full path to the `opencode` binary.
 * @returns {Promise<string|null>}
 */
export async function resolveOpencodeBinary() {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const locator = isWin ? "where" : "which";
    const proc = spawn(locator, ["opencode"], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: platformShellOption(),
      windowsHide: true,
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", (code) => {
      if (code !== 0) return resolve(null);
      // `where` returns all matches separated by CRLF; pick the first.
      const first = out.trim().split(/\r?\n/)[0] ?? "";
      resolve(first || null);
    });
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
      shell: platformShellOption(),
      windowsHide: true,
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
      shell: platformShellOption(),
      windowsHide: true,
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
    shell: platformShellOption(),
    windowsHide: true,
  });
  child.unref();
  return child;
}

/**
 * Return a stable best-effort process start token for PID-recycling checks.
 * The token format is intentionally opaque and platform-prefixed.
 * @param {number | null | undefined} pid
 * @returns {string|null}
 */
export function getProcessStartToken(pid) {
  if (pid == null || !Number.isFinite(pid) || pid <= 0) return null;

  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const endOfComm = stat.lastIndexOf(")");
      if (endOfComm !== -1) {
        const fieldsFromState = stat.slice(endOfComm + 2).trim().split(/\s+/);
        const startTime = fieldsFromState[19];
        if (startTime) return `linux:${startTime}`;
      }
    } catch {
      return null;
    }
  }

  if (process.platform === "darwin" || process.platform === "freebsd") {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      shell: platformShellOption(),
      windowsHide: true,
    });
    const started = result.status === 0 ? result.stdout.trim() : "";
    return started ? `${process.platform}:${started}` : null;
  }

  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate`,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
      }
    );
    const started = result.status === 0 ? result.stdout.trim() : "";
    return started ? `win32:${started}` : null;
  }

  return null;
}

/**
 * Check whether a process is still alive. Uses signal 0 which does not
 * affect the process — only probes existence. When an expected start token
 * is supplied and the platform can read the current process start token, a
 * token mismatch is treated as dead to avoid PID-recycling false positives.
 * @param {number | null | undefined} pid
 * @param {string | null | undefined} expectedStartToken
 * @returns {boolean}
 */
export function isProcessAlive(pid, expectedStartToken = null) {
  if (pid == null || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    // ESRCH = dead. EPERM/EACCES = exists but no permission.
    if (err?.code !== "EPERM" && err?.code !== "EACCES") return false;
    return true;
  }

  if (expectedStartToken) {
    const actualStartToken = getProcessStartToken(pid);
    if (actualStartToken && actualStartToken !== expectedStartToken) return false;
  }
  return true;
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
