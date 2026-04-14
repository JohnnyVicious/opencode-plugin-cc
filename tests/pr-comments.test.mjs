// Unit tests for pr-comments.mjs — the module that prepares an
// OpenCode review for posting back to a GitHub PR. Since the refactor,
// the module does NOT execute `gh api` to POST anything; it constructs
// the payload, writes it to a temp file, and emits a structured
// stderr trailer for Claude Code to act on. Tests therefore cover:
//   - diff parsing (addable-line classification),
//   - finding classification (inline vs summary-only),
//   - summary body rendering,
//   - payload-file + trailer construction via preparePostInstructions
//     with an injected `prData` so no real `gh` calls happen.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseAddableLines,
  buildAddableLineMap,
  splitFindings,
  findingToInlineComment,
  renderSummaryBody,
  writePayloadFile,
  shQuote,
  formatPostTrailer,
  preparePostInstructions,
} from "../plugins/opencode/scripts/lib/pr-comments.mjs";

describe("parseAddableLines", () => {
  it("returns an empty set for empty or missing input", () => {
    assert.equal(parseAddableLines("").size, 0);
    assert.equal(parseAddableLines(null).size, 0);
    assert.equal(parseAddableLines(undefined).size, 0);
  });

  it("collects addition and context lines as addable RIGHT-side lines", () => {
    // Hunk starting at right line 10:
    //   10: context "a"
    //   11: addition "b"     <- addable
    //   12: addition "c"     <- addable
    //   13: context "d"      <- addable
    //   (deletion "e" stays on left, does not advance right)
    //   14: addition "f"     <- addable
    const patch = [
      "@@ -5,4 +10,5 @@",
      " a",
      "+b",
      "+c",
      " d",
      "-e",
      "+f",
    ].join("\n");
    const addable = parseAddableLines(patch);
    assert.deepEqual([...addable].sort((x, y) => x - y), [10, 11, 12, 13, 14]);
  });

  it("does not mark LEFT-side deletions as addable", () => {
    const patch = ["@@ -1,2 +1,1 @@", " a", "-b"].join("\n");
    const addable = parseAddableLines(patch);
    assert.deepEqual([...addable], [1]);
  });

  it("handles multi-hunk patches", () => {
    const patch = [
      "@@ -1,1 +1,1 @@",
      "+first",
      "@@ -10,1 +20,1 @@",
      "+second",
    ].join("\n");
    const addable = parseAddableLines(patch);
    assert.deepEqual([...addable].sort((x, y) => x - y), [1, 20]);
  });

  it("skips the '\\ No newline at end of file' marker without advancing", () => {
    const patch = [
      "@@ -1,1 +1,2 @@",
      "+a",
      "\\ No newline at end of file",
      "+b",
    ].join("\n");
    const addable = parseAddableLines(patch);
    assert.deepEqual([...addable].sort((x, y) => x - y), [1, 2]);
  });
});

describe("buildAddableLineMap", () => {
  it("returns an empty map for missing input", () => {
    assert.equal(buildAddableLineMap(undefined).size, 0);
    assert.equal(buildAddableLineMap([]).size, 0);
  });

  it("keys by filename and drops files with no patch or no addable lines", () => {
    const map = buildAddableLineMap([
      { filename: "a.js", patch: "@@ -1,1 +1,1 @@\n+a" },
      { filename: "b.js" }, // no patch
      { filename: "c.js", patch: "" }, // empty patch
    ]);
    assert.equal(map.size, 1);
    assert.ok(map.get("a.js").has(1));
  });
});

