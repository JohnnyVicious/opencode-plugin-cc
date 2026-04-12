#!/usr/bin/env node

// OpenCode Companion - Main entry point for the Claude Code plugin.
// Mirrors the codex-plugin-cc codex-companion.mjs architecture but uses
// OpenCode's HTTP REST API instead of JSON-RPC over stdin/stdout.
//
// Modified by JohnnyVicious (2026):
//   - thread `--model` through `handleReview` and `handleAdversarialReview`
//     so callers can override OpenCode's default model per review;
//   - accept `--pr <N>` (with `PR #N` focus auto-detect for adversarial)
//     and fetch PR diffs via `gh pr diff` so reviews can target a GitHub
//     pull request without checking it out;
//   - `handleSetup` reads OpenCode's auth.json directly via
//     `getConfiguredProviders` instead of probing the `GET /provider` HTTP
//     endpoint, which returns a TypeScript schema dump rather than the
//     user's configured credentials;
//   - extract the model OpenCode actually used (from `response.info.model`)
//     and prepend it as a `**Model:** ...` header to every review output
//     so users always see which model produced the review;
//   - switch reviews from OpenCode's built-in `plan` agent to a custom
//     `review` agent shipped in the plugin. OpenCode's `plan` agent
//     injects a synthetic user-message directive ("Plan mode ACTIVE —
//     STRICTLY FORBIDDEN... produce an implementation plan") on every
//     turn, which dominates our review system prompt and makes OpenCode
//     return implementation plans instead of the requested review. A
//     custom agent with read-only permissions and a neutral prompt body
//     sidesteps the injection entirely. When our agent isn't available
//     (e.g. the user already had a server running without our config
//     dir), we fall back to the `build` agent with per-call tool
//     restrictions and a warning;
//   - parse `--model <provider>/<model-id>` into OpenCode's required
//     `{providerID, modelID}` object before sending. Passing the raw
//     CLI string caused HTTP 400 ("expected object, received string")
//     on every `--model` invocation — the original threading commit
//     wired the argument through but never adapted the shape;
//   - add a `--free` flag to review, adversarial-review, and task
//     handlers that shells out to `opencode models`, filters for the
//     `:free` / `-free` suffix, and picks one at random so callers
//     can cheaply fire off reviews/tasks against whichever free-tier
//     model is available without hand-picking. Mutually exclusive
//     with `--model`. For background tasks the free model is locked
//     in at dispatch so the worker can't drift;
//   - fix `handleTask` silently dropping `--model`: the foreground
//     path passed `{agent}` to sendPrompt with no model, and the
//     background worker never parsed or forwarded one. Both paths
//     now honor `--model` / `--free` end-to-end.
// (Apache License 2.0 §4(b) modification notice.)

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import fs from "node:fs";

import { parseArgs, extractTaskText } from "./lib/args.mjs";
import { isOpencodeInstalled, getOpencodeVersion, spawnDetached, getConfiguredProviders } from "./lib/process.mjs";
import { isServerRunning, ensureServer, createClient, connect } from "./lib/opencode-server.mjs";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState, updateState, upsertJob, generateJobId, jobDataPath } from "./lib/state.mjs";
import {
  buildStatusSnapshot,
  resolveResultJob,
  resolveCancelableJob,
  enrichJob,
  reconcileAllJobs,
  matchJobReference,
} from "./lib/job-control.mjs";
import { createJobRecord, runTrackedJob, getClaudeSessionId } from "./lib/tracked-jobs.mjs";
import {
  renderStatus,
  renderResult,
  renderReview,
  renderSetup,
  extractResponseModel,
  formatModelHeader,
} from "./lib/render.mjs";
import { buildReviewPrompt, buildTaskPrompt } from "./lib/prompts.mjs";
import { getDiff, getStatus as getGitStatus, detectPrReference } from "./lib/git.mjs";
import {
  createWorktreeSession,
  diffWorktreeSession,
  cleanupWorktreeSession,
} from "./lib/worktree.mjs";
import { readJson } from "./lib/fs.mjs";
import { resolveReviewAgent } from "./lib/review-agent.mjs";
import { parseModelString, selectFreeModel } from "./lib/model.mjs";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");

// ------------------------------------------------------------------
// Subcommand dispatch
// ------------------------------------------------------------------

