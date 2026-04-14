// Tests for the schema-aware review parser.
//
// The regression test below is pinned to the exact failure shape a
// real user hit on v1.0.10: an OpenCode review response that is
// structurally almost-valid JSON except for a `summary` field whose
// content contains an unescaped `"` (it embeds literal `{"success":
// false, "error": "..."}`). Strict JSON.parse bails, the companion
// used to fall through to printing raw text in the chat AND in the
// posted PR comment body, and the review looked like garbage.
//
// The fix is a lenient fallback that slices fields by schema anchors
// instead of re-tokenising the whole JSON. These tests lock in both
// the fast path (strict valid JSON) and the repair path.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  tryParseReview,
  sliceMatchingBracket,
} from "../plugins/opencode/scripts/lib/review-parser.mjs";

describe("tryParseReview — fast path (strict JSON)", () => {
  it("parses a well-formed review", () => {
    const out = tryParseReview(
      JSON.stringify({
        verdict: "needs-attention",
        summary: "Two issues to address.",
        findings: [
          {
            severity: "high",
            title: "Race",
            file: "a.js",
            line_start: 10,
            line_end: 10,
            confidence: 0.9,
            body: "b",
            recommendation: "r",
          },
        ],
      })
    );
    assert.ok(out);
    assert.equal(out.verdict, "needs-attention");
    assert.equal(out.summary, "Two issues to address.");
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].title, "Race");
  });

  it("parses JSON wrapped in a ```json fence", () => {
    const out = tryParseReview(
      [
        "Here is the review:",
        "```json",
        JSON.stringify({ verdict: "approve", summary: "ok", findings: [] }),
        "```",
        "",
      ].join("\n")
    );
    assert.ok(out);
    assert.equal(out.verdict, "approve");
    assert.equal(out.summary, "ok");
    assert.deepEqual(out.findings, []);
  });

  it("normalizes a valid object missing findings to an empty array", () => {
    const out = tryParseReview(
      JSON.stringify({ verdict: "approve", summary: "ok" })
    );
    assert.ok(out);
    assert.deepEqual(out.findings, []);
  });

  it("returns null for non-review JSON", () => {
    const out = tryParseReview(JSON.stringify({ random: "thing" }));
    assert.equal(out, null);
  });

  it("returns null for non-string input", () => {
    assert.equal(tryParseReview(null), null);
    assert.equal(tryParseReview(undefined), null);
    assert.equal(tryParseReview({}), null);
  });

  it("returns null for empty text", () => {
    assert.equal(tryParseReview(""), null);
    assert.equal(tryParseReview("   \n  "), null);
  });
});

describe("tryParseReview — lenient fallback (the regression)", () => {
  it("recovers a review whose summary contains unescaped inner quotes", () => {
    // This is almost verbatim what the user's OpenCode model produced
    // on PR #412: a `summary` that contains `{"success": false, ...}`
    // as literal text with unescaped `"` characters. Strict JSON.parse
    // dies at the first `"success"` because it thinks the string ended
    // there.
    const broken = [
      "{",
      '  "verdict": "approve",',
      '  "summary": "Change correctly closes the silent-failure gap for',
      "    entity-ID field omission in execute_sequence. The 8 validated",
      "    actions (whisper, kill_pebble, harvest_bush, gather_resource,",
      "    destroy_structure, advance_construction, add_town_hall_xp,",
      "    grow_settlement_bedrock) all now return explicit",
      '    {"success": false, "error": "..."} instead of dispatching with',
      "    ID 0 into downstream validators. The validation pattern is",
      "    consistent and the stopping behavior under stop_on_failure is",
      '    verified. No material findings from this review.",',
      '  "findings": []',
      "}",
    ].join("\n");

    // Sanity check: the strict path must actually fail on this input.
    // If upstream Node ever made JSON.parse lenient, this whole test
    // category would be a no-op.
    assert.throws(() => JSON.parse(broken));

    const out = tryParseReview(broken);
    assert.ok(out, "lenient fallback must recover a review object");
    assert.equal(out.verdict, "approve");
    assert.match(out.summary, /silent-failure gap/);
    assert.match(out.summary, /\{"success": false/);
    assert.match(out.summary, /no material findings from this review/i);
    assert.deepEqual(out.findings, []);
  });

  it("recovers verdict + summary even when findings is malformed", () => {
    const broken = [
      "{",
      '  "verdict": "needs-attention",',
      '  "summary": "Problem",',
      '  "findings": [ {this is not valid json} ]',
      "}",
    ].join("\n");

    assert.throws(() => JSON.parse(broken));
    const out = tryParseReview(broken);
    assert.ok(out);
    assert.equal(out.verdict, "needs-attention");
    assert.equal(out.summary, "Problem");
    // Findings failed to parse — better to show an empty array than
    // abandon the whole review.
    assert.deepEqual(out.findings, []);
  });

  it("slices summary up to the last '\"' before '}' when findings is absent", () => {
    const broken = [
      "{",
      '  "verdict": "approve",',
      '  "summary": "Summary with {"nested": "quotes"} and that is fine."',
      "}",
    ].join("\n");
    assert.throws(() => JSON.parse(broken));
    const out = tryParseReview(broken);
    assert.ok(out);
    assert.equal(out.verdict, "approve");
    assert.match(out.summary, /Summary with/);
    assert.match(out.summary, /\{"nested": "quotes"\}/);
  });

  it("returns null when verdict cannot be located", () => {
    const broken = '{ "totally": "unrelated" }';
    assert.equal(tryParseReview(broken), null);
  });
});

describe("sliceMatchingBracket", () => {
  it("returns the full array including outer brackets", () => {
    const text = 'noise [1, 2, 3] more noise';
    const openIdx = text.indexOf("[");
    assert.equal(sliceMatchingBracket(text, openIdx), "[1, 2, 3]");
  });

  it("respects nested brackets", () => {
    const text = "[[1, 2], [3, 4]]";
    assert.equal(sliceMatchingBracket(text, 0), "[[1, 2], [3, 4]]");
  });

  it("respects brackets inside string literals", () => {
    const text = '["a[b]c", "d]"]';
    assert.equal(sliceMatchingBracket(text, 0), '["a[b]c", "d]"]');
  });

  it("handles escaped quotes inside strings", () => {
    const text = '["a\\"b", "c"]';
    assert.equal(sliceMatchingBracket(text, 0), '["a\\"b", "c"]');
  });

  it("returns null when the opening bracket has no match", () => {
    assert.equal(sliceMatchingBracket("[1, 2, 3", 0), null);
  });

  it("returns null when given a non-bracket start char", () => {
    assert.equal(sliceMatchingBracket("abc", 0), null);
  });
});
