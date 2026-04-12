// Unit tests for scripts/lib/model.mjs.
//
// These assert that the CLI `--model <provider>/<model-id>` string is
// transformed into the `{providerID, modelID}` object shape that
// OpenCode's `POST /session/:id/message` endpoint expects.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModelString } from "../plugins/opencode/scripts/lib/model.mjs";

describe("parseModelString", () => {
  it("splits on the first slash so nested model ids stay intact", () => {
    assert.deepEqual(parseModelString("openrouter/anthropic/claude-haiku-4.5"), {
      providerID: "openrouter",
      modelID: "anthropic/claude-haiku-4.5",
    });
  });

  it("handles a flat provider/model pair", () => {
    assert.deepEqual(parseModelString("anthropic/claude-sonnet-4-5"), {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    });
  });

  it("handles provider/model ids that contain many slashes", () => {
    assert.deepEqual(parseModelString("openrouter/meta-llama/llama-3.1/70b-instruct"), {
      providerID: "openrouter",
      modelID: "meta-llama/llama-3.1/70b-instruct",
    });
  });

  it("trims surrounding whitespace", () => {
    assert.deepEqual(parseModelString("  openrouter/anthropic/claude-haiku-4.5  "), {
      providerID: "openrouter",
      modelID: "anthropic/claude-haiku-4.5",
    });
  });

  it("returns null for an empty string", () => {
    assert.equal(parseModelString(""), null);
    assert.equal(parseModelString("   "), null);
  });

  it("returns null for a missing provider prefix", () => {
    assert.equal(parseModelString("claude-haiku-4.5"), null);
  });

  it("returns null when the provider is empty (leading slash)", () => {
    assert.equal(parseModelString("/claude-haiku-4.5"), null);
  });

  it("returns null when the model id is empty (trailing slash)", () => {
    assert.equal(parseModelString("openrouter/"), null);
  });

  it("returns null for non-string input", () => {
    assert.equal(parseModelString(null), null);
    assert.equal(parseModelString(undefined), null);
    assert.equal(parseModelString(42), null);
    assert.equal(parseModelString({ providerID: "x", modelID: "y" }), null);
  });
});
