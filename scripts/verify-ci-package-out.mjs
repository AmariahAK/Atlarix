#!/usr/bin/env node
/**
 * Fail fast when Electron Forge did not produce expected output (CI release builds).
 *
 * Usage:
 *   node scripts/verify-ci-package-out.mjs --stage make --platform darwin --arch arm64
 *   node scripts/verify-ci-package-out.mjs --stage package --platform linux --arch x64
 */
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const opts = { stage: "make", platform: process.platform, arch: process.arch };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--stage" && argv[i + 1]) opts.stage = argv[++i];
    else if (arg === "--platform" && argv[i + 1]) opts.platform = argv[++i];
    else if (arg === "--arch" && argv[i + 1]) opts.arch = argv[++i];
  }
  return opts;
}

function listFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

const { stage, platform, arch } = parseArgs(process.argv);
const root = process.cwd();
const outDir = path.join(root, "out");
const appName = "Atlarix";

if (!fs.existsSync(outDir)) {
  fail(
    `Missing out/ after ${stage}. electron-forge likely exited before packaging finished (check packageAfterPrune / OOM in logs).`,
  );
}

const packageDir = path.join(outDir, `${appName}-${platform}-${arch}`);
if (!fs.existsSync(packageDir)) {
  const entries = fs.readdirSync(outDir);
  fail(
    `Missing packaged app at ${packageDir}. Found under out/: ${entries.join(", ") || "(empty)"}`,
  );
}

if (platform === "darwin") {
  const appBundle = path.join(packageDir, `${appName}.app`);
  if (!fs.existsSync(appBundle)) {
    fail(`Missing ${appName}.app under ${packageDir}`);
  }
}

if (stage === "make") {
  const makeDir = path.join(outDir, "make");
  if (!fs.existsSync(makeDir)) {
    fail(
      `Missing out/make after make (packaged dir exists at ${packageDir}). Makers did not run.`,
    );
  }
  const files = listFilesRecursive(makeDir);
  if (files.length === 0) {
    fail("out/make exists but contains no distributable files");
  }
  console.log(`OK: ${files.length} file(s) under out/make`);
}

console.log(`OK: packaged app at ${packageDir}`);
