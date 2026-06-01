#!/usr/bin/env node
/**
 * Fail fast when Electron Forge did not produce expected output (CI release builds).
 *
 * Usage:
 *   node scripts/verify-ci-package-out.mjs --stage make --platform darwin --arch arm64
 *   node scripts/verify-ci-package-out.mjs --stage package --platform linux --arch x64
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

function runSafe(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "(unavailable)";
  }
}

function dumpPackagingDiagnostics(context) {
  const root = process.cwd();
  const outDir = path.join(root, "out");
  console.error("=== verify-ci-package-out diagnostics ===");
  console.error(`context: ${context}`);
  console.error(`cwd: ${root}`);
  console.error(`time: ${new Date().toISOString()}`);
  console.error(`node: ${process.version} ${process.arch} ${process.platform}`);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.error(`github.run_id: ${process.env.GITHUB_RUN_ID ?? "?"}`);
    console.error(`github.job: ${process.env.GITHUB_JOB ?? "?"}`);
  }
  console.error(`env.CI=${process.env.CI ?? "(unset)"}`);
  console.error(`env.ATLARIX_PACKAGING_DEBUG=${process.env.ATLARIX_PACKAGING_DEBUG ?? "(unset)"}`);
  console.error(`env.DEBUG=${process.env.DEBUG ?? "(unset)"}`);
  if (fs.existsSync(outDir)) {
    console.error(`out/ tree:\n${runSafe(`find "${outDir}" -maxdepth 3 -type d 2>/dev/null | head -40`)}`);
    console.error(`out/ files (max 30):\n${runSafe(`find "${outDir}" -type f 2>/dev/null | head -30`)}`);
  } else {
    console.error("out/ is missing entirely");
    console.error(
      `repo root entries: ${fs.readdirSync(root).filter((e) => !e.startsWith(".")).join(", ")}`,
    );
  }
  const viteBuild = path.join(root, ".vite", "build");
  console.error(`.vite/build exists: ${fs.existsSync(viteBuild)}`);
  if (process.platform === "win32") {
    const tempRoot = path.join(os.tmpdir(), "electron-packager");
    console.error(`temp ${tempRoot} exists: ${fs.existsSync(tempRoot)}`);
    if (fs.existsSync(tempRoot)) {
      try {
        const entries = fs.readdirSync(tempRoot);
        console.error(
          `electron-packager temp entries (max 15): ${entries.slice(0, 15).join(", ") || "(empty)"}`,
        );
      } catch {
        /* ignore */
      }
    }
  }
  console.error("=== end diagnostics ===");
}

function fail(msg, context) {
  dumpPackagingDiagnostics(context);
  console.error(`::error::${msg}`);
  process.exit(1);
}

const { stage, platform, arch } = parseArgs(process.argv);
const root = process.cwd();
const outDir = path.join(root, "out");
const appName = "Atlarix";

console.log(
  `[verify-ci-package-out] stage=${stage} platform=${platform} arch=${arch}`,
);

if (!fs.existsSync(outDir)) {
  fail(
    `Missing out/ after ${stage}. Search logs for [win-ci-build], [packageAfterPrune], or electron-forge Finalizing package.`,
    "missing-out-dir",
  );
}

const packageDir = path.join(outDir, `${appName}-${platform}-${arch}`);
if (!fs.existsSync(packageDir)) {
  const entries = fs.readdirSync(outDir);
  fail(
    `Missing packaged app at ${packageDir}. Found under out/: ${entries.join(", ") || "(empty)"}`,
    "missing-package-dir",
  );
}

if (platform === "darwin") {
  const appBundle = path.join(packageDir, `${appName}.app`);
  if (!fs.existsSync(appBundle)) {
    const entries = fs.readdirSync(packageDir);
    fail(
      `Missing ${appName}.app under ${packageDir}. Found: ${entries.join(", ") || "(empty)"}`,
      "missing-darwin-app-bundle",
    );
  }
}

if (stage === "make") {
  const makeDir = path.join(outDir, "make");
  if (!fs.existsSync(makeDir)) {
    fail(
      `Missing out/make after make (packaged dir exists at ${packageDir}). Makers did not run — check hook.postMake in logs.`,
      "missing-out-make",
    );
  }
  const files = listFilesRecursive(makeDir);
  if (files.length === 0) {
    fail("out/make exists but contains no distributable files", "empty-out-make");
  }
  console.log(`OK: ${files.length} file(s) under out/make`);
  for (const f of files.slice(0, 8)) {
    console.log(`  - ${path.relative(root, f)}`);
  }
  if (files.length > 8) console.log(`  ... and ${files.length - 8} more`);
}

console.log(`OK: packaged app at ${packageDir}`);
