#!/usr/bin/env node

// Stop review gate hook for the OpenCode companion.
// When enabled, runs a targeted OpenCode review on Claude's response before
// allowing the session to stop. If issues are found, the stop is blocked.

import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState, updateState } from "./lib/state.mjs";
import { isServerRunning, connect } from "./lib/opencode-server.mjs";
import { resolveReviewAgent } from "./lib/review-agent.mjs";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");

function currentSessionId() {
  return (
    process.env.OPENCODE_COMPANION_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID ||
    null
  );
}

/**
 * Prune review-gate usage entries older than 7 days so long-lived workspace
 * state doesn't grow unbounded across many Claude sessions.
 */
function pruneOldUsage(usage) {
  if (!usage || typeof usage !== "object") return {};
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const kept = {};
  for (const [sid, entry] of Object.entries(usage)) {
    if (!entry?.lastRunAt) continue;
    const ts = new Date(entry.lastRunAt).getTime();
    if (Number.isFinite(ts) && ts >= cutoff) {
      kept[sid] = entry;
    }
  }
  return kept;
}

async function main() {
  const workspace = await resolveWorkspace();

  // Check if review gate is enabled
  const state = loadState(workspace);
  if (!state.config?.reviewGate) {
    // Gate is disabled, allow stop
    console.log("ALLOW: Review gate is disabled.");
    return;
  }

  // Throttle check — honor per-session cap and cooldown if configured.
  // Skipped when no session id is available (can't scope the limit safely).
  const sessionId = currentSessionId();
  if (sessionId) {
    const usage = state.reviewGateUsage?.[sessionId] ?? { count: 0, lastRunAt: null };
    const max = state.config.reviewGateMaxPerSession;
    if (Number.isFinite(max) && usage.count >= max) {
      console.log(`ALLOW: Review gate session cap (${max}) reached.`);
      return;
    }
    const cooldownMin = state.config.reviewGateCooldownMinutes;
    if (Number.isFinite(cooldownMin) && usage.lastRunAt) {
      const elapsedMs = Date.now() - new Date(usage.lastRunAt).getTime();
      if (Number.isFinite(elapsedMs) && elapsedMs < cooldownMin * 60 * 1000) {
        const remaining = Math.ceil((cooldownMin * 60 * 1000 - elapsedMs) / 1000);
        console.log(`ALLOW: Review gate cooldown (${remaining}s remaining).`);
        return;
      }
    }
  }

  // Check if server is available
  if (!(await isServerRunning())) {
    console.log("ALLOW: OpenCode server not running.");
    return;
  }

  // Read the Claude response from stdin (piped by Claude Code)
  let claudeResponse = "";
  if (!process.stdin.isTTY) {
    claudeResponse = await new Promise((resolve) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data));
      // Timeout after 5 seconds of no input
      setTimeout(() => resolve(data), 5000);
    });
  }

  if (!claudeResponse.trim()) {
    console.log("ALLOW: No response to review.");
    return;
  }

  // Load the stop-review-gate prompt template
  const templatePath = path.join(PLUGIN_ROOT, "prompts", "stop-review-gate.md");
  const template = fs.readFileSync(templatePath, "utf8");
  const prompt = template.replace(
    "{{CLAUDE_RESPONSE_BLOCK}}",
    `<claude_response>\n${claudeResponse}\n</claude_response>`
  );

  try {
    const client = await connect({ cwd: workspace });
    const session = await client.createSession({ title: "Stop Review Gate" });

    // Prefer the custom `review` agent; fall back to `build` + tool
    // overrides if the running server doesn't have our custom agent.
    // See lib/review-agent.mjs for the rationale.
    const reviewAgent = await resolveReviewAgent(client);

    const response = await client.sendPrompt(session.id, prompt, {
      agent: reviewAgent.agent,
      tools: reviewAgent.tools,
    });

    // Extract the verdict
    const text = extractText(response);
    const firstLine = text.trim().split("\n")[0];

    // Bump usage before returning a verdict so the count reflects work
    // actually done, even if the verdict BLOCKs.
    if (sessionId) {
      const nowIso = new Date().toISOString();
      updateState(workspace, (s) => {
        s.reviewGateUsage = pruneOldUsage(s.reviewGateUsage);
        const prior = s.reviewGateUsage[sessionId] ?? { count: 0, lastRunAt: null };
        s.reviewGateUsage[sessionId] = {
          count: prior.count + 1,
          lastRunAt: nowIso,
        };
      });
    }

    if (firstLine.startsWith("BLOCK")) {
      // Output BLOCK to stderr so Claude Code sees it
      process.stderr.write(`OpenCode review gate: ${firstLine}\n`);
      console.log(firstLine);
      process.exit(1); // Non-zero exit blocks the stop
    } else {
      console.log(firstLine || "ALLOW: No issues found.");
    }
  } catch (err) {
    // On error, allow the stop (don't block on failures)
    console.log(`ALLOW: Review gate error: ${err.message}`);
  }
}

function extractText(response) {
  if (typeof response === "string") return response;
  if (response?.parts) {
    return response.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  return JSON.stringify(response);
}

main().catch((err) => {
  console.log(`ALLOW: Unhandled error: ${err.message}`);
  process.exit(0);
});
