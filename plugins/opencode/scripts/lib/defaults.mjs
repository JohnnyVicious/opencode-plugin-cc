// Persistent command-default helpers for the OpenCode companion.
//
// `/opencode:setup` can persist defaults in `state.config.defaults`.
// These helpers keep precedence rules centralized and testable:
// explicit runtime flags win, otherwise saved defaults apply.

import { parseModelString } from "./model.mjs";

const SUPPORTED_DEFAULT_AGENTS = new Set(["build", "plan"]);

/**
 * @param {Record<string, unknown>|undefined|null} options
 * @param {string} key
 * @returns {boolean}
 */
export function hasOwnOption(options, key) {
  return Object.prototype.hasOwnProperty.call(options ?? {}, key);
}

/**
 * Normalize persisted defaults read from state. Invalid or missing values are
 * ignored so a hand-edited state file cannot break every command invocation.
 * @param {unknown} raw
 * @returns {{ model: string | null, agent: string | null }}
 */
export function normalizeDefaults(raw) {
  const defaults = raw && typeof raw === "object" ? raw : {};

  const modelRaw = typeof defaults.model === "string" ? defaults.model.trim() : "";
  const model = modelRaw && parseModelString(modelRaw) ? modelRaw : null;

  const agentRaw = typeof defaults.agent === "string" ? defaults.agent.trim() : "";
  const agent = SUPPORTED_DEFAULT_AGENTS.has(agentRaw) ? agentRaw : null;

  return { model, agent };
}

/**
 * Parse a `/opencode:setup --default-model` value. Returns null for "off".
 * @param {unknown} value
 * @returns {string | null}
 */
export function parseDefaultModelSetting(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "off") return null;
  if (!raw || !parseModelString(raw)) {
    throw new Error(
      `--default-model must be "off" or a provider/model-id value ` +
        `(e.g. anthropic/claude-opus-4-6).`
    );
  }
  return raw;
}

/**
 * Parse a `/opencode:setup --default-agent` value. Returns null for "off".
 * @param {unknown} value
 * @returns {"build" | "plan" | null}
 */
export function parseDefaultAgentSetting(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "off") return null;
  if (!SUPPORTED_DEFAULT_AGENTS.has(raw)) {
    throw new Error(`--default-agent must be "build", "plan", or "off".`);
  }
  return raw;
}

/**
 * Apply a persisted model default when the user did not explicitly supply
 * either `--model` or `--free`.
 * @param {Record<string, unknown>} options
 * @param {{ model?: string | null }} defaults
 * @returns {Record<string, unknown>}
 */
export function applyDefaultModelOptions(options, defaults) {
  if (hasOwnOption(options, "model") || options?.free) return options;
  if (!defaults?.model) return options;
  return { ...options, model: defaults.model };
}

/**
 * Resolve the task agent using explicit CLI args first, then persisted
 * defaults, then the existing write/read-only fallback.
 * @param {Record<string, unknown>} options
 * @param {{ agent?: string | null }} defaults
 * @param {boolean} isWrite
 * @returns {string}
 */
export function resolveTaskAgentName(options, defaults, isWrite) {
  if (hasOwnOption(options, "agent")) return options.agent;
  if (defaults?.agent) return defaults.agent;
  return isWrite ? "build" : "plan";
}