const [subcommand, ...argv] = process.argv.slice(2);

const handlers = {
  setup: handleSetup,
  review: handleReview,
  "adversarial-review": handleAdversarialReview,
  task: handleTask,
  "task-worker": handleTaskWorker,
  "task-resume-candidate": handleTaskResumeCandidate,
  "last-review": handleLastReview,
  "worktree-cleanup": handleWorktreeCleanup,
  status: handleStatus,
  result: handleResult,
  cancel: handleCancel,
};

const handler = handlers[subcommand];
if (!handler) {
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error(`Available: ${Object.keys(handlers).join(", ")}`);
  process.exit(1);
}

handler(argv).catch((err) => {
  console.error(`Error in ${subcommand}: ${err.message}`);
  process.exit(1);
});

// ------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------

async function handleSetup(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["review-gate-max", "review-gate-cooldown"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
  });

  let reviewGateOverride;
  if (options["enable-review-gate"]) reviewGateOverride = true;
  if (options["disable-review-gate"]) reviewGateOverride = false;

  let reviewGateMaxPerSessionOverride;
  if (options["review-gate-max"] != null) {
    const raw = options["review-gate-max"];
    const max = raw === "off" ? null : Number(raw);
    if (max !== null && (!Number.isInteger(max) || max < 1)) {
      console.error(`--review-gate-max must be a positive integer or "off".`);
      process.exit(1);
    }
    reviewGateMaxPerSessionOverride = max;
  }

  let reviewGateCooldownMinutesOverride;
  if (options["review-gate-cooldown"] != null) {
    const raw = options["review-gate-cooldown"];
    const cooldown = raw === "off" ? null : Number(raw);
    if (cooldown !== null && (!Number.isInteger(cooldown) || cooldown < 1)) {
      console.error(`--review-gate-cooldown must be a positive integer (minutes) or "off".`);
      process.exit(1);
    }
    reviewGateCooldownMinutesOverride = cooldown;
  }

  const installed = await isOpencodeInstalled();
  const version = installed ? await getOpencodeVersion() : null;

  let serverRunning = false;
  let providers = [];

  if (installed) {
    serverRunning = await isServerRunning();

    // Read configured providers directly from OpenCode's auth.json. The
    // HTTP `GET /provider` endpoint returns a TypeScript schema dump, not
    // the user's credentials, and `GET /provider/auth` only lists which
    // auth methods each provider supports. auth.json is the same source
    // of truth that `opencode providers list` uses, and it works whether
    // or not the OpenCode server is running.
    try {
      providers = getConfiguredProviders();
    } catch (err) {
      console.error(`Warning: could not read configured providers: ${err.message}`);
    }
  }

  // Apply setup config changes only after all inputs have been validated.
  const workspace = await resolveWorkspace();
  if (
    reviewGateOverride !== undefined ||
    reviewGateMaxPerSessionOverride !== undefined ||
    reviewGateCooldownMinutesOverride !== undefined
  ) {
    updateState(workspace, (state) => {
      state.config = state.config || {};
      if (reviewGateOverride !== undefined) {
        state.config.reviewGate = reviewGateOverride;
      }
      if (reviewGateMaxPerSessionOverride !== undefined) {
        state.config.reviewGateMaxPerSession = reviewGateMaxPerSessionOverride;
      }
      if (reviewGateCooldownMinutesOverride !== undefined) {
        state.config.reviewGateCooldownMinutes = reviewGateCooldownMinutesOverride;
      }
    });
  }

  const finalState = loadState(workspace);
  const reviewGate = finalState.config?.reviewGate ?? false;
  const reviewGateMaxPerSession = finalState.config?.reviewGateMaxPerSession ?? null;
  const reviewGateCooldownMinutes = finalState.config?.reviewGateCooldownMinutes ?? null;

  const status = {
    installed,
    version,
    serverRunning,
    providers,
    reviewGate,
    reviewGateMaxPerSession,
    reviewGateCooldownMinutes,
  };

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(renderSetup(status));
  }
}

// ------------------------------------------------------------------
// Review
// ------------------------------------------------------------------

