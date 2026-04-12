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

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { platformShellOption } from "./process.mjs";

const DEFAULT_PORT = 4096;
const DEFAULT_HOST = "127.0.0.1";
const SERVER_START_TIMEOUT = 30_000;

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

  // Wait for the server to become ready
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
      return { url, pid: proc.pid, alreadyRunning: false };
    }
    await new Promise((r) => setTimeout(r, 500));
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