describe("splitFindings", () => {
  const addable = new Map([["src/foo.js", new Set([10, 11, 12])]]);

  it("routes below-threshold findings to summary-only", () => {
    const { inline, summaryOnly } = splitFindings(
      [
        {
          file: "src/foo.js",
          line_start: 10,
          line_end: 10,
          confidence: 0.5,
          title: "weak",
        },
      ],
      addable,
      0.8
    );
    assert.equal(inline.length, 0);
    assert.equal(summaryOnly.length, 1);
  });

  it("routes high-confidence findings with addable line to inline", () => {
    const { inline, summaryOnly } = splitFindings(
      [
        {
          file: "src/foo.js",
          line_start: 11,
          line_end: 11,
          confidence: 0.9,
          title: "strong",
        },
      ],
      addable,
      0.8
    );
    assert.equal(inline.length, 1);
    assert.equal(summaryOnly.length, 0);
    assert.equal(inline[0]._targetLine, 11);
  });

  it("degrades a high-confidence finding whose file is not in the diff", () => {
    const { inline, summaryOnly } = splitFindings(
      [
        {
          file: "src/not-in-diff.js",
          line_start: 1,
          line_end: 1,
          confidence: 0.95,
          title: "orphan",
        },
      ],
      addable,
      0.8
    );
    assert.equal(inline.length, 0);
    assert.equal(summaryOnly.length, 1);
  });

  it("degrades a high-confidence finding whose range misses the diff", () => {
    const { inline, summaryOnly } = splitFindings(
      [
        {
          file: "src/foo.js",
          line_start: 50,
          line_end: 60,
          confidence: 0.9,
          title: "wrong region",
        },
      ],
      addable,
      0.8
    );
    assert.equal(inline.length, 0);
    assert.equal(summaryOnly.length, 1);
  });

  it("anchors to the first addable line in the finding's range", () => {
    const map = new Map([["src/foo.js", new Set([12, 14])]]);
    const { inline } = splitFindings(
      [
        {
          file: "src/foo.js",
          line_start: 10,
          line_end: 15,
          confidence: 0.9,
          title: "range",
        },
      ],
      map,
      0.8
    );
    assert.equal(inline.length, 1);
    assert.equal(inline[0]._targetLine, 12);
  });

  it("handles missing line_end by treating it as line_start", () => {
    const { inline } = splitFindings(
      [
        {
          file: "src/foo.js",
          line_start: 11,
          confidence: 0.9,
          title: "single line",
        },
      ],
      addable,
      0.8
    );
    assert.equal(inline.length, 1);
    assert.equal(inline[0]._targetLine, 11);
  });

  it("respects a higher threshold", () => {
    const { inline } = splitFindings(
      [
        {
          file: "src/foo.js",
          line_start: 10,
          confidence: 0.85,
          title: "medium-high",
        },
      ],
      addable,
      0.95
    );
    assert.equal(inline.length, 0);
  });

  it("skips findings without a numeric confidence", () => {
    const { inline, summaryOnly } = splitFindings(
      [
        {
          file: "src/foo.js",
          line_start: 10,
          title: "no confidence",
        },
      ],
      addable,
      0.8
    );
    assert.equal(inline.length, 0);
    assert.equal(summaryOnly.length, 1);
  });
});

describe("findingToInlineComment", () => {
  it("builds a GitHub-review comment payload with path/line/side/body", () => {
    const comment = findingToInlineComment({
      file: "src/foo.js",
      _targetLine: 42,
      severity: "high",
      confidence: 0.92,
      title: "Race condition",
      body: "Two writers can observe stale state.",
      recommendation: "Hold the lock around the read-modify-write.",
    });
    assert.equal(comment.path, "src/foo.js");
    assert.equal(comment.line, 42);
    assert.equal(comment.side, "RIGHT");
    assert.match(comment.body, /HIGH/);
    assert.match(comment.body, /Race condition/);
    assert.match(comment.body, /92%/);
    assert.match(comment.body, /Recommendation/);
    assert.match(comment.body, /opencode-plugin-cc/);
  });

  it("survives a minimal finding with no severity or recommendation", () => {
    const comment = findingToInlineComment({
      file: "src/foo.js",
      _targetLine: 1,
      title: "Minimal",
    });
    assert.equal(comment.path, "src/foo.js");
    assert.equal(comment.line, 1);
    assert.match(comment.body, /Minimal/);
  });
});