/**
 * Resolve the model the user requested. Handles three cases:
 *   - `--free`      : pick a random free model via `opencode models`
 *   - `--model X`   : parse X into {providerID, modelID}
 *   - neither       : return null (use the user's configured default)
 *
 * `--free` and `--model` are mutually exclusive. Errors bubble up to the
 * handler, which prints them and exits non-zero.
 *
 * @param {{ free?: boolean, model?: string }} options
 * @returns {Promise<{providerID: string, modelID: string, raw?: string} | null>}
 */
async function resolveRequestedModel(options) {
  if (options.free && options.model) {
    throw new Error("--free and --model are mutually exclusive; pick one.");
  }
  if (options.free) {
    return selectFreeModel();
  }
  if (options.model) {
    const parsed = parseModelString(options.model);
    if (!parsed) {
      throw new Error(
        `Invalid --model value: ${options.model} (expected "provider/model-id", ` +
        `e.g. openrouter/anthropic/claude-haiku-4.5)`
      );
    }
    return { ...parsed, raw: options.model };
  }
  return null;
}

async function handleReview(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["base", "scope", "model", "pr"],
    booleanOptions: ["wait", "background", "free"],
  });

  const prNumber = options.pr ? Number(options.pr) : null;
  if (options.pr && (!Number.isFinite(prNumber) || prNumber <= 0)) {
    console.error(`Invalid --pr value: ${options.pr} (must be a positive number)`);
    process.exit(1);
  }

  let requestedModel;
  try {
    requestedModel = await resolveRequestedModel(options);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  const job = createJobRecord(workspace, "review", {
    base: options.base,
    model: options.model,
    pr: prNumber,
  });

  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) => {
      report("starting", "Connecting to OpenCode server...");
      const client = await connect({ cwd: workspace });

      report("reviewing", "Creating review session...");
      const session = await client.createSession({ title: `Code Review ${job.id}` });
      upsertJob(workspace, { id: job.id, opencodeSessionId: session.id });

      const prompt = await buildReviewPrompt(workspace, {
        base: options.base,
        pr: prNumber,
        adversarial: false,
      }, PLUGIN_ROOT);

      const reviewAgent = await resolveReviewAgent(client, log);
      const modelLabel = requestedModel?.raw ?? requestedModel ?? null;

      report("reviewing", "Running review...");
      log(`Prompt length: ${prompt.length} chars, agent: ${reviewAgent.agent}${modelLabel ? `, model: ${modelLabel}${options.free ? " (--free picked)" : ""}` : ""}${prNumber ? `, pr: #${prNumber}` : ""}`);

      const response = await client.sendPrompt(session.id, prompt, {
        agent: reviewAgent.agent,
        model: requestedModel ? { providerID: requestedModel.providerID, modelID: requestedModel.modelID } : null,
        tools: reviewAgent.tools,
      });

      report("finalizing", "Processing review output...");

      // Try to parse structured output
      const text = extractResponseText(response);
      let structured = tryParseJson(text);
      const usedModel = extractResponseModel(response);

      return {
        rendered: formatModelHeader(usedModel) + (structured ? renderReview(structured) : text),
        raw: response,
        structured,
        model: usedModel,
      };
    });

    saveLastReview(workspace, result.rendered);
    console.log(result.rendered);
  } catch (err) {
    console.error(`Review failed: ${err.message}`);
    process.exit(1);
  }
}

