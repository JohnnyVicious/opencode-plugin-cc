// Schema-aware parser for OpenCode review output.
//
// The review system prompt asks the model for a JSON object shaped
// like `{ verdict, summary, findings: [...] }`. Models frequently
// produce JSON that is structurally valid *except* for a string
// field (usually `summary` or a finding's `body`) that contains a
// literal `"` that should have been escaped `\"`.
//
// The common failure mode looks like this:
//
//     {
//       "verdict": "approve",
//       "summary": "... explicit {"success": false, "error": "..."} ...",
//       "findings": []
//     }
//
// `JSON.parse` bails at the first unescaped `"` inside `summary`, so
// `structured` comes back null and the companion falls through to
// printing the raw text. We then render ugly JSON in the chat AND in
// the posted PR comment — see issue report on v1.0.10.
//
// Fix strategy:
//   1. Try strict `JSON.parse` first (fast path).
//   2. If that fails, extract each top-level field by anchoring on its
//      key name. We slice `summary` between `"summary": "` and the
//      `", "findings": [...]` anchor that comes after it, so embedded
//      quotes never break the extraction.
//   3. For `findings`, do a depth-aware bracket walk that tracks
//      string state, and attempt to parse the extracted array. If
//      even that fails, return an empty findings array — we'd rather
//      show verdict + summary than give up entirely.
//
// This is NOT a general-purpose JSON repair library. It is narrowly
// tailored to the `{verdict, summary, findings}` review schema and
// assumes the model emits the fields in that order (which our prompt
// template encourages). Anything outside that schema falls through to
// `null` and the caller treats the output as unstructured.

/**
 * @typedef {{
 *   verdict: string,
 *   summary: string,
 *   findings: Array<object>,
 * }} Review
 */

/**
 * Try to parse `text` as an OpenCode review. Returns `null` when even
 * the lenient fallback can't recover the verdict, which is the minimum
 * the caller needs to render anything useful.
 *
 * @param {string} text
 * @returns {Review|null}
 */
export function tryParseReview(text) {
  if (typeof text !== "string") return null;
  const candidate = stripCodeFence(text).trim();
  if (!candidate) return null;

  // Fast path: strict JSON.parse.
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object") {
      return normalizeReview(parsed);
    }
  } catch {
    // fall through to lenient extraction
  }

  return lenientExtract(candidate);
}

/**
 * Strip a ```json … ``` code fence if present. Returns the inner
 * content, or the original text when there is no fence.
 */
function stripCodeFence(text) {
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(text);
  return fenced ? fenced[1] : text;
}

function normalizeReview(parsed) {
  const verdict = typeof parsed.verdict === "string" ? parsed.verdict : null;
  if (!verdict) return null;
  const summary = typeof parsed.summary === "string" ? parsed.summary : "";
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  return { verdict, summary, findings };
}

// ---------------------------------------------------------------------
// Lenient extraction
// ---------------------------------------------------------------------

/**
 * Schema-aware extractor used when strict JSON.parse fails. Walks
 * `text` looking for the three known top-level keys by name.
 *
 * @param {string} text
 * @returns {Review|null}
 */
function lenientExtract(text) {
  const verdict = extractVerdict(text);
  if (!verdict) return null;
  const summary = extractSummary(text) ?? "";
  const findings = extractFindings(text);
  return { verdict, summary, findings };
}

/**
 * Verdict values are from a closed vocabulary (`approve` or
 * `needs-attention`), so a plain regex is safe — there is no way for
 * a verdict value to itself contain a `"`.
 */
function extractVerdict(text) {
  const m = /"verdict"\s*:\s*"(approve|needs-attention)"/.exec(text);
  return m ? m[1] : null;
}

/**
 * Slice `summary` between `"summary": "` and the next occurrence of
 * the `", "findings"` anchor. Anything in between — including literal
 * unescaped `"` characters — is treated as part of the summary. When
 * the anchor isn't present we fall back to slicing to the last `"`
 * before the closing `}`, so summaries in malformed responses that
 * are missing the findings field still come through.
 */
function extractSummary(text) {
  const startKey = /"summary"\s*:\s*"/.exec(text);
  if (!startKey) return null;
  const sliceStart = startKey.index + startKey[0].length;

  // Preferred anchor: the `", "findings"` transition. The regex allows
  // whitespace / newlines between the closing quote and the next key.
  const endAnchor = /"\s*,\s*"findings"\s*:/g;
  endAnchor.lastIndex = sliceStart;
  const endMatch = endAnchor.exec(text);
  if (endMatch) {
    return text.substring(sliceStart, endMatch.index);
  }

  // Fallback: slice to the last `"` before the outermost closing `}`.
  const lastBrace = text.lastIndexOf("}");
  const searchEnd = lastBrace > sliceStart ? lastBrace : text.length;
  const lastQuote = text.lastIndexOf('"', searchEnd);
  if (lastQuote > sliceStart) {
    return text.substring(sliceStart, lastQuote);
  }
  return null;
}

/**
 * Extract the `findings` array. Uses a depth-aware walker that tracks
 * JSON string state so brackets inside string literals don't confuse
 * the bracket counter. If the extracted slice fails strict JSON.parse
 * we return an empty array — we'd rather show the verdict + summary
 * than nothing at all.
 */
function extractFindings(text) {
  const startKey = /"findings"\s*:\s*\[/.exec(text);
  if (!startKey) return [];
  const arrayStart = startKey.index + startKey[0].length - 1; // points at `[`
  const arrayText = sliceMatchingBracket(text, arrayStart);
  if (!arrayText) return [];
  try {
    const parsed = JSON.parse(arrayText);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Walk `text` starting at `openIdx` (which must point at a `[` or
 * `{`) and return the substring up to and including the matching
 * closing bracket, or `null` if no match is found. Tracks JSON string
 * state so brackets inside strings don't affect the depth counter.
 *
 * Exported for tests.
 *
 * @param {string} text
 * @param {number} openIdx
 * @returns {string|null}
 */
export function sliceMatchingBracket(text, openIdx) {
  const open = text[openIdx];
  if (open !== "[" && open !== "{") return null;
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (inString) {
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return text.substring(openIdx, i + 1);
      }
    }
  }
  return null;
}
