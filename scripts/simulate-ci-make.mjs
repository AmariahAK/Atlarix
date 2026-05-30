#!/usr/bin/env node
/**
 * Local CI packaging repro: same env shape as GitHub Actions (without verify wrapper).
 * Usage: node scripts/simulate-ci-make.mjs [--arch arm64|x64]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const archArg = process.argv.find((a) => a.startsWith("--arch="));
const arch = archArg?.split("=")[1] ?? process.arch;

const env = {
  ...process.env,
  CI: "true",
  GITHUB_ACTIONS: "true",
  FORCE_COLOR: "1",
  NODE_OPTIONS: "--max-old-space-size=4096",
};

const args = ["run", "make", "--", `--arch=${arch}`];
console.log("[simulate-ci-make] npm", args.join(" "));
console.log("[simulate-ci-make] env.CI=", env.CI, "NODE_OPTIONS=", env.NODE_OPTIONS);

const child = spawn("npm", args, {
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("close", (code) => {
  const outDir = path.join(process.cwd(), "out");
  const exists = fs.existsSync(outDir);
  console.log(`[simulate-ci-make] exit=${code} out/ exists=${exists}`);
  process.exit(code ?? 1);
});