async function handleAdversarialReview(argv) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["base", "scope", "model", "pr"],
    booleanOptions: ["wait", "background", "free"],
  });

  let requestedModel;
  try {
    requestedModel = await resolveRequestedModel(options);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  let focus = positional.join(" ").trim();

  // --pr <N> takes precedence; otherwise look for "PR #N" / "PR N" inside the
  // focus text and strip it so the matched substring doesn't pollute the
  // prompt with a stale instruction.
  let prNumber = null;
  if (options.pr) {
    prNumber = Number(options.pr);
    if (!Number.isFinite(prNumber) || prNumber <= 0) {
      console.error(`Invalid --pr value: ${options.pr} (must be a positive number)`);
      process.exit(1);
    }
  } else {
    const detected = detectPrReference(focus);
    if (detected) {
      prNumber = detected.prNumber;
      focus = focus.replace(detected.matched, "").replace(/\s+/g, " ").trim();
    }
  }

  const workspace = await resolveWorkspace();
  const job = createJobRecord(workspace, "adversarial-review", {
    base: options.base,
    focus,
    model: options.model,
    pr: prNumber,
  });

  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) => {
      report("starting", "Connecting to OpenCode server...");
      const client = await connect({ cwd: workspace });

      report("reviewing", "Creating adversarial review session...");
      const session = await client.createSession({ title: `Adversarial Review ${job.id}` });
      upsertJob(workspace, { id: job.id, opencodeSessionId: session.id });

      const prompt = await buildReviewPrompt(workspace, {
        base: options.base,
        pr: prNumber,
        adversarial: true,
        focus,
      }, PLUGIN_ROOT);

      const reviewAgent = await resolveReviewAgent(client, log);
      const modelLabel = requestedModel?.raw ?? null;

      report("reviewing", "Running adversarial review...");
      log(`Prompt length: ${prompt.length} chars, agent: ${reviewAgent.agent}, focus: ${focus || "(none)"}${modelLabel ? `, model: ${modelLabel}${options.free ? " (--free picked)" : ""}` : ""}${prNumber ? `, pr: #${prNumber}` : ""}`);

      const response = await client.sendPrompt(session.id, prompt, {
        agent: reviewAgent.agent,
        model: requestedModel ? { providerID: requestedModel.providerID, modelID: requestedModel.modelID } : null,
        tools: reviewAgent.tools,
      });

      report("finalizing", "Processing review output...");

      const text = extractResponseText(response);
      let structured = tryParseJson(text);
      const usedModel = extractResponseModel(response);

      return {
        rendered: formatModelHeader(usedModel) + (structured ? renderReview(structured) : text),
        raw: response,
        structured,
        model: usedModel,
      };
    });

    saveLastReview(workspace, result.rendered);
    console.log(result.rendered);
  } catch (err) {
    console.error(`Adversarial review failed: ${err.message}`);
    process.exit(1);
  }
}

// ------------------------------------------------------------------
// Task (rescue delegation)
// ------------------------------------------------------------------

