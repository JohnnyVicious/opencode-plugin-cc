// Filesystem utilities for the OpenCode companion.

import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 50;

function isGitignored(filePath, cwd) {
  try {
    const result = fs.statSync(filePath);
    if (!result.isFile()) return false;
    const dir = path.dirname(filePath);
    const gitignorePath = path.join(dir, ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
      return isGitignored(dir, cwd);
    }
    const patterns = fs.readFileSync(gitignorePath, "utf8").split("\n");
    const relativePath = path.relative(cwd, filePath);
    for (const pattern of patterns) {
      const trimmed = pattern.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const glob = trimmed.replace(/\/$/, "");
      if (glob === relativePath || relativePath.startsWith(glob + "/")) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function isBinaryFile(filePath) {
  try {
    const buffer = Buffer.alloc(8192);
    const fd = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Collect file contents for a set of paths within cwd.
 * Respects per-file and total size caps, skips binary files and broken symlinks.
 *
 * @param {string} cwd - Working directory
 * @param {string[]} targetPaths - Relative paths to include
 * @param {{ maxBytes?: number, maxFiles?: number }} opts
 * @returns {Promise<{ content: string, files: string[], totalBytes: number, overflowed: boolean }>}
 */
export async function collectFolderContext(cwd, targetPaths, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : DEFAULT_MAX_BYTES;
  const maxFiles = Number.isFinite(opts.maxFiles) ? opts.maxFiles : DEFAULT_MAX_FILES;

  const result = {
    content: "",
    files: [],
    totalBytes: 0,
    overflowed: false,
  };

  const visited = new Set();

  for (const targetPath of targetPaths) {
    const resolvedPath = path.resolve(cwd, targetPath);

    if (!resolvedPath.startsWith(path.resolve(cwd))) {
      continue;
    }

    if (visited.has(resolvedPath)) continue;
    visited.add(resolvedPath);

    try {
      const stat = fs.lstatSync(resolvedPath);

      if (stat.isSymbolicLink()) {
        try {
          fs.statSync(resolvedPath);
        } catch {
          continue;
        }
      }

      if (stat.isDirectory()) {
        const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
        for (const entry of entries) {
          if (result.files.length >= maxFiles) break;
          const entryPath = path.join(resolvedPath, entry.name);
          if (visited.has(entryPath)) continue;
          visited.add(entryPath);
        }
      } else if (stat.isFile()) {
        if (isBinaryFile(resolvedPath)) continue;

        const relativePath = path.relative(cwd, resolvedPath);
        if (isGitignored(resolvedPath, cwd)) continue;

        const content = fs.readFileSync(resolvedPath, "utf8");
        const fileBytes = Buffer.byteLength(content, "utf8");

        if (result.totalBytes + fileBytes > maxBytes) {
          result.overflowed = true;
          const remaining = maxBytes - result.totalBytes;
          if (remaining > 0) {
            const truncated = truncateUtf8(content, remaining);
            result.content += `// File: ${relativePath} (truncated)\n${truncated}\n\n`;
            result.totalBytes += Buffer.byteLength(truncated, "utf8");
          }
          break;
        }

        result.content += `// File: ${relativePath}\n${content}\n\n`;
        result.totalBytes += fileBytes;
        result.files.push(relativePath);

        if (result.files.length >= maxFiles) {
          break;
        }
      }
    } catch (err) {
      if (err?.code !== "ENOENT") {
        // Skip files that don't exist
      }
    }
  }

  return result;
}

function truncateUtf8(text, maxBytes) {
  if (!text) return text;
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
}

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