describe("renderSummaryBody", () => {
  const baseStructured = {
    verdict: "needs-attention",
    summary: "Two issues worth addressing before merge.",
    findings: [
      {
        severity: "high",
        confidence: 0.9,
        title: "Tenant isolation",
        file: "src/foo.js",
        line_start: 10,
        line_end: 12,
        body: "Reqs from tenant A can see tenant B's data.",
        recommendation: "Scope the query by tenant_id.",
      },
      {
        severity: "medium",
        confidence: 0.5,
        title: "Missing retries",
        file: "src/bar.js",
        line_start: 22,
        line_end: 22,
        body: "Downstream 5xx is not retried.",
        recommendation: "Wrap in exponential backoff.",
      },
    ],
  };

  it("renders the title, verdict, model, summary, findings table, and footer", () => {
    const body = renderSummaryBody({
      structured: baseStructured,
      model: { providerID: "openrouter", modelID: "anthropic/claude-opus-4-6" },
      adversarial: true,
      inlineCount: 1,
      summaryOnlyCount: 1,
      confidenceThreshold: 0.8,
    });

    assert.match(body, /OpenCode Adversarial Review/);
    assert.match(body, /Needs attention/);
    assert.match(body, /openrouter\/anthropic\/claude-opus-4-6/);
    assert.match(body, /Two issues worth addressing/);
    assert.match(body, /### Findings \(2\)/);
    assert.match(body, /\| # \| Severity \| Confidence \|/);
    assert.match(body, /HIGH/);
    assert.match(body, /MEDIUM/);
    assert.match(body, /src\/foo\.js/);
    assert.match(body, /10.12/);
    assert.match(body, /1 finding at or above 80% confidence posted as inline comment/);
    assert.match(body, /1 finding kept in the summary only/);
    assert.match(body, /opencode-plugin-cc/);
  });

  it("shows an approve verdict label when the review approves", () => {
    const body = renderSummaryBody({
      structured: { verdict: "approve", findings: [] },
      model: null,
      adversarial: false,
      inlineCount: 0,
      summaryOnlyCount: 0,
      confidenceThreshold: 0.8,
    });
    assert.match(body, /OpenCode Review — Approve/);
    assert.match(body, /No material findings/);
  });

  it("falls back to the rendered text when structured is null", () => {
    const body = renderSummaryBody({
      structured: null,
      rendered: "Raw review text the model produced.",
      model: null,
      adversarial: false,
      inlineCount: 0,
      summaryOnlyCount: 0,
      confidenceThreshold: 0.8,
    });
    assert.match(body, /did not return structured JSON/);
    assert.match(body, /Raw review text the model produced/);
  });

  it("escapes pipe characters and newlines in table cells", () => {
    const body = renderSummaryBody({
      structured: {
        verdict: "needs-attention",
        findings: [
          {
            severity: "high",
            confidence: 0.9,
            title: "Has | pipe and\nnewline",
            file: "src/foo.js",
            line_start: 1,
            line_end: 1,
            body: "",
            recommendation: "",
          },
        ],
      },
      model: null,
      adversarial: false,
      inlineCount: 0,
      summaryOnlyCount: 1,
      confidenceThreshold: 0.8,
    });
    // Pipes must be escaped so they don't split a markdown table cell.
    assert.match(body, /Has \\\| pipe and newline/);
  });
});

describe("shQuote", () => {
  it("wraps simple paths in single quotes", () => {
    assert.equal(shQuote("/tmp/foo.json"), "'/tmp/foo.json'");
  });

  it("escapes embedded single quotes via the standard '\\'' trick", () => {
    assert.equal(shQuote("/tmp/wat's this.json"), "'/tmp/wat'\\''s this.json'");
  });

  it("treats non-string input as string", () => {
    assert.equal(shQuote(42), "'42'");
  });
});

describe("writePayloadFile", () => {
  const written = [];
  after(() => {
    for (const p of written) {
      try {
        fs.unlinkSync(p);
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("writes a JSON file with the exact payload and returns its path", () => {
    const payload = {
      commit_id: "deadbeef",
      event: "COMMENT",
      body: "hello",
      comments: [{ path: "a.js", line: 1, side: "RIGHT", body: "x" }],
    };
    const p = writePayloadFile(42, payload);
    written.push(p);
    assert.ok(fs.existsSync(p));
    assert.ok(p.includes("post-pr-42-"));
    const roundtripped = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.deepEqual(roundtripped, payload);
  });

  it("produces a unique path per call", () => {
    const a = writePayloadFile(1, {});
    const b = writePayloadFile(1, {});
    written.push(a, b);
    assert.notEqual(a, b);
  });
});

describe("formatPostTrailer", () => {
  it("renders an XML-ish block that Claude can parse with one regex", () => {
    const trailer = formatPostTrailer({
      prepared: true,
      prNumber: 412,
      inlineCount: 3,
      summaryOnlyCount: 2,
      payloadPath: "/tmp/opencode-plugin-cc/post-pr-412-xyz.json",
      command: `gh api -X POST "repos/{owner}/{repo}/pulls/412/reviews" --input '/tmp/opencode-plugin-cc/post-pr-412-xyz.json'`,
      cleanup: `rm -f '/tmp/opencode-plugin-cc/post-pr-412-xyz.json'`,
    });
    assert.match(trailer, /<opencode_post_instructions>/);
    assert.match(trailer, /<\/opencode_post_instructions>/);
    assert.match(trailer, /<pr>412<\/pr>/);
    assert.match(trailer, /<inline_count>3<\/inline_count>/);
    assert.match(trailer, /<summary_only_count>2<\/summary_only_count>/);
    assert.match(trailer, /<payload_path>[^<]*post-pr-412-xyz\.json<\/payload_path>/);
    assert.match(trailer, /<command>gh api -X POST[^<]*<\/command>/);
    assert.match(trailer, /<cleanup>rm -f[^<]*<\/cleanup>/);
  });
});

describe("preparePostInstructions (with injected prData)", () => {
  const written = [];
  after(() => {
    for (const p of written) {
      try {
        fs.unlinkSync(p);
      } catch {
        // best-effort cleanup
      }
    }
  });

  const structured = {
    verdict: "needs-attention",
    summary: "Two issues.",
    findings: [
      {
        severity: "high",
        confidence: 0.92,
        title: "Race condition",
        file: "src/foo.js",
        line_start: 11,
        line_end: 11,
        body: "Two writers can observe stale state.",
        recommendation: "Hold the lock around the read-modify-write.",
      },
      {
        severity: "medium",
        confidence: 0.55,
        title: "Missing retries",
        file: "src/bar.js",
        line_start: 22,
        line_end: 22,
        body: "Downstream 5xx is not retried.",
        recommendation: "Wrap in exponential backoff.",
      },
    ],
  };

  const prData = {
    headSha: "cafef00d",
    files: [
      {
        filename: "src/foo.js",
        patch: "@@ -10,1 +10,2 @@\n a\n+b",
      },
    ],
  };

  it("builds a payload file and command, and bypasses gh entirely", async () => {
    const out = await preparePostInstructions("/nowhere", {
      prNumber: 412,
      structured,
      model: { providerID: "openrouter", modelID: "anthropic/claude-opus-4-6" },
      adversarial: true,
      confidenceThreshold: 0.8,
      prData,
    });
    assert.equal(out.prepared, true);
    written.push(out.payloadPath);

    // The command must be a `gh api -X POST ...` with the payload path
    // quoted. It must also contain the {owner}/{repo} placeholders so
    // gh resolves them from the current repo at execution time.
    assert.match(out.command, /^gh api -X POST "repos\/\{owner\}\/\{repo\}\/pulls\/412\/reviews" --input '/);
    assert.match(out.command, /\.json'$/);
    assert.match(out.cleanup, /^rm -f '/);

    // Classification: the high-confidence finding targets line 11
    // which is addressable (it's in the diff), so it becomes inline;
    // the medium-confidence finding has no diff coverage and stays
    // summary-only.
    assert.equal(out.inlineCount, 1);
    assert.equal(out.summaryOnlyCount, 1);

    const payload = JSON.parse(fs.readFileSync(out.payloadPath, "utf8"));
    assert.equal(payload.commit_id, "cafef00d");
    assert.equal(payload.event, "COMMENT");
    assert.ok(payload.body.includes("OpenCode Adversarial Review"));
    assert.ok(payload.body.includes("Needs attention"));
    assert.equal(payload.comments.length, 1);
    assert.equal(payload.comments[0].path, "src/foo.js");
    assert.equal(payload.comments[0].line, 11);
    assert.equal(payload.comments[0].side, "RIGHT");
    assert.match(payload.comments[0].body, /Race condition/);
    assert.match(payload.comments[0].body, /92%/);
  });

  it("returns { prepared: false, error } if prData fetch would fail", async () => {
    // We don't inject prData, so the module would try to call `gh pr
    // view` in `/definitely/not/a/repo` and fail. We only want to
    // verify the failure path wraps the error without throwing.
    const out = await preparePostInstructions("/definitely/not/a/repo", {
      prNumber: 1,
      structured,
      adversarial: false,
      confidenceThreshold: 0.8,
      // NOTE: `prData` intentionally omitted
    });
    // We can't assert the exact error message because it depends on
    // whether `gh` is installed on the host, but we know `prepared`
    // must be false.
    assert.equal(out.prepared, false);
    assert.ok(typeof out.error === "string" && out.error.length > 0);
  });

  it("handles structured=null by falling back to a rendered-text body", async () => {
    const out = await preparePostInstructions("/nowhere", {
      prNumber: 99,
      structured: null,
      rendered: "Raw review the model produced.",
      adversarial: false,
      confidenceThreshold: 0.8,
      prData: { headSha: "cafef00d", files: [] },
    });
    assert.equal(out.prepared, true);
    written.push(out.payloadPath);
    const payload = JSON.parse(fs.readFileSync(out.payloadPath, "utf8"));
    assert.ok(payload.body.includes("did not return structured JSON"));
    assert.ok(payload.body.includes("Raw review the model produced"));
    assert.deepEqual(payload.comments, []);
  });
});