async function handleTask(argv) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["model", "agent"],
    booleanOptions: ["write", "background", "wait", "resume-last", "fresh", "worktree", "free"],
  });

  const taskText = extractTaskText(argv, ["model", "agent"], [
    "write", "background", "wait", "resume-last", "fresh", "worktree", "free",
  ]);

  if (!taskText) {
    console.error("No task text provided.");
    process.exit(1);
  }

  // Resolve --free / --model once here so background workers inherit a
  // concrete model string and can't drift if `opencode models` changes
  // between dispatch and execution.
  let requestedModel;
  try {
    requestedModel = await resolveRequestedModel(options);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  const isWrite = options.write !== undefined ? options.write : true;
  const agentName = options.agent ?? (isWrite ? "build" : "plan");
  const useWorktree = Boolean(options.worktree);

  if (useWorktree && !isWrite) {
    console.error("--worktree requires --write (nothing to isolate in read-only mode).");
    process.exit(1);
  }

  // Check for resume
  let resumeSessionId = null;
  if (options["resume-last"]) {
    const state = loadState(workspace);
    const sessionId = getClaudeSessionId();
    const lastTask = state.jobs
      ?.filter((j) => j.type === "task" && j.opencodeSessionId)
      ?.filter((j) => !sessionId || j.sessionId === sessionId)
      ?.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))?.[0];

    if (lastTask?.opencodeSessionId) {
      resumeSessionId = lastTask.opencodeSessionId;
    }
  }

  const job = createJobRecord(workspace, "task", {
    agent: agentName,
    resumeSessionId,
    worktree: useWorktree,
  });

  // Background mode: spawn a detached worker
  if (options.background) {
    const workerArgs = [
      path.join(PLUGIN_ROOT, "scripts", "opencode-companion.mjs"),
      "task-worker",
      "--job-id", job.id,
      "--workspace", workspace,
      "--task-text", taskText,
      "--agent", agentName,
    ];
    if (isWrite) workerArgs.push("--write");
    if (useWorktree) workerArgs.push("--worktree");
    if (resumeSessionId) workerArgs.push("--resume-session", resumeSessionId);
    // Pass the resolved model (from --model or --free) as a concrete
    // "provider/model-id" string so the worker doesn't need to re-run
    // `opencode models`.
    if (requestedModel?.raw) {
      workerArgs.push("--model", requestedModel.raw);
    } else if (requestedModel) {
      workerArgs.push("--model", `${requestedModel.providerID}/${requestedModel.modelID}`);
    }

    spawnDetached("node", workerArgs, { cwd: workspace });
    console.log(`OpenCode task started in background: ${job.id}`);
    if (options.free && requestedModel) {
      console.log(`--free picked: ${requestedModel.raw}`);
    }
    console.log("Check `/opencode:status` for progress.");
    return;
  }

  // Set up a worktree session if requested. Foreground mode only.
  let worktreeSession = null;
  let effectiveCwd = workspace;
  let taskError = null;
  if (useWorktree) {
    try {
      worktreeSession = await createWorktreeSession(workspace);
      effectiveCwd = worktreeSession.worktreePath;
      upsertJob(workspace, {
        id: job.id,
        worktreeSession: {
          worktreePath: worktreeSession.worktreePath,
          branch: worktreeSession.branch,
          repoRoot: worktreeSession.repoRoot,
          baseCommit: worktreeSession.baseCommit,
          timestamp: worktreeSession.timestamp,
        },
      });
    } catch (err) {
      console.error(`Failed to create worktree: ${err.message}`);
      process.exit(1);
    }
  }

  // Foreground mode
  let result;
  try {
    result = await runTrackedJob(workspace, job, async ({ report, log }) => {
      report("starting", "Connecting to OpenCode server...");
      const client = await connect({ cwd: effectiveCwd });

      let sessionId;
      if (resumeSessionId) {
        report("starting", `Resuming OpenCode session ${resumeSessionId}...`);
        sessionId = resumeSessionId;
      } else {
        report("starting", "Creating new OpenCode session...");
        const session = await client.createSession({ title: `Task ${job.id}` });
        sessionId = session.id;
      }
      upsertJob(workspace, { id: job.id, opencodeSessionId: sessionId });

      const prompt = buildTaskPrompt(taskText, { write: isWrite });

      report("investigating", "Sending task to OpenCode...");
      log(
        `Agent: ${agentName}, Write: ${isWrite}, ` +
          `Worktree: ${useWorktree ? worktreeSession.branch : "no"}, ` +
          `Prompt: ${prompt.length} chars` +
          (requestedModel?.raw
            ? `, model: ${requestedModel.raw}${options.free ? " (--free picked)" : ""}`
            : "")
      );

      const response = await client.sendPrompt(sessionId, prompt, {
        agent: agentName,
        model: requestedModel ? { providerID: requestedModel.providerID, modelID: requestedModel.modelID } : null,
      });

      report("finalizing", "Processing task output...");

      const text = extractResponseText(response);

      // Get changed files if write mode
      let changedFiles = [];
      if (isWrite) {
        try {
          const diff = await client.getSessionDiff(sessionId);
          if (diff?.files) {
            changedFiles = diff.files.map((f) => f.path || f.name).filter(Boolean);
          }
        } catch (err) {
          log(`Warning: could not retrieve diff - ${err.message}`);
        }
      }

      // If using a worktree, compute the actual git diff stat produced on
      // disk. This is what the user will have to keep or discard.
      let worktreeDiff = null;
      if (worktreeSession) {
        try {
          worktreeDiff = await diffWorktreeSession(worktreeSession);
        } catch (err) {
          log(`Failed to compute worktree diff: ${err.message}`);
        }
      }

      return {
        rendered: worktreeSession
          ? renderWorktreeTaskOutput(text, worktreeSession, worktreeDiff, job.id)
          : text,
        messages: response,
        changedFiles,
        summary: text.slice(0, 500),
        worktreeSession: worktreeSession
          ? {
              worktreePath: worktreeSession.worktreePath,
              branch: worktreeSession.branch,
              repoRoot: worktreeSession.repoRoot,
              baseCommit: worktreeSession.baseCommit,
            }
          : null,
      };
    });

    console.log(result.rendered);
  } catch (err) {
    taskError = err;
    // Don't clean up worktree here - let finally handle it
    console.error(`Task failed: ${err.message}`);
    process.exit(1);
  } finally {
    // Always clean up worktree on exit, whether success or failure
    if (worktreeSession) {
      try {
        await cleanupWorktreeSession(worktreeSession, { keep: taskError === null });
      } catch {
        // best-effort
      }
    }
  }
}

