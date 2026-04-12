// Job control: query, sort, enrich, and build status snapshots.

import { tailLines } from "./fs.mjs";
import { jobLogPath, loadState, upsertJob } from "./state.mjs";
import { isProcessAlive } from "./process.mjs";

function isActiveJobStatus(status) {
  return status !== "completed" && status !== "failed";
}

function shouldReconcileDeadPids() {
  return !/^(1|true|yes)$/i.test(process.env.OPENCODE_COMPANION_NO_RECONCILE ?? "");
}

/**
 * Mark a job as failed because its tracked PID is no longer alive. Re-reads
 * the latest persisted state before writing to guard against a legitimate
 * completion racing the probe.
 *
 * @param {string} workspacePath
 * @param {string} jobId
 * @param {number} pid - the pid we observed as dead
 * @param {string|null} [pidStartToken] - the process-start token observed as dead
 * @returns {boolean} true if a write happened
 */
export function markDeadPidJobFailed(workspacePath, jobId, pid, pidStartToken = null) {
  const latest = loadState(workspacePath).jobs?.find((j) => j.id === jobId);
  if (!latest) return false;

  // Only overwrite active states; never downgrade terminal states.
  if (!isActiveJobStatus(latest.status)) return false;

  // Only overwrite if the PID still matches what we observed as dead. Guards
  // against a job that legitimately restarted with a new PID between the
  // probe and the write.
  if (latest.pid !== pid) return false;
  if (pidStartToken && latest.pidStartToken && latest.pidStartToken !== pidStartToken) {
    return false;
  }

  upsertJob(workspacePath, {
    id: jobId,
    status: "failed",
    phase: "failed",
    pid: null,
    pidStartToken: null,
    errorMessage: `Tracked process PID ${pid} exited unexpectedly without writing a terminal status.`,
    completedAt: new Date().toISOString(),
  });
  return true;
}

/**
 * If a job is still marked active but its tracked PID is dead, reconcile it
 * to failed and return the updated record. Otherwise return the original.
 *
 * Called from every status read path so a single status query is enough to
 * surface dead workers — no need to wait for SessionEnd.
 *
 * @param {string} workspacePath
 * @param {object} job
 * @returns {object}
 */
export function reconcileIfDead(workspacePath, job) {
  if (!shouldReconcileDeadPids()) return job;
  if (!job || !isActiveJobStatus(job.status)) return job;
  const pid = Number.isFinite(job.pid) ? job.pid : null;
  if (pid === null) return job;
  if (isProcessAlive(pid, job.pidStartToken)) return job;

  try {
    markDeadPidJobFailed(workspacePath, job.id, pid, job.pidStartToken);
  } catch {
    // Never let reconciliation errors crash a status read.
    return job;
  }

  const latest = loadState(workspacePath).jobs?.find((j) => j.id === job.id);
  return latest ?? job;
}

/**
 * Reconcile all active jobs in the given list against live PIDs.
 * Returns a new list where dead-PID jobs have been rewritten to failed.
 *
 * Cheap shortcut used by handlers that otherwise operate on pure job arrays
 * (handleCancel, handleResult) so a single call surfaces dead workers.
 *
 * @param {object[]} jobs
 * @param {string} workspacePath
 * @returns {object[]}
 */
export function reconcileAllJobs(jobs, workspacePath) {
  if (!Array.isArray(jobs) || jobs.length === 0) return jobs;
  return jobs.map((j) => reconcileIfDead(workspacePath, j));
}

/**
 * Sort jobs newest first by updatedAt.
 * @param {object[]} jobs
 * @returns {object[]}
 */
export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

/**
 * Enrich a job with computed fields: elapsed time, progress preview, phase.
 * @param {object} job
 * @param {string} workspacePath
 * @returns {object}
 */
export function enrichJob(job, workspacePath) {
  const enriched = { ...job };

  // Elapsed time
  if (job.createdAt) {
    const start = new Date(job.createdAt).getTime();
    const end = job.completedAt ? new Date(job.completedAt).getTime() : Date.now();
    enriched.elapsedMs = end - start;
    enriched.elapsed = formatDuration(enriched.elapsedMs);
  }

  // Progress preview from log tail
  if (job.status === "running") {
    const logFile = jobLogPath(workspacePath, job.id);
    const lines = tailLines(logFile, 3);
    if (lines.length > 0) {
      enriched.progressPreview = lines.join("\n");
    }
  }

  // Infer phase from log
  if (job.status === "running" && !job.phase) {
    enriched.phase = inferPhase(job, workspacePath);
  }

  return enriched;
}

