// OpenCode HTTP API client.
// Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout,
// OpenCode exposes a REST API + SSE. This module wraps that API.
//
// Modified by JohnnyVicious (2026):
//   - `ensureServer` spawns opencode with `stdio: "ignore"` instead of
//     piping stdout/stderr that nothing reads. The piped streams were
//     ref'd handles on the parent event loop, which deadlocked any
//     long-lived parent (e.g. `node:test`) once opencode wrote enough
//     log output to fill the pipe buffer. In normal CLI usage the
//     deadlock was masked because the companion script exited before
//     the buffer filled.
//   - `ensureServer` also threads `OPENCODE_CONFIG_DIR` into the spawned
//     server so our bundled `opencode-config/agent/review.md` custom
//     agent is discovered. We prefer a dedicated read-only agent over
//     OpenCode's built-in `plan` agent for reviews: `plan` injects a
//     synthetic user-message directive ("Plan mode ACTIVE... produce an
//     implementation plan") that overrides our review prompt and causes
//     OpenCode to return plans instead of reviews.
// (Apache License 2.0 §4(b) modification notice — see NOTICE.)

import crypto from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { platformShellOption, isProcessAlive as isProcessAliveWithToken } from "./process.mjs";
import { loadState } from "./state.mjs";

const DEFAULT_PORT = 4096;
const DEFAULT_HOST = "127.0.0.1";
const SERVER_START_TIMEOUT = 30_000;
const SERVER_REAP_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

function serverStatePath(workspacePath) {
  const key = typeof workspacePath === "string" && workspacePath.length > 0 ? workspacePath : process.cwd();
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "opencode-companion");
  return path.join(pluginDataDir, "state", hash, "server.json");
}

function loadServerState(workspacePath) {
  try {
    const p = serverStatePath(workspacePath);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  } catch {
    return {};
  }
}

function saveServerState(workspacePath, data) {
  try {
    const p = serverStatePath(workspacePath);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the bundled opencode config directory shipped inside the plugin.
 * This is what we pass as OPENCODE_CONFIG_DIR so the custom `review` agent
 * (at `opencode-config/agent/review.md`) gets discovered.
 * @returns {string|null}
 */
export function getBundledConfigDir() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) return null;
  const configDir = path.join(pluginRoot, "opencode-config");
  try {
    if (fs.existsSync(configDir)) return configDir;
  } catch {}
  return null;
}

/**
 * Check if an OpenCode server is already running on the given port.
 * @param {string} host
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function isServerRunning(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://${host}:${port}/global/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start the OpenCode server if not already running.
 * @param {object} opts
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 * @param {string} [opts.cwd]
 * @returns {Promise<{ url: string, pid?: number, alreadyRunning: boolean }>}
 */
