#!/usr/bin/env node

// Safe slash-command bridge.
//
// Claude command files feed raw `$ARGUMENTS` to this script via a quoted
// heredoc. That keeps shell metacharacters as data instead of executable
// syntax. This script then validates and forwards only the supported argv
// shapes to opencode-companion.mjs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const companionScript = path.join(import.meta.dirname, "opencode-companion.mjs");

function main() {
  const subcommand = process.argv[2];
  const raw = fs.readFileSync(0, "utf8").trim();

  try {
    const args = buildForwardArgs(subcommand, raw);
    const result = spawnSync(process.execPath, [companionScript, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

// Only run the script body when invoked directly. Importing this file
// from a test module must not swallow stdin or exit the process.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

export function buildForwardArgs(command, text) {
  if (command === "status") {
    if (text) throw new Error("status does not accept arguments.");
    return ["status"];
  }

  if (command === "cancel" || command === "result") {
    if (!text) return [command];
    if (!/^[A-Za-z0-9._:-]+$/.test(text)) {
      throw new Error("Invalid job reference. Use a job ID or safe ID prefix.");
    }
    return [command, text];
  }

  if (command === "setup") {
    return ["setup", "--json", ...parseSetupArgs(text)];
  }

  if (command === "task") {
    return ["task", ...parseTaskArgs(text)];
  }

  throw new Error(`Unsupported safe command: ${command}`);
}

// Parse the rescue payload: a sequence of recognized `--flag [value]`
// tokens at the front, followed by opaque natural-language task text
// that can contain anything (apostrophes, quotes, shell metacharacters,
// newlines) and is forwarded verbatim as a single positional argument.
//
// We deliberately do NOT run splitShellLike across the whole payload
// because the task text is not shell syntax — an apostrophe like
// "what's broken" would throw "Unterminated quoted argument" under a
// shell-style tokenizer. Instead we peel off one flag token at a time
// from the front, stop at the first non-flag token, and treat the rest
// of the stdin blob as a literal string.
//
// Security model: stdin is already shell-insulated by the command
// file's single-quoted heredoc, so no byte in `text` can be executed
// as shell. This parser's only job is to:
//   1. Reject unknown flags so a malicious or buggy caller cannot smuggle
//      unsafe arguments through to opencode-companion.mjs.
//   2. Validate the values of value-flags (`--model`, `--agent`) against
//      strict character classes / allowlists.
//   3. Translate user-facing routing flags (`--resume`, `--wait`, `--fresh`)
//      into companion-native equivalents (or drop them when they are
//      documented no-ops).
function parseTaskArgs(text) {
  const out = [];
  let remaining = text;
  let sawModel = false;
  let sawFree = false;

  // Consume one whitespace-separated token from the front of `remaining`.
  // Returns [token, rest] or null when `remaining` is empty.
  function peelToken(source) {
    const m = source.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!m) return null;
    return [m[1], m[2] ?? ""];
  }

  while (remaining.length > 0) {
    const peeled = peelToken(remaining);
    if (!peeled) break;
    const [token, rest] = peeled;

    // --- Boolean flags forwarded as-is ---
    if (token === "--background" || token === "--worktree" || token === "--free") {
      if (token === "--free") sawFree = true;
      out.push(token);
      remaining = rest;
      continue;
    }

    // --- Documented no-ops / routing markers ---
    // --wait is a documented alias for "default foreground". The
    // companion has no --wait flag, so we drop it here.
    // --fresh means "do not add --resume-last", which at this layer is
    // also a no-op (we only emit --resume-last when --resume is present).
    if (token === "--wait" || token === "--fresh") {
      remaining = rest;
      continue;
    }

    // --- User-facing --resume → companion-native --resume-last ---
    if (token === "--resume" || token === "--resume-last") {
      out.push("--resume-last");
      remaining = rest;
      continue;
    }

    // --- Value flag: --model ---
    if (token === "--model") {
      const valuePeeled = peelToken(rest);
      if (!valuePeeled) throw new Error("--model requires a value.");
      const [value, afterValue] = valuePeeled;
      if (!/^[A-Za-z0-9._/:-]+$/.test(value)) {
        throw new Error(
          "--model value must match [A-Za-z0-9._/:-]+ (e.g. openrouter/anthropic/claude-haiku-4.5)."
        );
      }
      sawModel = true;
      out.push("--model", value);
      remaining = afterValue;
      continue;
    }

    // --- Value flag: --agent (only build|plan) ---
    if (token === "--agent") {
      const valuePeeled = peelToken(rest);
      if (!valuePeeled) throw new Error("--agent requires a value.");
      const [value, afterValue] = valuePeeled;
      if (value !== "build" && value !== "plan") {
        throw new Error("--agent value must be 'build' or 'plan'.");
      }
      out.push("--agent", value);
      remaining = afterValue;
      continue;
    }

    // Any other `--`-prefixed token is an unknown flag. Reject rather
    // than silently passing it through to opencode-companion.mjs.
    if (token.startsWith("--")) {
      throw new Error(`Unsupported rescue flag: ${token}`);
    }

    // First non-flag token encountered. Everything from here on — this
    // token PLUS the rest of the untokenized string — is the task text.
    break;
  }

  if (sawFree && sawModel) {
    throw new Error("--free and --model are mutually exclusive; pick one.");
  }

  const taskText = remaining.trim();
  if (taskText) out.push(taskText);

  return out;
}

function parseSetupArgs(text) {
  const tokens = splitShellLike(text);
  const out = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--json") {
      continue;
    }
    if (token === "--enable-review-gate" || token === "--disable-review-gate") {
      out.push(token);
      continue;
    }
    if (
      token === "--review-gate-max" ||
      token === "--review-gate-cooldown" ||
      token === "--default-model" ||
      token === "--default-agent"
    ) {
      const value = tokens[++i];
      if (value == null) {
        throw new Error(`${token} requires a value.`);
      }
      if (
        (token === "--review-gate-max" || token === "--review-gate-cooldown") &&
        value !== "off" &&
        !/^[1-9][0-9]*$/.test(value)
      ) {
        throw new Error(`${token} must be a positive integer or "off".`);
      }
      out.push(token, value);
      continue;
    }
    throw new Error(`Unsupported setup argument: ${token}`);
  }

  return out;
}

function splitShellLike(text) {
  const tokens = [];
  let current = "";
  let inToken = false;
  let quote = null;
  let escaping = false;

  for (const ch of text) {
    if (escaping) {
      current += ch;
      inToken = true;
      escaping = false;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      inToken = true;
      continue;
    }

    if (quote === "\"") {
      if (ch === "\"") {
        quote = null;
      } else if (ch === "\\") {
        escaping = true;
      } else {
        current += ch;
      }
      inToken = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }

    if (ch === "'" || ch === "\"") {
      quote = ch;
      inToken = true;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      inToken = true;
      continue;
    }

    current += ch;
    inToken = true;
  }

  if (escaping) current += "\\";
  if (quote) throw new Error("Unterminated quoted argument.");
  if (inToken) tokens.push(current);
  return tokens;
}
