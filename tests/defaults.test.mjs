import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyDefaultModelOptions,
  hasOwnOption,
  normalizeDefaults,
  parseDefaultAgentSetting,
  parseDefaultModelSetting,
  resolveTaskAgentName,
} from "../plugins/opencode/scripts/lib/defaults.mjs";

describe("command defaults", () => {
  it("normalizes valid persisted defaults", () => {
    assert.deepEqual(
      normalizeDefaults({
        model: "  anthropic/claude-opus-4-6  ",
        agent: "build",
      }),
      {
        model: "anthropic/claude-opus-4-6",
        agent: "build",
      },
    );
  });

  it("ignores invalid persisted defaults", () => {
    assert.deepEqual(
      normalizeDefaults({
        model: "claude-opus-4-6",
        agent: "custom-agent",
      }),
      { model: null, agent: null },
    );
  });

  it("parses setup default model values", () => {
    assert.equal(
      parseDefaultModelSetting(" anthropic/claude-opus-4-6 "),
      "anthropic/claude-opus-4-6",
    );
    assert.equal(parseDefaultModelSetting("off"), null);
    assert.throws(
      () => parseDefaultModelSetting("claude-opus-4-6"),
      /--default-model/,
    );
  });

  it("parses setup default agent values", () => {
    assert.equal(parseDefaultAgentSetting("build"), "build");
    assert.equal(parseDefaultAgentSetting("plan"), "plan");
    assert.equal(parseDefaultAgentSetting("off"), null);
    assert.throws(
      () => parseDefaultAgentSetting("review"),
      /--default-agent/,
    );
  });

  it("applies the default model only when no explicit model selector exists", () => {
    const defaults = { model: "anthropic/claude-opus-4-6" };

    assert.deepEqual(
      applyDefaultModelOptions({}, defaults),
      { model: "anthropic/claude-opus-4-6" },
    );
    assert.deepEqual(
      applyDefaultModelOptions({ model: "openrouter/anthropic/claude-haiku-4.5" }, defaults),
      { model: "openrouter/anthropic/claude-haiku-4.5" },
    );
    assert.deepEqual(
      applyDefaultModelOptions({ free: true }, defaults),
      { free: true },
    );
  });

  it("treats an explicitly present model option as intentional even when empty", () => {
    assert.equal(hasOwnOption({ model: "" }, "model"), true);
    assert.deepEqual(
      applyDefaultModelOptions({ model: "" }, { model: "anthropic/claude-opus-4-6" }),
      { model: "" },
    );
  });

  it("resolves task agent precedence", () => {
    assert.equal(resolveTaskAgentName({ agent: "custom" }, { agent: "plan" }, true), "custom");
    assert.equal(resolveTaskAgentName({}, { agent: "plan" }, true), "plan");
    assert.equal(resolveTaskAgentName({}, {}, true), "build");
    assert.equal(resolveTaskAgentName({}, {}, false), "plan");
  });
});
