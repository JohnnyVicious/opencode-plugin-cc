// Filesystem utilities for the OpenCode companion.

import fs from "node:fs";
import path from "node:path";

/**
 * Ensure a directory exists (recursive mkdir).
 * @param {string} dirPath
 */
export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Read a JSON file, returning null on failure.
 * @param {string} filePath
 * @returns {any|null}
 */
export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write a JSON file atomically (write to tmp then rename).
 * @param {string} filePath
 * @param {any} data
 */
export function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

/**
 * Append a line to a file.
 * @param {string} filePath
 * @param {string} line
 */
export function appendLine(filePath, line) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, line + "\n", "utf8");
}

/**
 * Read the last N lines of a file.
 * @param {string} filePath
 * @param {number} n
 * @returns {string[]}
 */
export function tailLines(filePath, n = 10) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    const nonEmpty = lines.filter((line) => line.length > 0);
    return nonEmpty.slice(-n);
  } catch {
    return [];
  }
}

/**
 * Read Claude Code project-level deny rules from .claude/settings.json.
 * Returns an array of {path, read, edit} deny entries found, if any.
 * @param {string} cwd
 * @returns {{ path: string, read?: boolean, edit?: boolean }[]}
 */
export function readDenyRules(cwd) {
  try {
    const settingsPath = path.join(cwd, ".claude", "settings.json");
    const data = readJson(settingsPath);
    if (!data || typeof data !== "object") return [];
    const deny = data.deny ?? data.permission?.deny;
    if (!Array.isArray(deny)) return [];
    return deny.filter(
      (rule) =>
        rule &&
        typeof rule === "object" &&
        typeof rule.path === "string"
    );
  } catch {
    return [];
  }
}

/**
 * Check if any deny rules apply to a given path.
 * @param {{ path: string, read?: boolean, edit?: boolean }[]} rules
 * @param {string} targetPath
 * @returns {boolean}
 */
export function denyRulesApplyToPath(rules, targetPath) {
  if (!rules || rules.length === 0) return false;
  for (const rule of rules) {
    if (rule.path === targetPath) return true;
    if (targetPath.startsWith(rule.path + path.sep)) return true;
  }
  return false;
}
