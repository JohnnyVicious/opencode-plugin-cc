// Filesystem utilities for the OpenCode companion.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 50;

function toGitPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isInsidePath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isGitignored(filePath, cwd) {
  try {
    const result = fs.statSync(filePath);
    if (!result.isFile()) return false;

    const relativePath = path.relative(cwd, filePath);
    if (!isInsidePath(cwd, filePath)) return false;

    const checked = spawnSync("git", ["check-ignore", "-q", "--", toGitPath(relativePath)], {
      cwd,
      stdio: "ignore",
    });
    return checked.status === 0;
  } catch {
    return false;
  }
}

function isBinaryFile(filePath) {
  let fd = null;
  try {
    const buffer = Buffer.alloc(8192);
    fd = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Collect file contents for a set of paths within cwd.
 * Respects per-file and total size caps, skips binary files and broken symlinks.
 *
 * @param {string} cwd - Working directory
 * @param {string[]} targetPaths - Relative paths to include
 * @param {{ maxBytes?: number, maxFiles?: number }} opts
 * @returns {Promise<{ content: string, files: string[], totalBytes: number, overflowed: boolean, overflowedBytes: boolean, overflowedFiles: boolean }>}
 */
export async function collectFolderContext(cwd, targetPaths, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : DEFAULT_MAX_BYTES;
  const maxFiles = Number.isFinite(opts.maxFiles) ? opts.maxFiles : DEFAULT_MAX_FILES;
  const root = path.resolve(cwd);
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = root;
  }

  const result = {
    content: "",
    files: [],
    totalBytes: 0,
    overflowed: false,
    overflowedBytes: false,
    overflowedFiles: false,
  };

  const visited = new Set();
  const pending = [];

  for (const targetPath of targetPaths) {
    const resolvedPath = path.resolve(cwd, targetPath);
    if (!isInsidePath(root, resolvedPath)) continue;
    pending.push(resolvedPath);
  }

  while (pending.length > 0) {
    if (result.files.length >= maxFiles) {
      result.overflowed = true;
      result.overflowedFiles = true;
      break;
    }

    const resolvedPath = pending.shift();

    try {
      const stat = fs.lstatSync(resolvedPath);
      let realPath = resolvedPath;

      if (stat.isSymbolicLink()) {
        try {
          realPath = fs.realpathSync(resolvedPath);
        } catch {
          continue;
        }
      } else {
        realPath = fs.realpathSync(resolvedPath);
      }

      if (!isInsidePath(realRoot, realPath)) continue;
      if (visited.has(realPath)) continue;
      visited.add(realPath);
      if (path.basename(realPath) === ".git") continue;

      const realStat = fs.statSync(realPath);
      if (realStat.isDirectory()) {
        const entries = fs.readdirSync(realPath, { withFileTypes: true })
          .sort((a, b) => a.name.localeCompare(b.name));
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          pending.unshift(path.join(realPath, entries[i].name));
        }
      } else if (realStat.isFile()) {
        if (isBinaryFile(realPath)) continue;

        const relativePath = path.relative(root, realPath);
        if (!isInsidePath(root, realPath)) continue;
        if (isGitignored(realPath, root)) continue;

        const content = fs.readFileSync(realPath, "utf8");
        const fileBytes = Buffer.byteLength(content, "utf8");

        if (result.totalBytes + fileBytes > maxBytes) {
          result.overflowed = true;
          result.overflowedBytes = true;
          const remaining = maxBytes - result.totalBytes;
          if (remaining > 0) {
            const truncated = truncateUtf8(content, remaining);
            result.content += `// File: ${toGitPath(relativePath)} (truncated)\n${truncated}\n\n`;
            result.totalBytes += Buffer.byteLength(truncated, "utf8");
            result.files.push(toGitPath(relativePath));
          }
          break;
        }

        result.content += `// File: ${toGitPath(relativePath)}\n${content}\n\n`;
        result.totalBytes += fileBytes;
        result.files.push(toGitPath(relativePath));

        if (result.files.length >= maxFiles) {
          if (pending.length > 0) {
            result.overflowed = true;
            result.overflowedFiles = true;
          }
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
