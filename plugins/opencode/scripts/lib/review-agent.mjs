// Shared review-agent resolution for the OpenCode companion.
//
// The plugin reviews code (both ordinary and adversarial) by sending a
// carefully constructed system prompt to OpenCode. We used to route
// those requests through OpenCode's built-in `plan` agent on the
// assumption that it was the read-only counterpart to `build`. It is
// read-only, but it also injects a synthetic user-message directive on
// every turn ("Plan mode ACTIVE — STRICTLY FORBIDDEN... produce an
// implementation plan") which overrides our review prompt and makes
// the model return implementation plans instead of reviews.
//
// The fix is a dedicated `review` agent shipped inside the plugin at
// `plugins/opencode/opencode-config/agent/review.md`, discovered via
// OPENCODE_CONFIG_DIR when the plugin spawns `opencode serve`.
//
// This module centralizes the "pick the right agent" decision so the
// companion script and the stop-review-gate hook cannot drift.
//
// (Apache License 2.0 §4(b) modification notice — see NOTICE.)

/**
 * Read-only tool overrides used when the custom `review` agent isn't
 * available and we have to fall back to the `build` agent. This
 * enforces read-only behavior at the per-call level so a misbehaving
 * model can't edit files or shell out, even though `build` is
 * normally read-write.
 *
 * Frozen so callers cannot accidentally mutate the shared object —
 * each consumer should spread it if they need to add keys.
 */
export const READ_ONLY_TOOL_OVERRIDES = Object.freeze({
  write: false,
  edit: false,
  patch: false,
  multiedit: false,
  bash: false,
  task: false,
  webfetch: false,
});

/**
 * Extract agent names from a `listAgents()` response. OpenCode's
 * `/agent` endpoint has returned both array-shaped and object-shaped
 * payloads across versions, so we handle both.
 * @param {unknown} agents
 * @returns {string[]}
 */
function extractAgentNames(agents) {
  if (Array.isArray(agents)) {
    return agents.map((a) => a?.name).filter((name) => typeof name === "string");
  }
  if (agents && typeof agents === "object") {
    return Object.keys(agents);
  }
  return [];
}

/**
 * Decide which agent to use for reviews. Prefer the custom `review`
 * agent shipped inside the plugin. If it's not available on the
 * server we're talking to — typically because the user already had
 * `opencode serve` running without our OPENCODE_CONFIG_DIR — fall
 * back to `build` with per-call read-only tool overrides and log a
 * warning so the caller knows why.
 *
 * @param {{ listAgents: () => Promise<unknown> }} client
 * @param {(msg: string) => void} [log]
 * @returns {Promise<{ agent: string, tools?: object }>}
 */
export async function resolveReviewAgent(client, log = () => {}) {
  try {
    const agents = await client.listAgents();
    const names = extractAgentNames(agents);

    if (names.includes("review")) {
      return { agent: "review", tools: undefined };
    }

    log(
      "Custom `review` agent not found on this server. Falling back to " +
      "`build` with read-only tool overrides. To get the preferred path, " +
      "stop any pre-existing `opencode serve` so the plugin can restart " +
      "it with OPENCODE_CONFIG_DIR pointing at the bundled config."
    );
  } catch (err) {
    log(`Could not list agents (${err.message}); falling back to build + tool overrides.`);
  }

  return { agent: "build", tools: { ...READ_ONLY_TOOL_OVERRIDES } };
}
