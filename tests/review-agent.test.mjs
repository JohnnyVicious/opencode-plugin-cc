// Unit tests for scripts/lib/review-agent.mjs.
//
// These tests mock the opencode client's `listAgents` method directly
// rather than standing up a real server. That keeps them fast and
// deterministic — they assert the resolver's decision logic, not the
// HTTP round trip.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveReviewAgent,
  READ_ONLY_TOOL_OVERRIDES,
} from "../plugins/opencode/scripts/lib/review-agent.mjs";

describe("resolveReviewAgent", () => {
  it("returns {agent: 'review'} when review is in an array-shaped listAgents response", async () => {
    const client = {
      listAgents: async () => [
        { name: "build" },
        { name: "plan" },
        { name: "review" },
      ],
    };
    const logs = [];
    const result = await resolveReviewAgent(client, (m) => logs.push(m));

    assert.equal(result.agent, "review");
    assert.equal(result.tools, undefined);
    assert.deepEqual(logs, []);
  });

  it("returns {agent: 'review'} when review is in an object-shaped listAgents response", async () => {
    const client = {
      listAgents: async () => ({
        build: { description: "..." },
        review: { description: "..." },
        plan: { description: "..." },
      }),
    };
    const result = await resolveReviewAgent(client, () => {});
    assert.equal(result.agent, "review");
  });

  it("falls back to {agent: 'build', tools: READ_ONLY_TOOL_OVERRIDES} when review is missing", async () => {
    const client = {
      listAgents: async () => [{ name: "build" }, { name: "plan" }],
    };
    const logs = [];
    const result = await resolveReviewAgent(client, (m) => logs.push(m));

    assert.equal(result.agent, "build");
    assert.deepEqual(result.tools, { ...READ_ONLY_TOOL_OVERRIDES });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Custom `review` agent not found/);
    assert.match(logs[0], /OPENCODE_CONFIG_DIR/);
  });

  it("falls back when listAgents throws and logs the error message", async () => {
    const client = {
      listAgents: async () => {
        throw new Error("network exploded");
      },
    };
    const logs = [];
    const result = await resolveReviewAgent(client, (m) => logs.push(m));

    assert.equal(result.agent, "build");
    assert.deepEqual(result.tools, { ...READ_ONLY_TOOL_OVERRIDES });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Could not list agents/);
    assert.match(logs[0], /network exploded/);
  });

  it("tolerates array entries with non-string/missing name fields", async () => {
    const client = {
      listAgents: async () => [
        null,
        { name: null },
        { name: 42 },
        { name: "review" },
      ],
    };
    const result = await resolveReviewAgent(client, () => {});
    assert.equal(result.agent, "review");
  });

  it("treats a null listAgents response as 'review not available'", async () => {
    const client = { listAgents: async () => null };
    const logs = [];
    const result = await resolveReviewAgent(client, (m) => logs.push(m));
    assert.equal(result.agent, "build");
    assert.ok(result.tools);
    assert.equal(logs.length, 1);
  });

  it("defaults log to a no-op when none is provided", async () => {
    const client = {
      listAgents: async () => {
        throw new Error("boom");
      },
    };
    // Must not throw.
    const result = await resolveReviewAgent(client);
    assert.equal(result.agent, "build");
  });

  it("returned tools object is a fresh copy, not a reference to the frozen constant", async () => {
    const client = { listAgents: async () => [] };
    const result = await resolveReviewAgent(client, () => {});
    assert.notEqual(result.tools, READ_ONLY_TOOL_OVERRIDES);
    // Mutating the returned tools must not affect the frozen constant.
    result.tools.custom = true;
    assert.equal(READ_ONLY_TOOL_OVERRIDES.custom, undefined);
  });
});

describe("READ_ONLY_TOOL_OVERRIDES", () => {
  it("denies every write-capable tool", () => {
    for (const tool of ["write", "edit", "patch", "multiedit", "bash", "task", "webfetch"]) {
      assert.equal(READ_ONLY_TOOL_OVERRIDES[tool], false, `${tool} must be denied`);
    }
  });

  it("is frozen so callers can't accidentally mutate the shared constant", () => {
    assert.ok(Object.isFrozen(READ_ONLY_TOOL_OVERRIDES));
    assert.throws(
      () => {
        READ_ONLY_TOOL_OVERRIDES.write = true;
      },
      TypeError,
    );
  });
});
