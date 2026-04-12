// Job lifecycle tracking and progress reporting for the OpenCode companion.

import fs from "node:fs";
import path from "node:path";
import { ensureDir, appendLine } from "./fs.mjs";
import { generateJobId, upsertJob, jobLogPath, jobDataPath } from "./state.mjs";

const SESSION_ID_ENV = "OPENCODE_COMPANION_SESSION_ID";

// Hard ceiling for any single tracked job. 30 minutes is generous enough for
// long OpenCode turns but bounded so a hung runner cannot keep the companion
// process alive forever. Override via OPENCODE_COMPANION_JOB_TIMEOUT_MS.
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000;

function resolveJobTimeoutMs(options = {}) {
  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    return options.timeoutMs;
  }
  const fromEnv = Number(process.env.OPENCODE_COMPANION_JOB_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_JOB_TIMEOUT_MS;
}

/**
 * Get the current Claude session ID from environment.
 * @returns {string|undefined}
 */
export function getClaudeSessionId() {
  return process.env[SESSION_ID_ENV] || process.env.CLAUDE_SESSION_ID;
}

/**
 * Create a new job record.
 * @param {string} workspacePath
 * @param {string} type - "review" | "adversarial-review" | "task"
 * @param {object} [meta] - additional metadata
 * @returns {object} the created job
 */
export function createJobRecord(workspacePath, type, meta = {}) {
  const id = generateJobId(type);
  const sessionId = getClaudeSessionId();
  const job = {
    id,
    type,
    status: "pending",
    sessionId,
    ...meta,
  };
  upsertJob(workspacePath, job);
  return job;
}

/**
 * Run a tracked job with full lifecycle management.
 * @param {string} workspacePath
 * @param {object} job
 * @param {(ctx: { report: Function, log: Function }) => Promise<object>} runner
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<object>} the job result
 */
export async function runTrackedJob(workspacePath, job, runner, options = {}) {
  // Mark as running
  upsertJob(workspacePath, { id: job.id, status: "running", pid: process.pid });

  const logFile = jobLogPath(workspacePath, job.id);
  ensureDir(path.dirname(logFile));

  const report = (phase, message) => {
    const line = `[${new Date().toISOString()}] [${phase}] ${message}`;
    appendLine(logFile, line);
    process.stderr.write(line + "\n");
    upsertJob(workspacePath, { id: job.id, phase });
  };

  const log = (message) => {
    appendLine(logFile, `[${new Date().toISOString()}] ${message}`);
  };

  // Race the runner against a hard wall-clock timeout so a hung runner
  // (dropped SSE stream, wedged post-response handler, unresolved downstream
  // fetch) cannot leave the job in `running` forever. See issue #41.
  const timeoutMs = resolveJobTimeoutMs(options);
  let timeoutHandle = null;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error(
          `Tracked job ${job.id} exceeded the ${Math.round(timeoutMs / 1000)}s hard timeout. ` +
            "The runner did not produce a terminal status. " +
            "Set OPENCODE_COMPANION_JOB_TIMEOUT_MS to adjust."
        )
      );
    }, timeoutMs);
  });

  const clearTimer = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  };

  try {
    report("starting", `Job ${job.id} started`);
    const result = await Promise.race([runner({ report, log }), timeoutPromise]);
    clearTimer();

    // Mark as completed
    upsertJob(workspacePath, {
      id: job.id,
      status: "completed",
      completedAt: new Date().toISOString(),
      result: result?.rendered ?? result?.summary ?? null,
    });

    // Write result data file
    const dataFile = jobDataPath(workspacePath, job.id);
    ensureDir(path.dirname(dataFile));
    fs.writeFileSync(dataFile, JSON.stringify(result, null, 2), "utf8");

    report("completed", `Job ${job.id} completed`);
    return result;
  } catch (err) {
    clearTimer();
    upsertJob(workspacePath, {
      id: job.id,
      status: "failed",
      phase: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: err.message,
    });
    report("failed", `Job ${job.id} failed: ${err.message}`);
    throw err;
  }
}

/**
 * Create a progress reporter for a job.
 * @param {string} workspacePath
 * @param {string} jobId
 * @returns {{ report: Function, log: Function }}
 */
export function createProgressReporter(workspacePath, jobId) {
  const logFile = jobLogPath(workspacePath, jobId);

  return {
    report(phase, message) {
      const line = `[${new Date().toISOString()}] [${phase}] ${message}`;
      appendLine(logFile, line);
      upsertJob(workspacePath, { id: jobId, phase });
    },
    log(message) {
      appendLine(logFile, `[${new Date().toISOString()}] ${message}`);
    },
  };
}
