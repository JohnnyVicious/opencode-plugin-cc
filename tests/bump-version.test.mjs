// Integration tests for scripts/bump-version.mjs.
//
// Each test writes a complete fixture set of the four version-bearing
// manifests into a tmp directory and exercises bumpVersion / checkVersions
// against it. The script exports those functions so we can call them
// directly without spawning a node subprocess.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import {
  bumpVersion,
  checkVersions,
  readPackageVersion,
} from "../scripts/bump-version.mjs";

let tmpDir;

beforeEach(() => {
  tmpDir = createTmpDir("bump-version");
  writeFixture(tmpDir, "1.0.0");
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

function writeFixture(root, version) {
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@johnnyvicious/opencode-plugin-cc", version }, null, 2) + "\n"
  );

  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify(
      {
        name: "@johnnyvicious/opencode-plugin-cc",
        version,
        lockfileVersion: 3,
        packages: {
          "": { name: "@johnnyvicious/opencode-plugin-cc", version },
        },
      },
      null,
      2
    ) + "\n"
  );

  const pluginDir = path.join(root, "plugins", "opencode", ".claude-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({ name: "opencode", version }, null, 2) + "\n"
  );

  const marketplaceDir = path.join(root, ".claude-plugin");
  fs.mkdirSync(marketplaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(marketplaceDir, "marketplace.json"),
    JSON.stringify(
      {
        name: "johnnyvicious-opencode-plugin-cc",
        version,
        plugins: [{ name: "opencode", version }],
      },
      null,
      2
    ) + "\n"
  );
}

function readVersionField(root, file, jsonPath) {
  const data = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  return jsonPath.reduce((acc, key) => acc?.[key], data);
}

describe("bump-version: bumpVersion", () => {
  it("updates every version field across all four manifests", () => {
    const changed = bumpVersion(tmpDir, "1.0.1");

    assert.deepEqual(changed.sort(), [
      ".claude-plugin/marketplace.json",
      "package-lock.json",
      "package.json",
      "plugins/opencode/.claude-plugin/plugin.json",
    ]);

    assert.equal(readVersionField(tmpDir, "package.json", ["version"]), "1.0.1");
    assert.equal(readVersionField(tmpDir, "package-lock.json", ["version"]), "1.0.1");
    assert.equal(
      readVersionField(tmpDir, "package-lock.json", ["packages", "", "version"]),
      "1.0.1"
    );
    assert.equal(
      readVersionField(tmpDir, "plugins/opencode/.claude-plugin/plugin.json", ["version"]),
      "1.0.1"
    );
    assert.equal(
      readVersionField(tmpDir, ".claude-plugin/marketplace.json", ["version"]),
      "1.0.1"
    );
    // Marketplace plugin entry version
    const marketplaceJson = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".claude-plugin/marketplace.json"), "utf8")
    );
    assert.equal(marketplaceJson.plugins[0].version, "1.0.1");
  });

  it("supports prerelease and build metadata semver", () => {
    bumpVersion(tmpDir, "2.0.0-rc.1");
    assert.equal(readVersionField(tmpDir, "package.json", ["version"]), "2.0.0-rc.1");
  });

  it("rejects malformed version strings", () => {
    assert.throws(() => bumpVersion(tmpDir, "v1.0.1"), /semver-like/);
    assert.throws(() => bumpVersion(tmpDir, "1.0"), /semver-like/);
    assert.throws(() => bumpVersion(tmpDir, "latest"), /semver-like/);
  });
});

describe("bump-version: checkVersions", () => {
  it("returns no mismatches when all manifests agree with the expected version", () => {
    const mismatches = checkVersions(tmpDir, "1.0.0");
    assert.deepEqual(mismatches, []);
  });

  it("reports mismatches when a manifest is out of sync", () => {
    // Hand-corrupt plugin.json so it lags
    fs.writeFileSync(
      path.join(tmpDir, "plugins/opencode/.claude-plugin/plugin.json"),
      JSON.stringify({ name: "opencode", version: "0.9.9" }, null, 2) + "\n"
    );
    const mismatches = checkVersions(tmpDir, "1.0.0");
    assert.equal(mismatches.length, 1);
    assert.match(mismatches[0], /plugin\.json/);
    assert.match(mismatches[0], /expected 1\.0\.0, found 0\.9\.9/);
  });

  it("reports mismatches in marketplace plugin entry", () => {
    const file = path.join(tmpDir, ".claude-plugin/marketplace.json");
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    json.plugins[0].version = "0.5.0";
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");

    const mismatches = checkVersions(tmpDir, "1.0.0");
    assert.equal(mismatches.length, 1);
    assert.match(mismatches[0], /marketplace\.json plugins\[opencode\]\.version/);
  });

  it("returns no mismatches after a clean bump", () => {
    bumpVersion(tmpDir, "1.2.3");
    assert.deepEqual(checkVersions(tmpDir, "1.2.3"), []);
  });
});

describe("bump-version: readPackageVersion", () => {
  it("returns the version recorded in package.json", () => {
    assert.equal(readPackageVersion(tmpDir), "1.0.0");
  });

  it("throws if package.json's version field is malformed", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "x", version: "not-semver" }, null, 2)
    );
    assert.throws(() => readPackageVersion(tmpDir), /semver-like/);
  });
});