export async function ensureServer(opts = {}) {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const url = `http://${host}:${port}`;

  if (await isServerRunning(host, port)) {
    // A server is already on the port. Only clear tracked state if the
    // tracked pid is dead (stale from a prior run) — otherwise it may be
    // a plugin-owned server from a previous session that reapServerIfOurs
    // should still be able to identify on SessionEnd.
    const state = loadServerState(opts.cwd);
    if (state.lastServerPid && !isProcessAlive(state.lastServerPid)) {
      delete state.lastServerPid;
      delete state.lastServerStartedAt;
      saveServerState(opts.cwd, state);
    }
    return { url, alreadyRunning: true };
  }

  // Start the server.
  // `stdio: "ignore"` is critical: piping stdout/stderr without draining
  // them creates ref'd file descriptors on the parent that prevent any
  // long-lived parent (notably `node:test`) from exiting cleanly once
  // opencode writes enough output to fill the pipe buffer.
  //
  // `OPENCODE_CONFIG_DIR` points opencode at our bundled config dir so
  // the custom `review` agent is discovered. We only set it when we
  // actually spawn the server — if the user already has a server
  // running, they get whatever config that server was started with, and
  // the caller is expected to fall back to `build` when `review` is
  // unavailable.
  const env = { ...process.env };
  const bundledConfigDir = getBundledConfigDir();
  if (bundledConfigDir) {
    env.OPENCODE_CONFIG_DIR = bundledConfigDir;
  }

  const proc = spawn("opencode", ["serve", "--port", String(port)], {
    stdio: "ignore",
    detached: true,
    cwd: opts.cwd,
    env,
    shell: platformShellOption(),
    windowsHide: true,
  });
  let spawnError = null;
  let earlyExit = null;
  proc.once("error", (err) => {
    spawnError = err;
  });
  proc.once("exit", (code, signal) => {
    earlyExit = { code, signal };
  });
  proc.unref();

  // Wait for the server to become ready. Poll every 250ms rather than
  // spinning hot — a tight loop would hammer fetch() and burn CPU for up
  // to SERVER_START_TIMEOUT.
  const deadline = Date.now() + SERVER_START_TIMEOUT;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(`Failed to start OpenCode server: ${spawnError.message}`);
    }
    if (earlyExit) {
      const detail = earlyExit.signal
        ? `signal ${earlyExit.signal}`
        : `exit code ${earlyExit.code ?? "unknown"}`;
      throw new Error(`OpenCode server process exited before becoming ready (${detail}).`);
    }
    if (await isServerRunning(host, port)) {
      const state = loadServerState(opts.cwd);
      state.lastServerPid = proc.pid;
      state.lastServerStartedAt = Date.now();
      saveServerState(opts.cwd, state);
      return { url, alreadyRunning: false, pid: proc.pid };
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  throw new Error(`OpenCode server failed to start within ${SERVER_START_TIMEOUT / 1000}s`);
}

/**
 * Create an API client bound to a running OpenCode server.
 * @param {string} baseUrl
 * @param {object} [opts]
 * @param {string} [opts.directory] - workspace directory for x-opencode-directory header
 * @returns {OpenCodeClient}
 */
export function createClient(baseUrl, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
  };
  if (opts.directory) {
    headers["x-opencode-directory"] = opts.directory;
  }
  if (process.env.OPENCODE_SERVER_PASSWORD) {
    const user = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    const cred = Buffer.from(`${user}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64");
    headers["Authorization"] = `Basic ${cred}`;
  }

  async function request(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenCode API ${method} ${path} returned ${res.status}: ${text}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return res.json();
    }
    return res.text();
  }

  return {
    baseUrl,

    // Health
    health: () => request("GET", "/global/health"),

    // Sessions
    listSessions: () => request("GET", "/session"),
    createSession: (opts = {}) => request("POST", "/session", opts),
    getSession: (id) => request("GET", `/session/${id}`),
    deleteSession: (id) => request("DELETE", `/session/${id}`),
    abortSession: (id) => request("POST", `/session/${id}/abort`),
    getSessionStatus: () => request("GET", "/session/status"),
    getSessionDiff: (id) => request("GET", `/session/${id}/diff`),

    // Messages
    getMessages: (sessionId, opts = {}) => {
      const params = new URLSearchParams();
      if (opts.limit) params.set("limit", String(opts.limit));
      if (opts.before) params.set("before", opts.before);
      const qs = params.toString();
      return request("GET", `/session/${sessionId}/message${qs ? "?" + qs : ""}`);
    },

    /**
     * Send a prompt (synchronous / streaming).
     * Returns the full response text from SSE stream.
     */
    sendPrompt: async (sessionId, promptText, opts = {}) => {
      const body = {
        parts: [{ type: "text", text: promptText }],
      };
      if (opts.agent) body.agent = opts.agent;
      if (opts.model) body.model = opts.model;
      if (opts.system) body.system = opts.system;
      // `tools` is a per-call override map: `{ write: false, edit: false, ... }`.
      // Used by the review fallback path to enforce read-only behavior when
      // the custom `review` agent isn't available on a pre-running server.
      if (opts.tools) body.tools = opts.tools;

      const res = await fetch(`${baseUrl}/session/${sessionId}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000), // 10 min for long tasks
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`OpenCode prompt failed ${res.status}: ${text}`);
      }

      return res.json();
    },

    /**
     * Send a prompt asynchronously (returns immediately).
     */
    sendPromptAsync: (sessionId, promptText, opts = {}) => {
      const body = {
        parts: [{ type: "text", text: promptText }],
      };
      if (opts.agent) body.agent = opts.agent;
      if (opts.model) body.model = opts.model;
      return request("POST", `/session/${sessionId}/prompt_async`, body);
    },

    // Agents
    listAgents: () => request("GET", "/agent"),

    // Providers
    listProviders: () => request("GET", "/provider"),
    getProviderAuth: () => request("GET", "/provider/auth"),

    // Config
    getConfig: () => request("GET", "/config"),

    // Events (SSE) - returns a ReadableStream
    subscribeEvents: async () => {
      const res = await fetch(`${baseUrl}/event`, {
        headers: { ...headers, Accept: "text/event-stream" },
      });
      return res.body;
    },
  };
}

