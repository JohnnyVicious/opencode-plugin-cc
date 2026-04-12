// Model-string parsing for OpenCode's HTTP API.
//
// The CLI accepts `--model <provider>/<model-id>` as a plain string
// (e.g. `openrouter/anthropic/claude-haiku-4.5`), but OpenCode's
// `POST /session/:id/message` endpoint rejects a string in the `model`
// field with HTTP 400:
//
//   {"error":[{"expected":"object","path":["model"],
//              "message":"Invalid input: expected object, received string"}]}
//
// It expects `{ providerID, modelID }` instead. This helper parses the
// CLI string into that shape. The first `/` splits provider from model
// id, so `openrouter/anthropic/claude-haiku-4.5` → providerID
// "openrouter", modelID "anthropic/claude-haiku-4.5". Any remaining
// slashes belong to the model id because providers frequently namespace
// their models (e.g. `anthropic/...`).
//
// (Apache License 2.0 §4(b) modification notice — see NOTICE.)

/**
 * Parse a `"provider/model-id"` CLI string into OpenCode's expected
 * `{providerID, modelID}` shape. Returns null for empty/invalid input
 * so callers can leave the model field unset and let OpenCode use the
 * user's configured default.
 *
 * @param {string|undefined|null} input
 * @returns {{ providerID: string, modelID: string } | null}
 */
export function parseModelString(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    // No provider prefix — opencode can't route this, so treat as invalid.
    return null;
  }

  const providerID = trimmed.slice(0, slash);
  const modelID = trimmed.slice(slash + 1);
  if (!providerID || !modelID) return null;

  return { providerID, modelID };
}
