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

const companionScript = path.join(import.meta.dirname, "opencode-companion.mjs");
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

function buildForwardArgs(command, text) {
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

  throw new Error(`Unsupported safe command: ${command}`);
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
    if (token === "--review-gate-max" || token === "--review-gate-cooldown") {
      const value = tokens[++i];
      if (value == null) {
        throw new Error(`${token} requires a value.`);
      }
      if (value !== "off" && !/^[1-9][0-9]*$/.test(value)) {
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
