// Regression test for the undici `bodyTimeout` bug that made long
// adversarial reviews die with `TypeError: terminated` around the
// 4.5–5 minute mark.
//
// Node's bundled undici has a 300_000 ms default `bodyTimeout` that
// fires when the server holds the connection open mid-body longer than
// 5 minutes. The OpenCode `/session/{id}/message` endpoint legitimately
// does exactly that while the model thinks on a long review. Our
// `sendPrompt` used to be built on `fetch()` and was subject to this
// hidden timer; it now uses `node:http` directly so no dispatcher-level
// body timer can pull the rug out from under us.
//
// We don't actually wait 5 minutes in the test — we stall the server
// for 7 seconds, which is far longer than any `fetch()`-based
// implementation could be configured to tolerate without importing
// `undici` explicitly (which we refuse to do because it's not an
// installed dependency). 7 s is enough to prove the request is not
// being cut off by a short internal timer while still keeping `npm
// test` fast.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createClient } from "../plugins/opencode/scripts/lib/opencode-server.mjs";

describe("sendPrompt body-timeout resilience", () => {
  /** @type {http.Server} */
  let server;
  let baseUrl;

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url !== "/session/stall-test/message") {
        res.writeHead(404).end();
        return;
      }
      // Drain the request body, then begin a chunked response and stall
      // for several seconds before completing it. This simulates
      // OpenCode holding the connection open while the model thinks.
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
        });
        res.write("{");
        setTimeout(() => {
          res.end('"ok":true}');
        }, 7_000);
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it(
    "tolerates a server that holds the response body for 7+ seconds",
    { timeout: 20_000 },
    async () => {
      const client = createClient(baseUrl);
      const start = Date.now();
      const result = await client.sendPrompt("stall-test", "hello");
      const elapsedMs = Date.now() - start;
      assert.deepEqual(result, { ok: true });
      assert.ok(
        elapsedMs >= 6_500,
        `expected request to take ~7s, actually took ${elapsedMs}ms`
      );
    }
  );
});