/**
 * Infer the current phase of a running job from its log.
 * @param {object} job
 * @param {string} workspacePath
 * @returns {string}
 */
function inferPhase(job, workspacePath) {
  const logFile = jobLogPath(workspacePath, job.id);
  const lines = tailLines(logFile, 20);
  const text = lines.join("\n").toLowerCase();

  if (text.includes("error") || text.includes("failed")) return "failed";
  if (text.includes("finalizing") || text.includes("complete")) return "finalizing";
  if (text.includes("editing") || text.includes("writing")) return "editing";
  if (text.includes("verifying") || text.includes("testing")) return "verifying";
  if (text.includes("investigating") || text.includes("analyzing")) return "investigating";
  if (text.includes("reviewing")) return "reviewing";
  if (text.includes("starting") || text.includes("initializing")) return "starting";
  return "running";
}

/**
 * Build a status snapshot for display.
 * @param {object[]} jobs
 * @param {string} workspacePath
 * @param {{ sessionId?: string }} opts
 * @returns {{ running: object[], latestFinished: object|null, recent: object[] }}
 */
export function buildStatusSnapshot(jobs, workspacePath, opts = {}) {
  let filtered = jobs;
  if (opts.sessionId) {
    filtered = jobs.filter((j) => j.sessionId === opts.sessionId);
  }

  const sorted = sortJobsNewestFirst(filtered);
  // Reconcile any active jobs whose tracked PID is dead before enriching, so
  // a single status read surfaces stuck workers immediately.
  const reconciled = sorted.map((j) => reconcileIfDead(workspacePath, j));
  const enriched = reconciled.map((j) => enrichJob(j, workspacePath));

  const running = enriched.filter((j) => isActiveJobStatus(j.status));
  const finished = enriched.filter((j) => !isActiveJobStatus(j.status));
  const latestFinished = finished[0] ?? null;
  const recent = finished.slice(0, 5);

  return { running, latestFinished, recent };
}

/**
 * Find a single job by ID or prefix match.
 * @param {object[]} jobs
 * @param {string} ref
 * @returns {{ job: object|null, ambiguous: boolean }}
 */
export function matchJobReference(jobs, ref) {
  if (!ref) return { job: null, ambiguous: false };

  // Exact match first
  const exact = jobs.find((j) => j.id === ref);
  if (exact) return { job: exact, ambiguous: false };

  // Prefix match
  const matches = jobs.filter((j) => j.id.startsWith(ref));
  if (matches.length === 1) return { job: matches[0], ambiguous: false };
  if (matches.length > 1) return { job: null, ambiguous: true };

  return { job: null, ambiguous: false };
}

/**
 * Resolve a job that has finished (completed or failed).
 * @param {object[]} jobs
 * @param {string} [ref]
 * @returns {{ job: object|null, ambiguous: boolean }}
 */
export function resolveResultJob(jobs, ref) {
  const finished = jobs.filter((j) => j.status === "completed" || j.status === "failed");
  if (!ref) {
    const sorted = sortJobsNewestFirst(finished);
    return { job: sorted[0] ?? null, ambiguous: false };
  }
  return matchJobReference(finished, ref);
}

/**
 * Resolve a job that can be canceled (running).
 *
 * When opts.sessionId is set, the default target (no ref) is restricted to
 * jobs from that session so `/opencode:cancel` doesn't reach across Claude
 * sessions and kill unrelated work. An explicit ref still searches all
 * running jobs — if the user names a job, they asked for it by name.
 *
 * @param {object[]} jobs
 * @param {string} [ref]
 * @param {{ sessionId?: string }} [opts]
 * @returns {{ job: object|null, ambiguous: boolean, sessionScoped?: boolean }}
 */
export function resolveCancelableJob(jobs, ref, opts = {}) {
  const running = jobs.filter((j) => j.status === "running");
  if (ref) {
    return matchJobReference(running, ref);
  }
  const scoped = opts.sessionId
    ? running.filter((j) => j.sessionId === opts.sessionId)
    : running;
  return {
    job: scoped[0] ?? null,
    ambiguous: scoped.length > 1,
    sessionScoped: Boolean(opts.sessionId),
  };
}

/**
 * Format a duration in milliseconds to human-readable string.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}
