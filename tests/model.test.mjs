// Unit tests for scripts/lib/model.mjs.
//
// Covers both model-string parsing (used for `--model`) and the
// `opencode models` shell-out + free-model selection (used for
// `--free`). The shell-out helpers take injected `run` and `rng`
// callbacks, so tests don't need a real opencode binary or non-
// deterministic randomness.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseModelString,
  listOpencodeModels,
  selectFreeModel,
} from "../plugins/opencode/scripts/lib/model.mjs";

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

// Fake `opencode models` stdout fixture, modeled on the real output
// that the current user's opencode binary produced — 31 free models
// scattered among ~600 total.
const FAKE_OPENCODE_MODELS_STDOUT = [
  "opencode/big-pickle",
  "opencode/gpt-5-nano",
  "opencode/minimax-m2.5-free",
  "opencode/nemotron-3-super-free",
  "openrouter/anthropic/claude-haiku-4.5",
  "openrouter/anthropic/claude-opus-4.6",
  "openrouter/anthropic/claude-sonnet-4.6",
  "openrouter/google/gemma-3-27b-it",
  "openrouter/google/gemma-3-27b-it:free",
  "openrouter/google/gemma-3-4b-it:free",
  "openrouter/meta-llama/llama-3.3-70b-instruct:free",
  "openrouter/minimax/minimax-m2.5:free",
  "openrouter/moonshotai/kimi-k2:free",
  "openrouter/qwen/qwen-max",
  "",              // blank line — should be ignored
  "   ",           // whitespace-only — should be ignored
].join("\n");

function makeFakeRun(stdout, { exitCode = 0, stderr = "" } = {}) {
  return async (cmd, args) => {
    assert.equal(cmd, "opencode");
    assert.deepEqual(args, ["models"]);
    return { stdout, stderr, exitCode };
  };
}

describe("listOpencodeModels", () => {
  it("parses the opencode models output into one model per line", async () => {
    const run = makeFakeRun(FAKE_OPENCODE_MODELS_STDOUT);
    const models = await listOpencodeModels({ run });
    assert.equal(models.length, 14);
    assert.equal(models[0], "opencode/big-pickle");
    assert.ok(models.includes("openrouter/minimax/minimax-m2.5:free"));
  });

  it("filters out blank and whitespace-only lines", async () => {
    const run = makeFakeRun("foo/bar\n\n  \nbaz/qux\n");
    const models = await listOpencodeModels({ run });
    assert.deepEqual(models, ["foo/bar", "baz/qux"]);
  });

  it("throws a helpful error when opencode models exits non-zero", async () => {
    const run = makeFakeRun("", { exitCode: 1, stderr: "opencode: command not found" });
    await assert.rejects(
      () => listOpencodeModels({ run }),
      /opencode models.*command not found/i,
    );
  });

  it("throws with the exit code when stderr is empty", async () => {
    const run = makeFakeRun("", { exitCode: 127 });
    await assert.rejects(
      () => listOpencodeModels({ run }),
      /exit code 127/,
    );
  });
});

describe("selectFreeModel", () => {
  it("picks a free-suffixed model and returns {providerID, modelID, raw}", async () => {
    const run = makeFakeRun(FAKE_OPENCODE_MODELS_STDOUT);
    // rng=0 → first item in the filtered list
    const result = await selectFreeModel({ run, rng: () => 0 });
    assert.equal(result.raw, "opencode/minimax-m2.5-free");
    assert.equal(result.providerID, "opencode");
    assert.equal(result.modelID, "minimax-m2.5-free");
  });

  it("picks the last free model when rng returns just under 1", async () => {
    const run = makeFakeRun(FAKE_OPENCODE_MODELS_STDOUT);
    const result = await selectFreeModel({ run, rng: () => 0.999999 });
    assert.equal(result.raw, "openrouter/moonshotai/kimi-k2:free");
  });

  it("honors the injected rng deterministically", async () => {
    const run = makeFakeRun(FAKE_OPENCODE_MODELS_STDOUT);
    // 6 free models in the fixture; rng=0.5 → idx=3
    const result = await selectFreeModel({ run, rng: () => 0.5 });
    assert.equal(result.raw, "openrouter/google/gemma-3-4b-it:free");
  });

  it("only picks models whose suffix is :free or -free (not substring 'free' elsewhere)", async () => {
    const run = makeFakeRun([
      "openrouter/acme/freedom-v1",    // contains free but doesn't end with the suffix
      "openrouter/acme/model-free",     // -free suffix ✓
      "openrouter/acme/other:free",     // :free suffix ✓
    ].join("\n"));
    // Run many times to verify only the two legitimate free models are picked
    const seen = new Set();
    for (let i = 0; i < 20; i += 1) {
      const r = await selectFreeModel({ run, rng: () => i / 20 });
      seen.add(r.raw);
    }
    assert.equal(seen.size, 2);
    assert.ok(seen.has("openrouter/acme/model-free"));
    assert.ok(seen.has("openrouter/acme/other:free"));
    assert.ok(!seen.has("openrouter/acme/freedom-v1"));
  });

  it("throws a descriptive error when no free models are available", async () => {
    const run = makeFakeRun("openrouter/anthropic/claude-haiku-4.5\nopencode/big-pickle\n");
    await assert.rejects(
      () => selectFreeModel({ run, rng: () => 0.5 }),
      /no free-tier models/i,
    );
  });

  it("propagates listOpencodeModels errors unchanged", async () => {
    const run = makeFakeRun("", { exitCode: 127 });
    await assert.rejects(
      () => selectFreeModel({ run, rng: () => 0 }),
      /exit code 127/,
    );
  });
});
