// Model helpers for OpenCode's HTTP API.
//
// Two concerns live here:
//
// 1. CLI model-string parsing. The CLI accepts `--model
//    <provider>/<model-id>` as a plain string (e.g.
//    `openrouter/anthropic/claude-haiku-4.5`), but OpenCode's
//    `POST /session/:id/message` endpoint rejects a string in the
//    `model` field with HTTP 400:
//
//      {"error":[{"expected":"object","path":["model"],
//                 "message":"Invalid input: expected object, received string"}]}
//
//    It expects `{ providerID, modelID }` instead. `parseModelString`
//    converts at the CLI boundary. The first `/` splits provider from
//    model id, so `openrouter/anthropic/claude-haiku-4.5` → providerID
//    "openrouter", modelID "anthropic/claude-haiku-4.5".
//
// 2. `--free` flag support. `listOpencodeModels` shells out to
//    `opencode models` (one `provider/model-id` per line) and
//    `selectFreeModel` filters for the `:free` or `-free` suffix and
//    picks one at random. Both helpers take dependency-injected
//    hooks (`run`, `rng`) so tests don't need a real opencode binary.
//
// (Apache License 2.0 §4(b) modification notice — see NOTICE.)

import { runCommand } from "./process.mjs";

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

/**
 * Regex matching OpenCode's free-tier model suffixes. `:free` is the
 * OpenRouter convention, `-free` is the opencode/* convention.
 */
const FREE_MODEL_SUFFIX = /(?::free|-free)$/i;

/**
 * Regex restricting `--free` picks to the first-party `opencode/*`
 * provider. OpenRouter's `:free` models have highly variable tool-use
 * support (many route to endpoints that return
 * `No endpoints found that support tool use`), which breaks the
 * review agent since it needs read/grep/glob/list. First-party
 * `opencode/*` models always support tool use, so restricting `--free`
 * to that provider makes the flag reliable by default. Users who need
 * a specific non-opencode model can still use `--model <id>`.
 */
const OPENCODE_PROVIDER = /^opencode\//i;

/**
 * Shell out to `opencode models` and return the raw newline-separated
 * list of `provider/model-id` strings. Blank lines and whitespace are
 * discarded; no filtering is applied here.
 *
 * @param {object} [opts]
 * @param {(cmd: string, args: string[]) => Promise<{ stdout: string, stderr: string, exitCode: number }>} [opts.run]
 *   Dependency-injected command runner — defaults to `runCommand` from
 *   lib/process.mjs. Tests override this to avoid needing a real
 *   opencode binary.
 * @returns {Promise<string[]>}
 */
export async function listOpencodeModels({ run = runCommand } = {}) {
  const result = await run("opencode", ["models"]);
  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim() || `exit code ${result.exitCode}`;
    throw new Error(`\`opencode models\` failed: ${detail}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Pick a free-tier model at random from `opencode models`. Restricts
 * the pool to the first-party `opencode/*` provider so the chosen
 * model always supports tool use (see `OPENCODE_PROVIDER` above for
 * the rationale). Returns the usual `{providerID, modelID, raw}`
 * triple so callers can pass it to `sendPrompt` and log the raw form.
 *
 * Throws a descriptive error if the user has no `opencode/*` free
 * models available, so `--free` invocations fail loudly instead of
 * silently falling back to a paid default.
 *
 * @param {object} [opts]
 * @param {() => number} [opts.rng] - deterministic rng for tests, default Math.random
 * @param {(cmd: string, args: string[]) => Promise<any>} [opts.run] - runCommand override for tests
 * @returns {Promise<{ providerID: string, modelID: string, raw: string }>}
 */
export async function selectFreeModel({ rng = Math.random, run } = {}) {
  const models = await listOpencodeModels(run ? { run } : {});
  const free = models.filter(
    (m) => FREE_MODEL_SUFFIX.test(m) && OPENCODE_PROVIDER.test(m),
  );

  if (free.length === 0) {
    throw new Error(
      "`--free` was requested, but `opencode models` returned no first-party " +
      "`opencode/*` free-tier models. `--free` is restricted to opencode-native " +
      "models because OpenRouter free-tier models have inconsistent tool-use " +
      "support. Use `--model <id>` to target a specific free model on another " +
      "provider, or run `/opencode:setup` to configure the opencode provider."
    );
  }

  const idx = Math.floor(rng() * free.length);
  const raw = free[Math.min(idx, free.length - 1)];
  const parsed = parseModelString(raw);
  if (!parsed) {
    // Shouldn't happen — `opencode models` output is always provider/...
    throw new Error(`Unable to parse free model string: ${raw}`);
  }
  return { ...parsed, raw };
}
