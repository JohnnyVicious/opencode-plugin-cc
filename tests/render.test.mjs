import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderStatus,
  renderResult,
  renderSetup,
  extractResponseModel,
  formatModelHeader,
} from "../plugins/opencode/scripts/lib/render.mjs";

describe("renderStatus", () => {
  it("renders empty state", () => {
    const output = renderStatus({ running: [], latestFinished: null, recent: [] });
    assert.ok(output.includes("No OpenCode jobs"));
  });

  it("renders running jobs", () => {
    const output = renderStatus({
      running: [{ id: "task-1", type: "task", phase: "investigating", elapsed: "2m 30s" }],
      latestFinished: null,
      recent: [],
    });
    assert.ok(output.includes("task-1"));
    assert.ok(output.includes("investigating"));
  });
});

describe("renderSetup", () => {
  it("renders installed status", () => {
    const output = renderSetup({
      installed: true,
      version: "1.3.9",
      serverRunning: true,
      providers: ["anthropic"],
      defaults: {
        model: "anthropic/claude-opus-4-6",
        agent: "build",
      },
      reviewGate: false,
    });
    assert.ok(output.includes("Yes"));
    assert.ok(output.includes("1.3.9"));
    assert.ok(output.includes("anthropic"));
    assert.ok(output.includes("anthropic/claude-opus-4-6"));
    assert.ok(output.includes("build"));
  });

  it("renders not installed status", () => {
    const output = renderSetup({ installed: false });
    assert.ok(output.includes("No"));
  });
});

describe("renderResult", () => {
  it("renders completed job", () => {
    const output = renderResult(
      { id: "task-1", type: "task", status: "completed", elapsed: "5m" },
      { rendered: "Fixed the bug in api.ts" }
    );
    assert.ok(output.includes("task-1"));
    assert.ok(output.includes("Fixed the bug"));
  });

  it("renders failed job", () => {
    const output = renderResult(
      { id: "task-2", type: "task", status: "failed", elapsed: "1m", errorMessage: "Connection timeout" },
      null
    );
    assert.ok(output.includes("Connection timeout"));
  });
});

describe("extractResponseModel", () => {
  it("returns providerID/modelID for a well-formed response", () => {
    const r = {
      info: { model: { providerID: "openrouter", modelID: "minimax/minimax-m2.5:free" } },
      parts: [],
    };
    assert.deepEqual(extractResponseModel(r), {
      providerID: "openrouter",
      modelID: "minimax/minimax-m2.5:free",
    });
  });

  it("returns null when info is missing", () => {
    assert.equal(extractResponseModel({ parts: [] }), null);
  });

  it("returns null when info.model is missing", () => {
    assert.equal(extractResponseModel({ info: { role: "assistant" } }), null);
  });

  it("returns null when providerID is missing", () => {
    assert.equal(extractResponseModel({ info: { model: { modelID: "x" } } }), null);
  });

  it("returns null when modelID is missing", () => {
    assert.equal(extractResponseModel({ info: { model: { providerID: "x" } } }), null);
  });

  it("returns null when providerID/modelID are empty strings", () => {
    assert.equal(
      extractResponseModel({ info: { model: { providerID: "", modelID: "" } } }),
      null
    );
  });

  it("returns null when providerID/modelID are not strings", () => {
    assert.equal(
      extractResponseModel({ info: { model: { providerID: 1, modelID: 2 } } }),
      null
    );
  });

  it("returns null for null/undefined input", () => {
    assert.equal(extractResponseModel(null), null);
    assert.equal(extractResponseModel(undefined), null);
  });
});

describe("formatModelHeader", () => {
  it("formats a model as a markdown header", () => {
    const out = formatModelHeader({
      providerID: "openrouter",
      modelID: "minimax/minimax-m2.5:free",
    });
    assert.equal(out, "**Model:** `openrouter/minimax/minimax-m2.5:free`\n\n");
  });

  it("returns empty string when model is null", () => {
    assert.equal(formatModelHeader(null), "");
  });

  it("returns empty string when model is undefined", () => {
    assert.equal(formatModelHeader(undefined), "");
  });

  it("output ends with a blank line so it can be safely concatenated", () => {
    const header = formatModelHeader({ providerID: "x", modelID: "y" });
    assert.ok(header.endsWith("\n\n"), "expected trailing blank line");
  });
});