function renderWorktreeTaskOutput(text, session, diff, jobId) {
  const lines = [];
  if (text) {
    lines.push(text.trimEnd());
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push("## Worktree");
  lines.push("");
  lines.push(`Branch: \`${session.branch}\``);
  lines.push(`Path: \`${session.worktreePath}\``);
  lines.push("");
  if (diff?.stat) {
    lines.push("### Changes");
    lines.push("");
    lines.push("```");
    lines.push(diff.stat);
    lines.push("```");
    lines.push("");
  } else {
    lines.push("OpenCode made no file changes in the worktree.");
    lines.push("");
  }
  lines.push("### Next steps");
  lines.push("");
  lines.push(`- **Keep**: \`node "\${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" worktree-cleanup ${jobId} --action keep\``);
  lines.push(`- **Discard**: \`node "\${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" worktree-cleanup ${jobId} --action discard\``);
  return lines.join("\n");
}

async function handleWorktreeCleanup(argv) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["action"],
    booleanOptions: ["json"],
  });

  const jobId = positional[0];
  if (!jobId) {
    console.error("Usage: worktree-cleanup <job-id> --action <keep|discard>");
    process.exit(1);
  }
  const action = options.action;
  if (action !== "keep" && action !== "discard") {
    console.error("--action must be 'keep' or 'discard'.");
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  const state = loadState(workspace);
  const { job, ambiguous } = matchJobReference(state.jobs ?? [], jobId);
  if (ambiguous) {
    console.error("Ambiguous job reference. Please provide a more specific ID prefix.");
    process.exit(1);
  }
  if (!job) {
    console.error(`No job found for ${jobId}.`);
    process.exit(1);
  }

  const session = job.worktreeSession;
  if (!session?.worktreePath || !session?.branch || !session?.repoRoot) {
    console.error(`Job ${jobId} has no worktree session. Was it run with --worktree?`);
    process.exit(1);
  }

  const result = await cleanupWorktreeSession(session, { keep: action === "keep" });

  if (options.json) {
    console.log(JSON.stringify({ jobId: job.id, action, result }, null, 2));
    return;
  }

  const lines = ["# Worktree Cleanup", ""];
  if (action === "keep") {
    if (result.applied) {
      lines.push(`Applied changes from \`${session.branch}\` and cleaned up.`);
    } else if (result.detail === "No changes to apply.") {
      lines.push(`No changes to apply. Worktree and branch \`${session.branch}\` cleaned up.`);
    } else {
      lines.push(`Failed to apply changes: ${result.detail}`);
      lines.push("");
      lines.push(
        `The worktree and branch \`${session.branch}\` have been preserved at ` +
          `\`${session.worktreePath}\` for manual recovery.`
      );
    }
  } else {
    lines.push(`Discarded worktree \`${session.worktreePath}\` and branch \`${session.branch}\`.`);
  }
  console.log(lines.join("\n"));
}

