#!/usr/bin/env node
/**
 * Local dry-run of GitHub Actions release build (split package + installers + verify).
 *
 * Profiles:
 *   fixed   — CI flow: clean, ci:package, verify package, ci:installers, verify make
 *   broken  — old single `npm run make` with DEBUG + CI=""
 *
 * Usage:
 *   node scripts/simulate-ci-make.mjs [--profile=fixed|broken] [--arch=arm64|x64]
 *   node scripts/simulate-ci-make.mjs --verify-only [--arch=arm64]
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
  --profile=fixed|broken   Env shape (default: fixed = split package + installers)
  --arch=arm64|x64
  --platform=darwin|linux|win32
  --verify-only
`);
      process.exit(0);
    }
  }

  if (platform === "win32") {
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

function verify(env, stage, platform, arch) {
  return run(
    "node",
    [
      "scripts/verify-ci-package-out.mjs",
      "--stage",
      stage,
      "--platform",
      platform,
      "--arch",
      arch,
    ],
    env,
    `verify-ci-package-out (${stage})`,
  );
}

const { profile, arch, verifyOnly, platform } = parseArgs(process.argv);
const env = profileEnv(profile);

console.log("[simulate-ci-make] profile:", profile);
console.log("[simulate-ci-make] platform:", platform, "arch:", arch);

if (!verifyOnly) {
  if (profile === "broken") {
    const makeArgs =
      platform === "win32"
        ? ["run", "make"]
        : platform === "darwin"
          ? ["run", "make", "--", `--arch=${arch}`]
          : ["run", "make"];
    const makeExit = run("npm", makeArgs, env, "npm run make (broken CI simulate)");
    if (makeExit !== 0) process.exit(makeExit);
  } else {
    const archArgs =
      platform === "darwin" ? ["--", `--arch=${arch}`] : platform === "win32" ? [] : [];

    let exit = run("npm", ["run", "clean"], env, "npm run clean");
    if (exit !== 0) process.exit(exit);

    exit = run("npm", ["run", "ci:package", ...archArgs], env, "npm run ci:package");
    if (exit !== 0) process.exit(exit);

    exit = verify(env, "package", platform, arch);
    if (exit !== 0) process.exit(exit);

    exit = run(
      "npm",
      ["run", "ci:installers", ...archArgs],
      env,
      "npm run ci:installers",
    );
    if (exit !== 0) process.exit(exit);
  }
}

const verifyExit = verify(env, "make", platform, arch);
const outDir = path.join(process.cwd(), "out");
console.log(`\n[simulate-ci-make] out/ exists=${fs.existsSync(outDir)} verify exit=${verifyExit}`);

if (verifyExit === 0) {
  console.log("\n✓ Local CI simulation passed.");
} else {
  console.error("\n✗ Local CI simulation failed.");
}

process.exit(verifyExit);
