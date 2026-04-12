import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sortJobsNewestFirst,
  matchJobReference,
  resolveResultJob,
  resolveCancelableJob,
  buildStatusSnapshot,
} from "../plugins/opencode/scripts/lib/job-control.mjs";

describe("job-control", () => {
  const jobs = [
    { id: "review-abc", status: "completed", type: "review", updatedAt: "2026-01-01T01:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
    { id: "task-def", status: "running", type: "task", updatedAt: "2026-01-01T02:00:00Z", createdAt: "2026-01-01T01:30:00Z" },
    { id: "task-ghi", status: "failed", type: "task", updatedAt: "2026-01-01T00:30:00Z", createdAt: "2026-01-01T00:00:00Z" },
  ];

  it("sortJobsNewestFirst sorts by updatedAt descending", () => {
    const sorted = sortJobsNewestFirst(jobs);
    assert.equal(sorted[0].id, "task-def");
    assert.equal(sorted[1].id, "review-abc");
    assert.equal(sorted[2].id, "task-ghi");
  });

  it("matchJobReference finds exact match", () => {
    const { job, ambiguous } = matchJobReference(jobs, "task-def");
    assert.equal(job.id, "task-def");
    assert.equal(ambiguous, false);
  });

  it("matchJobReference finds prefix match", () => {
    const { job, ambiguous } = matchJobReference(jobs, "review");
    assert.equal(job.id, "review-abc");
    assert.equal(ambiguous, false);
  });

  it("matchJobReference detects ambiguity", () => {
    const { job, ambiguous } = matchJobReference(jobs, "task");
    assert.equal(job, null);
    assert.equal(ambiguous, true);
  });

  it("matchJobReference returns null for no match", () => {
    const { job, ambiguous } = matchJobReference(jobs, "nonexistent");
    assert.equal(job, null);
    assert.equal(ambiguous, false);
  });

  it("resolveResultJob returns latest finished without ref", () => {
    const { job } = resolveResultJob(jobs);
    assert.equal(job.id, "review-abc");
  });

  it("resolveResultJob includes failed jobs", () => {
    const { job } = resolveResultJob(jobs, "task-ghi");
    assert.equal(job.id, "task-ghi");
  });

  it("resolveCancelableJob returns running job", () => {
    const { job } = resolveCancelableJob(jobs);
    assert.equal(job.id, "task-def");
  });

  it("resolveCancelableJob returns null when no running jobs", () => {
    const noRunning = jobs.filter((j) => j.status !== "running");
    const { job } = resolveCancelableJob(noRunning);
    assert.equal(job, null);
  });

  it("resolveCancelableJob default is scoped to sessionId when provided", () => {
    const multiSession = [
      { id: "task-mine", status: "running", type: "task", sessionId: "S1", updatedAt: "2026-01-01T02:00:00Z", createdAt: "2026-01-01T01:30:00Z" },
      { id: "task-other", status: "running", type: "task", sessionId: "S2", updatedAt: "2026-01-01T02:05:00Z", createdAt: "2026-01-01T01:35:00Z" },
    ];
    const { job, sessionScoped } = resolveCancelableJob(multiSession, undefined, { sessionId: "S1" });
    assert.equal(job.id, "task-mine");
    assert.equal(sessionScoped, true);
  });

  it("resolveCancelableJob default returns null when session has no running jobs", () => {
    const multiSession = [
      { id: "task-other", status: "running", type: "task", sessionId: "S2", updatedAt: "2026-01-01T02:05:00Z", createdAt: "2026-01-01T01:35:00Z" },
    ];
    const { job, sessionScoped } = resolveCancelableJob(multiSession, undefined, { sessionId: "S1" });
    assert.equal(job, null);
    assert.equal(sessionScoped, true);
  });

  it("resolveCancelableJob explicit ref searches across sessions", () => {
    const multiSession = [
      { id: "task-mine", status: "running", type: "task", sessionId: "S1", updatedAt: "2026-01-01T02:00:00Z", createdAt: "2026-01-01T01:30:00Z" },
      { id: "task-other", status: "running", type: "task", sessionId: "S2", updatedAt: "2026-01-01T02:05:00Z", createdAt: "2026-01-01T01:35:00Z" },
    ];
    const { job } = resolveCancelableJob(multiSession, "task-other", { sessionId: "S1" });
    assert.equal(job.id, "task-other");
  });

  it("resolveCancelableJob default is ambiguous when session has multiple running jobs", () => {
    const multiSession = [
      { id: "task-a", status: "running", type: "task", sessionId: "S1", updatedAt: "2026-01-01T02:00:00Z", createdAt: "2026-01-01T01:30:00Z" },
      { id: "task-b", status: "running", type: "task", sessionId: "S1", updatedAt: "2026-01-01T02:05:00Z", createdAt: "2026-01-01T01:35:00Z" },
    ];
    const { job, ambiguous } = resolveCancelableJob(multiSession, undefined, { sessionId: "S1" });
    assert.equal(job.id, "task-a");
    assert.equal(ambiguous, true);
  });

  it("buildStatusSnapshot separates running and finished", () => {
    const snapshot = buildStatusSnapshot(jobs, "/tmp/test");
    assert.equal(snapshot.running.length, 1);
    assert.equal(snapshot.running[0].id, "task-def");
    assert.ok(snapshot.latestFinished);
    assert.equal(snapshot.recent.length, 2);
  });
});
