#!/usr/bin/env node
/**
 * Fail CI when package-lock.json contains private-registry resolved URLs
 * (e.g. AWS CodeArtifact from a developer ~/.npmrc).
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const lockPath = path.join(root, "package-lock.json");

const FORBIDDEN = [
  /codeartifact/i,
  /amazonaws\.com\/npm/i,
  /spacinsider-\d+\.d\.codeartifact/i,
  /702187899404/,
];

const ALLOWED_RESOLVED_PREFIXES = [
  "https://registry.npmjs.org/",
  "git+ssh://git@github.com/electron/node-gyp.git#",
];

if (!fs.existsSync(lockPath)) {
  console.error(`::error::Missing ${path.relative(root, lockPath)}`);
  process.exit(1);
}

const text = fs.readFileSync(lockPath, "utf8");
const resolvedRe = /"resolved":\s*"([^"]+)"/g;
const bad = [];
const unknown = [];

for (const match of text.matchAll(resolvedRe)) {
  const url = match[1];
  if (FORBIDDEN.some((re) => re.test(url))) {
    bad.push(url);
    continue;
  }
  if (!ALLOWED_RESOLVED_PREFIXES.some((p) => url.startsWith(p))) {
    unknown.push(url);
  }
}

if (bad.length > 0) {
  console.error(
    "::error::package-lock.json contains private-registry tarball URLs (CodeArtifact / work npm).",
  );
  console.error(
    "Regenerate the lockfile with the public registry only: ensure Atlarix/.npmrc is present,",
  );
  console.error("fix ~/.npmrc if needed, then: rm -rf node_modules && npm ci");
  console.error("Do not commit work CodeArtifact resolved URLs.");
  for (const url of bad.slice(0, 10)) {
    console.error(`  - ${url}`);
  }
  if (bad.length > 10) {
    console.error(`  ... and ${bad.length - 10} more`);
  }
  process.exit(1);
}

if (unknown.length > 0) {
  console.error(
    "::error::package-lock.json has unexpected resolved URLs (not registry.npmjs.org or allowed git deps).",
  );
  for (const url of unknown.slice(0, 10)) {
    console.error(`  - ${url}`);
  }
  if (unknown.length > 10) {
    console.error(`  ... and ${unknown.length - 10} more`);
  }
  process.exit(1);
}

console.log(
  `verify-npm-lock-registry: OK (${[...text.matchAll(resolvedRe)].length} resolved entries)`,
);
