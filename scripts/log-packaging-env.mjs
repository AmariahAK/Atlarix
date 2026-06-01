#!/usr/bin/env node
/**
 * Emit runner context before electron-forge package/make (CI debugging).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const err = e;
    const stderr = err?.stderr?.toString?.() ?? "";
    const stdout = err?.stdout?.toString?.() ?? "";
    return `(failed) ${cmd}\n${stderr || stdout || err?.message || String(e)}`.trim();
  }
}

const root = process.cwd();
const outDir = path.join(root, "out");
const viteDir = path.join(root, ".vite");

console.log("=== Atlarix packaging environment ===");
console.log(`time: ${new Date().toISOString()}`);
console.log(`cwd: ${root}`);
console.log(`node: ${process.version} (${process.arch} ${process.platform})`);
console.log(`cpus: ${os.cpus().length} totalMemGiB: ${(os.totalmem() / 1024 ** 3).toFixed(1)} freeMemGiB: ${(os.freemem() / 1024 ** 3).toFixed(1)}`);

const envKeys = [
  "CI",
  "GITHUB_ACTIONS",
  "RUNNER_OS",
  "RUNNER_ARCH",
  "NODE_OPTIONS",
  "DEBUG",
  "ATLARIX_PACKAGING_DEBUG",
  "ATLARIX_WINDOWS_PACKAGING_DEBUG",
  "FORCE_COLOR",
];
for (const key of envKeys) {
  const v = process.env[key];
  console.log(`env.${key}=${v === undefined ? "(unset)" : v === "" ? "(empty)" : v}`);
}
if (process.env.DEBUG) {
  console.warn(
    "WARNING: DEBUG is set — electron-forge may use listr fallback and exit before packaging completes. Unset DEBUG during npm run make (see release.yml).",
  );
}

if (process.platform === "darwin") {
  const bytes = run("sysctl -n hw.memsize 2>/dev/null");
  if (bytes && !bytes.startsWith("(failed)")) {
    console.log(`memory: ${(Number(bytes) / 1024 ** 3).toFixed(1)} GiB RAM`);
  }
  console.log(`disk: ${run("df -h . | tail -1")}`);
} else if (process.platform === "linux") {
  console.log(`memory: ${run("free -h | head -2 | tr '\\n' ' | '")}`);
  console.log(`disk: ${run("df -h . | tail -1")}`);
} else if (process.platform === "win32") {
  console.log(`disk: ${run('powershell -NoProfile -Command "Get-PSDrive C | Select-Object Used,Free"')}`);
}

console.log(`out/ exists: ${fs.existsSync(outDir)}`);
if (fs.existsSync(outDir)) {
  console.log(`out/ entries: ${fs.readdirSync(outDir).join(", ") || "(empty)"}`);
}
console.log(`.vite/ exists: ${fs.existsSync(viteDir)}`);
if (fs.existsSync(viteDir)) {
  const buildDir = path.join(viteDir, "build");
  if (fs.existsSync(buildDir)) {
    console.log(`.vite/build files: ${fs.readdirSync(buildDir).length}`);
  }
}
console.log("=== end packaging environment ===");

if (
  process.platform === "win32" &&
  (process.env.ATLARIX_WINDOWS_PACKAGING_DEBUG === "1" ||
    process.env.GITHUB_ACTIONS === "true")
) {
  const { dumpFullWindowsPackagingState } = await import("./windows-packaging-debug.mjs");
  dumpFullWindowsPackagingState("log-packaging-env-after-summary");
}
