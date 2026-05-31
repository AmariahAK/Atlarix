#!/usr/bin/env node
/**
 * Local dry-run of GitHub Actions release build steps (make + verify).
 *
 * Profiles:
 *   fixed   — proposed CI after fix (v9.0.0-style: no DEBUG, GHA-like CI=true)
 *   broken  — current failing CI (DEBUG + CI="")
 *
 * Usage:
 *   node scripts/simulate-ci-make.mjs [--profile=fixed|broken] [--arch=arm64|x64]
 *   node scripts/simulate-ci-make.mjs --verify-only [--arch=arm64]
 *
 * Examples:
 *   npm run make:ci-simulate
 *   npm run make:ci-simulate -- --profile=broken --arch=arm64
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  let profile = "fixed";
  let arch = process.arch === "arm64" ? "arm64" : "x64";
  let verifyOnly = false;
  let platform = process.platform;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--profile=")) profile = arg.split("=")[1];
    else if (arg === "--profile" && argv[i + 1]) profile = argv[++i];
    else if (arg.startsWith("--arch=")) arch = arg.split("=")[1];
    else if (arg === "--arch" && argv[i + 1]) arch = argv[++i];
    else if (arg.startsWith("--platform=")) platform = arg.split("=")[1];
    else if (arg === "--platform" && argv[i + 1]) platform = argv[++i];
    else if (arg === "--verify-only") verifyOnly = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/simulate-ci-make.mjs [options]

Options:
  --profile=fixed|broken   Env shape to simulate (default: fixed)
  --arch=arm64|x64         Target arch (default: host arch)
  --platform=darwin|linux|win32
  --verify-only            Skip make; only run verify-ci-package-out.mjs
  --help

Profiles:
  fixed   NODE_OPTIONS=4096, CI=true, GITHUB_ACTIONS=true, no DEBUG
  broken  NODE_OPTIONS=4096, CI="", DEBUG=electron-forge:*,electron-packager
`);
      process.exit(0);
    }
  }

  if (platform === "win32") {
    // CI windows job does not pass --arch
    return { profile, arch: "x64", verifyOnly, platform };
  }

  return { profile, arch, verifyOnly, platform };
}

function profileEnv(profile) {
  const base = {
    ...process.env,
    NODE_OPTIONS: "--max-old-space-size=4096",
    FORCE_COLOR: "1",
  };

  if (profile === "broken") {
    return {
      ...base,
      CI: "",
      DEBUG: "electron-forge:*,electron-packager",
    };
  }

  // fixed — matches GitHub Actions default + proposed release.yml (no DEBUG)
  return {
    ...base,
    CI: "true",
    GITHUB_ACTIONS: "true",
    DEBUG: undefined,
  };
}

function run(cmd, args, env, label) {
  console.log(`\n=== ${label} ===`);
  console.log(`$ ${cmd} ${args.join(" ")}`);
  console.log(
    `env: CI=${env.CI ?? "(unset)"} GITHUB_ACTIONS=${env.GITHUB_ACTIONS ?? "(unset)"} DEBUG=${env.DEBUG ?? "(unset)"} NODE_OPTIONS=${env.NODE_OPTIONS ?? "(unset)"}`,
  );
  const started = Date.now();
  const result = spawnSync(cmd, args, {
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  const elapsed = Math.round((Date.now() - started) / 1000);
  console.log(`=== ${label} finished in ${elapsed}s exit=${result.status ?? 1} ===`);
  return result.status ?? 1;
}

const { profile, arch, verifyOnly, platform } = parseArgs(process.argv);
const env = profileEnv(profile);

console.log("[simulate-ci-make] profile:", profile);
console.log("[simulate-ci-make] platform:", platform, "arch:", arch);

if (!verifyOnly) {
  const makeArgs =
    platform === "win32"
      ? ["run", "make"]
      : platform === "darwin"
        ? ["run", "make", "--", `--arch=${arch}`]
        : ["run", "make"];

  const makeExit = run("npm", makeArgs, env, "npm run make (CI simulate)");
  if (makeExit !== 0) {
    console.error(`[simulate-ci-make] make failed exit=${makeExit}`);
    process.exit(makeExit);
  }
}

const verifyExit = run(
  "node",
  [
    "scripts/verify-ci-package-out.mjs",
    "--stage",
    "make",
    "--platform",
    platform,
    "--arch",
    arch,
  ],
  env,
  "verify-ci-package-out",
);

const outDir = path.join(process.cwd(), "out");
console.log(`\n[simulate-ci-make] out/ exists=${fs.existsSync(outDir)} verify exit=${verifyExit}`);

if (verifyExit === 0) {
  console.log("\n✓ Local CI simulation passed — safe to apply release.yml fix and push.");
} else {
  console.error("\n✗ Local CI simulation failed — do not tag/push until this passes.");
}

process.exit(verifyExit);