async function handleTaskWorker(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["job-id", "workspace", "task-text", "agent", "model", "resume-session"],
    booleanOptions: ["write", "worktree"],
  });

  const workspace = options.workspace;
  const jobId = options["job-id"];
  const taskText = options["task-text"];
  const agentName = options.agent ?? "build";
  const isWrite = !!options.write;
  const useWorktree = Boolean(options.worktree);
  const resumeSessionId = options["resume-session"];
  // Parent `handleTask` resolves --free/--model into a concrete
  // provider/model-id string before spawning us, so the worker just
  // needs to parse and forward it.
  const workerModel = parseModelString(options.model);

  if (!workspace || !jobId || !taskText) {
    process.exit(1);
  }

  let worktreeSession = null;
  let effectiveCwd = workspace;
  if (useWorktree) {
    try {
      worktreeSession = await createWorktreeSession(workspace);
      effectiveCwd = worktreeSession.worktreePath;
      upsertJob(workspace, {
        id: jobId,
        worktreeSession: {
          worktreePath: worktreeSession.worktreePath,
          branch: worktreeSession.branch,
          repoRoot: worktreeSession.repoRoot,
          baseCommit: worktreeSession.baseCommit,
          timestamp: worktreeSession.timestamp,
        },
      });
    } catch (err) {
      upsertJob(workspace, {
        id: jobId,
        status: "failed",
        phase: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: `Failed to create worktree: ${err.message}`,
      });
      process.exit(1);
    }
  }

  let signalsHandled = false;
  const handleSignal = async (signal) => {
    if (signalsHandled) return;
    signalsHandled = true;
    upsertJob(workspace, {
      id: jobId,
      status: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: `Worker terminated by ${signal}`,
    });
    if (worktreeSession) {
      try {
        await cleanupWorktreeSession(worktreeSession, { keep: false });
      } catch {
        // best-effort
      }
    }
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  try {
    await runTrackedJob(workspace, { id: jobId }, async ({ report, log }) => {
      report("starting", "Background worker connecting to OpenCode...");
      const client = await connect({ cwd: effectiveCwd });

      let sessionId;
      if (resumeSessionId) {
        sessionId = resumeSessionId;
        report("starting", `Resuming session ${resumeSessionId}...`);
      } else {
        const session = await client.createSession({ title: `Task ${jobId}` });
        sessionId = session.id;
        report("starting", `Created session ${sessionId}`);
      }
      upsertJob(workspace, { id: jobId, opencodeSessionId: sessionId });

      const prompt = buildTaskPrompt(taskText, { write: isWrite });
      report("investigating", "Running task...");
      log(
        `Agent: ${agentName}, Write: ${isWrite}, ` +
          `Worktree: ${worktreeSession?.branch ?? "no"}` +
          (workerModel ? `, model: ${options.model}` : "")
      );

      const response = await client.sendPrompt(sessionId, prompt, {
        agent: agentName,
        model: workerModel,
      });

      const text = extractResponseText(response);

      let worktreeDiff = null;
      if (worktreeSession) {
        try {
          worktreeDiff = await diffWorktreeSession(worktreeSession);
        } catch (err) {
          log(`Failed to compute worktree diff: ${err.message}`);
        }
      }

      report("finalizing", "Done");

      return {
        rendered: worktreeSession
          ? renderWorktreeTaskOutput(text, worktreeSession, worktreeDiff, jobId)
          : text,
        summary: text.slice(0, 500),
        worktreeSession: worktreeSession
          ? {
              worktreePath: worktreeSession.worktreePath,
              branch: worktreeSession.branch,
              repoRoot: worktreeSession.repoRoot,
              baseCommit: worktreeSession.baseCommit,
            }
          : null,
      };
    });
  } catch (err) {
    if (worktreeSession) {
      try {
        await cleanupWorktreeSession(worktreeSession, { keep: false });
      } catch {
        // best-effort
      }
    }
    // Error is already logged by runTrackedJob
    process.exit(1);
  }
}

async function handleTaskResumeCandidate(argv) {
  const { options } = parseArgs(argv, { booleanOptions: ["json"] });

  const workspace = await resolveWorkspace();
  const state = loadState(workspace);
  const sessionId = getClaudeSessionId();

  const lastTask = state.jobs
    ?.filter((j) => j.type === "task" && j.opencodeSessionId)
    ?.filter((j) => j.status === "completed" || j.status === "running")
    ?.filter((j) => !sessionId || j.sessionId === sessionId)
    ?.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))?.[0];

  const result = {
    available: !!lastTask,
    jobId: lastTask?.id ?? null,
    opencodeSessionId: lastTask?.opencodeSessionId ?? null,
  };

  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(result.available ? `Resumable session: ${result.opencodeSessionId}` : "No resumable session.");
  }
}

// ------------------------------------------------------------------
// Status / Result / Cancel
// ------------------------------------------------------------------

async function handleStatus(argv) {
  const workspace = await resolveWorkspace();
  const state = loadState(workspace);
  const sessionId = getClaudeSessionId();

  const snapshot = buildStatusSnapshot(state.jobs ?? [], workspace, { sessionId });
  console.log(renderStatus(snapshot));
}

async function handleResult(argv) {
  const { positional } = parseArgs(argv, {});
  const ref = positional[0];

  const workspace = await resolveWorkspace();
  const state = loadState(workspace);
  const reconciled = reconcileAllJobs(state.jobs ?? [], workspace);

  const { job, ambiguous } = resolveResultJob(reconciled, ref);

  if (ambiguous) {
    console.error("Ambiguous job reference. Please provide a more specific ID prefix.");
    process.exit(1);
  }

  if (!job) {
    console.log("No finished job found.");
    return;
  }

  const enriched = enrichJob(job, workspace);

  // Try to load detailed result data
  const dataFile = jobDataPath(workspace, job.id);
  const resultData = readJson(dataFile);

  console.log(renderResult(enriched, resultData));
}

