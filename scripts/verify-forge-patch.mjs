#!/usr/bin/env node
/**
 * Fail CI when patch-package did not apply @electron-forge/core overrides.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageApi = path.join(root, "node_modules/@electron-forge/core/dist/api/package.js");
const makeApi = path.join(root, "node_modules/@electron-forge/core/dist/api/make.js");

function readOrFail(file) {
  if (!fs.existsSync(file)) {
    console.error(`::error::Missing ${path.relative(root, file)}`);
    process.exit(1);
  }
  return fs.readFileSync(file, "utf8");
}

const pkg = readOrFail(packageApi);
const make = readOrFail(makeApi);

const checks = [
  [pkg, "packager output missing at", "package.js: output path verification"],
  [pkg, "await packagingRunner.run()", "package.js: await packaging listr run"],
  [pkg, "const packagingRunner = (0, tracer_1.delayTraceTillSignal)", "package.js: packaging listr runner"],
  [
    pkg,
    "process.platform !== 'win32' && Boolean(process.env.CI)",
    "package.js: no win32 CI listr fallback",
  ],
  [
    make,
    "process.platform === 'win32' && Boolean(process.env.CI)",
    "make.js: win32 CI listr fallback",
  ],
];

for (const [text, needle, label] of checks) {
  if (!text.includes(needle)) {
    console.error(`::error::Forge patch missing (${label})`);
    process.exit(1);
  }
}

console.log("OK: @electron-forge/core patch applied");