/**
 * Connect to OpenCode: ensure server is running, create client.
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {number} [opts.port]
 * @returns {Promise<ReturnType<typeof createClient> & { serverInfo: object }>}
 */
export async function connect(opts = {}) {
  const { url, alreadyRunning } = await ensureServer(opts);
  const client = createClient(url, { directory: opts.cwd });
  return { ...client, serverInfo: { url, alreadyRunning } };
}

/**
 * Reap the plugin-spawned OpenCode server on SessionEnd.
 *
 * Only kills what we started (tracked via server.json `lastServerPid`),
 * and only when the plugin has no in-flight tracked-jobs. The previous
 * implementation gated solely on `now - startedAt > 5 min`, which would
 * SIGTERM the OpenCode server out from under an actively-streaming
 * `sendPrompt` call if a SessionEnd happened to fire during a long
 * rescue or review. Callers would see the socket drop as `terminated`
 * with no timeout error in our own code path.
 *
 * The guard is now two conditions:
 *   1. server uptime is above SERVER_REAP_IDLE_TIMEOUT, and
 *   2. no tracked job is in `running` state with a live companion PID.
 *
 * @param {string} workspacePath
 * @param {{ port?: number, host?: string }} [opts]
 * @returns {Promise<boolean>} true if a server was reaped
 */
export async function reapServerIfOurs(workspacePath, opts = {}) {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;

  const state = loadServerState(workspacePath);
  if (!state.lastServerPid || !Number.isFinite(state.lastServerPid)) return false;

  const pid = state.lastServerPid;
  const startedAt = state.lastServerStartedAt;

  if (!isProcessAlive(pid)) {
    saveServerState(workspacePath, { lastServerPid: null, lastServerStartedAt: null });
    return false;
  }

  const uptimeMs = startedAt ? Date.now() - startedAt : Infinity;
  if (uptimeMs < SERVER_REAP_IDLE_TIMEOUT) return false;

  // Do not kill the server if any tracked job is still running against
  // it. Orphaned `running` jobs (process crashed without marking failed)
  // are filtered out via the shared token-aware liveness check, so a
  // stale state entry cannot permanently block reaping.
  if (hasInFlightTrackedJob(workspacePath)) return false;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // best-effort — PID may have just exited
  }

  await new Promise((r) => setTimeout(r, 1000));

  const stillRunning = await isServerRunning(host, port);
  if (!stillRunning) {
    saveServerState(workspacePath, { lastServerPid: null, lastServerStartedAt: null });
    return true;
  }

  return false;
}

/**
 * Returns true if any tracked job is in `running` state with a
 * companion PID that is still alive. Stale `running` entries from a
 * crashed companion are treated as not-in-flight so the reaper can make
 * progress.
 * @param {string} workspacePath
 * @returns {boolean}
 */
function hasInFlightTrackedJob(workspacePath) {
  let jobsState;
  try {
    jobsState = loadState(workspacePath);
  } catch {
    // If the job state file is unreadable, fail safe: assume in-flight
    // work may exist and keep the server alive. The next SessionEnd
    // will retry.
    return true;
  }
  const jobs = Array.isArray(jobsState?.jobs) ? jobsState.jobs : [];
  for (const job of jobs) {
    if (job?.status !== "running") continue;
    if (!job.pid) continue;
    if (isProcessAliveWithToken(job.pid, job.pidStartToken)) return true;
  }
  return false;
}
