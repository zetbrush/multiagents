#!/usr/bin/env bun
/**
 * SemVer version bumper.
 *
 * Usage:
 *   bun run scripts/version.ts patch   # 0.1.0 → 0.1.1
 *   bun run scripts/version.ts minor   # 0.1.0 → 0.2.0
 *   bun run scripts/version.ts major   # 0.1.0 → 1.0.0
 *
 * What it does:
 *   1. Bumps version in package.json
 *   2. Stages package.json
 *   3. Creates a git commit: "release: vX.Y.Z"
 *   4. Creates a git tag: vX.Y.Z
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const PKG_PATH = path.join(ROOT, "package.json");

type BumpType = "patch" | "minor" | "major";

const bump = process.argv[2] as BumpType;
if (!["patch", "minor", "major"].includes(bump)) {
  console.error("Usage: bun run scripts/version.ts <patch|minor|major>");
  process.exit(1);
}

// Read current version
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf-8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);

// Compute new version
let newVersion: string;
switch (bump) {
  case "major":
    newVersion = `${major + 1}.0.0`;
    break;
  case "minor":
    newVersion = `${major}.${minor + 1}.0`;
    break;
  case "patch":
    newVersion = `${major}.${minor}.${patch + 1}`;
    break;
}

// Write
pkg.version = newVersion;
fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");

console.log(`${pkg.version.replace(newVersion, `${major}.${minor}.${patch}`)} → ${newVersion}`);

// Git commit + tag
const tag = `v${newVersion}`;
Bun.spawnSync(["git", "add", "package.json"], { cwd: ROOT });
Bun.spawnSync(["git", "commit", "-m", `release: ${tag}`], { cwd: ROOT });
Bun.spawnSync(["git", "tag", "-a", tag, "-m", `Release ${tag}`], { cwd: ROOT });

console.log(`Committed and tagged: ${tag}`);
console.log(`To publish: git push && git push --tags && bun publish`);
