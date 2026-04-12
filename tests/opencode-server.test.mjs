// Integration tests for the OpenCode HTTP server wrapper.
//
// These tests start a real `opencode serve` process on a high test port
// (so they don't collide with a user's default-port server) and exercise
// the protocol surfaces our companion script depends on:
//
//   - server lifecycle (`isServerRunning`, `ensureServer`)
//   - health endpoint
//   - session create / get / list / delete
//
// They intentionally do NOT call `sendPrompt` because that requires a
// configured AI provider and would burn paid API credits in CI.
//
// Locally, this suite is skipped if the `opencode` binary is not on PATH,
// so developers without OpenCode installed can still run `npm test`.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  isOpencodeInstalled,
} from "../plugins/opencode/scripts/lib/process.mjs";
import {
  isServerRunning,
  ensureServer,
  createClient,
} from "../plugins/opencode/scripts/lib/opencode-server.mjs";

const TEST_HOST = "127.0.0.1";
const TEST_PORT = Number(process.env.OPENCODE_TEST_PORT ?? 14096);

const opencodeAvailable = await isOpencodeInstalled();
const describeOrSkip = opencodeAvailable ? describe : describe.skip;

it("ensureServer reports opencode spawn failure without crashing", async (t) => {
  const port = Number(process.env.OPENCODE_MISSING_BINARY_TEST_PORT ?? 24096);
  if (await isServerRunning(TEST_HOST, port)) {
    t.skip(`test port ${port} is already in use`);
    return;
  }

  const oldPath = process.env.PATH;
  const oldPathUpper = process.env.Path;
  process.env.PATH = "";
  if (oldPathUpper !== undefined) process.env.Path = "";
  try {
    await assert.rejects(
      () => ensureServer({ host: TEST_HOST, port }),
      /Failed to start OpenCode server|exited before becoming ready/
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldPathUpper === undefined) delete process.env.Path;
    else process.env.Path = oldPathUpper;
  }
});

describeOrSkip("opencode HTTP server (integration)", () => {
  let serverInfo;
  let client;

  before(async () => {
    // If something is already squatting our test port, fail fast with a
    // useful message instead of silently sharing state with a foreign
    // server.
    if (await isServerRunning(TEST_HOST, TEST_PORT)) {
      throw new Error(
        `Test port ${TEST_PORT} is already in use. Set OPENCODE_TEST_PORT to a free port.`
      );
    }

    serverInfo = await ensureServer({ host: TEST_HOST, port: TEST_PORT });
    client = createClient(serverInfo.url);
  });

  after(async () => {
    // Tear down the server we spawned. `ensureServer` only sets `pid`
    // when it actually started a new process, so this is a no-op when
    // the server was already running (which our `before` rejects, but
    // be defensive).
    if (!serverInfo?.pid || serverInfo.alreadyRunning) return;

    // opencode is spawned with `detached: true`, which puts it in its
    // own process group. SIGTERM the negative pid to take down the
    // whole group (any children opencode forked included).
    const pgid = -serverInfo.pid;
    try {
      process.kill(pgid, "SIGTERM");
    } catch {
      // group may already be gone — that's fine
    }

    // Wait briefly for graceful shutdown, then SIGKILL the group if
    // anything is still alive. We poll instead of sleeping a fixed
    // interval so a fast exit doesn't waste time.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pgid, 0); // signal 0 = existence check
      } catch {
        return; // group is gone
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    try {
      process.kill(pgid, "SIGKILL");
    } catch {
      // already exited between checks
    }
  });

  it("isServerRunning detects the spawned server", async () => {
    assert.equal(await isServerRunning(TEST_HOST, TEST_PORT), true);
  });

  it("health() reports healthy with a version string", async () => {
    const h = await client.health();
    assert.equal(h.healthy, true);
    assert.ok(typeof h.version === "string" && h.version.length > 0,
      `expected version string, got ${JSON.stringify(h.version)}`);
  });

  it("createSession returns an id", async () => {
    const session = await client.createSession({ title: "test session" });
    assert.ok(typeof session.id === "string" && session.id.length > 0);
    await client.deleteSession(session.id);
  });

  it("listSessions returns an array containing a freshly-created session", async () => {
    const created = await client.createSession({ title: "list test" });
    try {
      const sessions = await client.listSessions();
      assert.ok(Array.isArray(sessions));
      assert.ok(
        sessions.some((s) => s.id === created.id),
        "freshly-created session was not present in listSessions output"
      );
    } finally {
      await client.deleteSession(created.id);
    }
  });

  it("createSession -> getSession -> deleteSession roundtrip", async () => {
    const created = await client.createSession({ title: "roundtrip" });
    const fetched = await client.getSession(created.id);
    assert.equal(fetched.id, created.id);

    await client.deleteSession(created.id);

    // After deletion, getSession should reject with a non-2xx status.
    await assert.rejects(
      () => client.getSession(created.id),
      /OpenCode API GET .* returned 4\d\d/
    );
  });
});