async function handleCancel(argv) {
  const { positional } = parseArgs(argv, {});
  const ref = positional[0];

  const workspace = await resolveWorkspace();
  const state = loadState(workspace);
  const sessionId = getClaudeSessionId();
  const reconciled = reconcileAllJobs(state.jobs ?? [], workspace);

  const { job, ambiguous, sessionScoped } = resolveCancelableJob(
    reconciled,
    ref,
    { sessionId }
  );

  if (ambiguous) {
    console.error("Multiple active jobs. Please specify a job ID prefix.");
    process.exit(1);
  }

  if (!job) {
    console.log(
      sessionScoped
        ? "No active OpenCode jobs to cancel for this session."
        : "No active job to cancel."
    );
    return;
  }

  // Abort the OpenCode session if we have one
  if (job.opencodeSessionId) {
    try {
      const client = createClient("http://127.0.0.1:4096");
      await client.abortSession(job.opencodeSessionId);
    } catch {
      // Server may not be running
    }
  }

  // Kill the process if we have a PID
  if (job.pid) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      // Process may already be gone
    }
  }

  upsertJob(workspace, {
    id: job.id,
    status: "failed",
    completedAt: new Date().toISOString(),
    errorMessage: "Canceled by user",
  });

  console.log(`Canceled job: ${job.id}`);
}

// ------------------------------------------------------------------
// Last-review persistence
// ------------------------------------------------------------------

/**
 * Per-repo path where the most recent successful review is saved so the
 * rescue command can pick it up without the user copy-pasting findings.
 * @param {string} workspace
 * @returns {{ dir: string, file: string }}
 */
function lastReviewPath(workspace) {
  const hash = crypto.createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  const dir = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".opencode-companion");
  return { dir, file: path.join(dir, `last-review-${hash}.md`) };
}

/**
 * Best-effort persistence of a rendered review so the rescue flow can read
 * it later. Never throws — a failed write must not fail the review itself.
 * @param {string} workspace
 * @param {string} rendered
 */
function saveLastReview(workspace, rendered) {
  if (!rendered) return;
  let tmp = null;
  try {
    const { dir, file } = lastReviewPath(workspace);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, rendered, "utf8");
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    fs.copyFileSync(tmp, file);
    tmp = null;
  } catch {
    // best-effort
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true });
  }
}

async function handleLastReview(argv) {
  const { options } = parseArgs(argv, { booleanOptions: ["json", "content"] });
  const workspace = await resolveWorkspace();
  const { file } = lastReviewPath(workspace);

  if (!fs.existsSync(file)) {
    if (options.json) console.log(JSON.stringify({ available: false }));
    else console.log("NO_LAST_REVIEW");
    return;
  }

  if (options.content) {
    process.stdout.write(fs.readFileSync(file, "utf8"));
    return;
  }

  if (options.json) {
    const stat = fs.statSync(file);
    console.log(
      JSON.stringify({
        available: true,
        updatedAt: stat.mtime.toISOString(),
        path: file,
      })
    );
  } else {
    console.log("LAST_REVIEW_AVAILABLE");
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Extract text from an OpenCode API response.
 * @param {any} response
 * @returns {string}
 */
function extractResponseText(response) {
  if (typeof response === "string") return response;

  // Response shape: { info: { ... }, parts: [ { type: "text", text: "..." }, ... ] }
  if (response?.parts) {
    return response.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }

  // Fallback: try info.content or just stringify
  if (response?.info?.content) {
    if (typeof response.info.content === "string") return response.info.content;
    if (Array.isArray(response.info.content)) {
      return response.info.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
    }
  }

  return JSON.stringify(response, null, 2);
}


/**
 * Try to parse a string as JSON, returning null on failure.
 * @param {string} text
 * @returns {object|null}
 */
function tryParseJson(text) {
  // Look for JSON in the text (may be wrapped in markdown code blocks)
  const jsonMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = jsonMatch ? jsonMatch[1] : text;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    return null;
  }
}
