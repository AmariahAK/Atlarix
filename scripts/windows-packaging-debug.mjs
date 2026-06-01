#!/usr/bin/env node
/**
 * In-depth Windows packaging diagnostics (GHA windows-latest).
 * Safe to import from other scripts; CLI: dump-windows-packaging-state.mjs
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX = "[win-packaging-debug]";
const APP = "Atlarix";
const PLATFORM = "win32";
const ARCH = "x64";

export function isWindowsDeepDebug() {
  return (
    process.platform === "win32" &&
    (process.env.ATLARIX_WINDOWS_PACKAGING_DEBUG === "1" ||
      process.env.ATLARIX_PACKAGING_DEBUG === "1" ||
      process.env.GITHUB_ACTIONS === "true")
  );
}

function line(msg) {
  console.log(`${PREFIX} ${msg}`);
}

function section(title) {
  console.log("");
  console.log(`${PREFIX} ========== ${title} ==========`);
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeout ?? 60_000,
      maxBuffer: 4 * 1024 * 1024,
      shell: true,
      windowsHide: true,
      ...opts,
    }).trim();
  } catch (e) {
    const err = e;
    const stderr = err?.stderr?.toString?.() ?? "";
    const stdout = err?.stdout?.toString?.() ?? "";
    return `(failed exit=${err?.status ?? "?"})\n${cmd}\n${stderr || stdout || err?.message || String(e)}`.trim();
  }
}

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

function dirSizeBytes(target) {
  let total = 0;
  if (!fs.existsSync(target)) return 0;
  const st = fs.statSync(target);
  if (!st.isDirectory()) return st.size;
  const stack = [target];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      try {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) total += fs.statSync(full).size;
      } catch {
        /* skip */
      }
    }
  }
  return total;
}

/**
 * @param {string} root
 * @param {{ maxDepth?: number, maxFiles?: number, label?: string }} [opts]
 */
export function walkTree(root, opts = {}) {
  const maxDepth = opts.maxDepth ?? 4;
  const maxFiles = opts.maxFiles ?? 80;
  const lines = [];
  let fileCount = 0;

  function walk(dir, depth) {
    if (depth > maxDepth || fileCount >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      lines.push(`${"  ".repeat(depth)}(unreadable: ${e.message})`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (fileCount >= maxFiles) {
        lines.push(`${"  ".repeat(depth)}… (truncated at ${maxFiles} entries)`);
        return;
      }
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full) || ".";
      if (e.isDirectory()) {
        const size = dirSizeBytes(full);
        lines.push(`${"  ".repeat(depth)}${e.name}/  (${formatBytes(size)})`);
        fileCount++;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* ignore */
        }
        lines.push(`${"  ".repeat(depth)}${e.name}  (${formatBytes(size)})`);
        fileCount++;
      }
    }
  }

  if (!fs.existsSync(root)) {
    return [`(missing) ${root}`];
  }
  const rootSize = dirSizeBytes(root);
  lines.push(`${opts.label ?? "tree"}: ${root}  total=${formatBytes(rootSize)}`);
  walk(root, 0);
  return lines;
}

export function dumpHypothesisChecklist() {
  section("HYPOTHESIS CHECKLIST (what logs prove)");
  const checks = [
    ["Vite prePackage", ".vite/build/main.js exists"],
    ["Forge patch", "await packagingRunner.run + packagerPromise validation"],
    ["Listr win32+CI", "fallback renderer only on Windows when CI=true"],
    ["electron-packager started", 'log line "Packaging app for platform win32"'],
    ["packageAfterPrune ran", "[packageAfterPrune] start in logs"],
    ["out/ written", `out/${APP}-${PLATFORM}-${ARCH}/atlarix.exe`],
    ["Temp → out copy", "electron-packager temp has template; out/ populated"],
    ["Early exit 0", "forge exit 0 before out/ — listr or packager silent fail"],
  ];
  const root = process.cwd();
  const viteMain = path.join(root, ".vite", "build", "main.js");
  const packageDir = path.join(root, "out", `${APP}-${PLATFORM}-${ARCH}`);
  const exe = path.join(packageDir, "atlarix.exe");
  const state = {
    viteMain: fs.existsSync(viteMain),
    outDir: fs.existsSync(path.join(root, "out")),
    packageDir: fs.existsSync(packageDir),
    exe: fs.existsSync(exe),
    packagerTmp: fs.existsSync(path.join(root, ".cache", "packager-tmp", "electron-packager")),
  };
  for (const [name, criterion] of checks) {
    let status = "UNKNOWN (check logs)";
    if (name === "Vite prePackage") status = state.viteMain ? "OK" : "FAIL";
    if (name === "out/ written") status = state.exe ? "OK" : state.packageDir ? "PARTIAL" : "FAIL";
    if (name === "packageAfterPrune ran") status = "(see logs for [packageAfterPrune])";
    line(`${status.padEnd(8)} ${name} — ${criterion}`);
  }
}

export function dumpEnvironment() {
  section("ENVIRONMENT");
  line(`time=${new Date().toISOString()}`);
  line(`cwd=${process.cwd()}`);
  line(`node=${process.version} arch=${process.arch} platform=${process.platform}`);
  line(`cpus=${os.cpus().length} totalMem=${formatBytes(os.totalmem())} freeMem=${formatBytes(os.freemem())}`);
  const keys = [
    "CI",
    "GITHUB_ACTIONS",
    "GITHUB_RUN_ID",
    "GITHUB_JOB",
    "GITHUB_WORKSPACE",
    "RUNNER_OS",
    "RUNNER_TEMP",
    "NODE_OPTIONS",
    "TMP",
    "TEMP",
    "DEBUG",
    "ATLARIX_PACKAGING_DEBUG",
    "ATLARIX_WINDOWS_PACKAGING_DEBUG",
    "ELECTRON_CACHE",
  ];
  for (const k of keys) {
    const v = process.env[k];
    line(`env.${k}=${v === undefined ? "(unset)" : v === "" ? "(empty)" : v}`);
  }
  if (process.env.DEBUG?.includes("electron-forge:") && !process.env.DEBUG.includes("async-ora")) {
    line("NOTE: broad electron-forge DEBUG can change listr; prefer electron-packager:* and @electron-forge/core:*");
  }
}

export function dumpForgePatch() {
  section("FORGE PATCH");
  const root = process.cwd();
  const packageApi = path.join(root, "node_modules/@electron-forge/core/dist/api/package.js");
  const makeApi = path.join(root, "node_modules/@electron-forge/core/dist/api/make.js");
  for (const [name, file] of [
    ["package.js", packageApi],
    ["make.js", makeApi],
  ]) {
    if (!fs.existsSync(file)) {
      line(`${name}: MISSING`);
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    const needles = [
      "await packagingRunner.run()",
      "packager output missing at",
      "process.platform === 'win32' && Boolean(process.env.CI)",
      "ctx.packagerPromise = (0, packager_1.packager)",
    ];
    for (const n of needles) {
      line(`${name} ${text.includes(n) ? "OK" : "MISSING"}: ${n}`);
    }
  }
}

export function dumpDiskAndPaths() {
  section("DISK & PATHS");
  const root = process.cwd();
  line(
    `Get-PSDrive C | ${run("powershell -NoProfile -Command \"Get-PSDrive C | Format-List Used,Free\"")}`,
  );
  line(
    `longPathsEnabled | ${run("powershell -NoProfile -Command \"(Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled\"")}`,
  );
  const paths = [
    root,
    path.join(root, "out"),
    path.join(root, ".vite", "build"),
    path.join(root, ".cache", "packager-tmp"),
    path.join(root, ".cache", "packager-tmp", "electron-packager"),
    path.join(root, ".cache", "electron"),
    process.env.RUNNER_TEMP,
    process.env.RUNNER_TEMP ? path.join(process.env.RUNNER_TEMP, "electron-packager") : null,
    process.env.TMP,
    process.env.TEMP,
  ].filter(Boolean);
  for (const p of paths) {
    const exists = fs.existsSync(p);
    const size = exists ? formatBytes(dirSizeBytes(p)) : "n/a";
    line(`${exists ? "exists" : "MISSING"} ${size.padStart(10)}  ${p}`);
  }
}

export function dumpOutAndTempTrees() {
  section("out/ TREE");
  const root = process.cwd();
  for (const l of walkTree(path.join(root, "out"), { maxDepth: 4, maxFiles: 60, label: "out" })) {
    line(l);
  }
  section("workspace .cache/packager-tmp TREE");
  for (const l of walkTree(path.join(root, ".cache", "packager-tmp"), {
    maxDepth: 5,
    maxFiles: 80,
    label: "packager-tmp",
  })) {
    line(l);
  }
  const runnerTemp = process.env.RUNNER_TEMP;
  if (runnerTemp) {
    section("RUNNER_TEMP electron-packager TREE");
    for (const l of walkTree(path.join(runnerTemp, "electron-packager"), {
      maxDepth: 4,
      maxFiles: 40,
      label: "runner-temp-packager",
    })) {
      line(l);
    }
  }
}

export function dumpProcesses(extraPids = []) {
  section("NODE / FORGE PROCESSES");
  const ps = run(
    "powershell -NoProfile -Command \"Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|electron' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | Format-List\"",
  );
  for (const chunk of ps.split(/\r?\n/).slice(0, 120)) {
    if (chunk.trim()) line(chunk);
  }
  for (const pid of extraPids.filter(Boolean)) {
    const still = run(`tasklist /FI "PID eq ${pid}" /FO LIST`);
    line(`tasklist PID ${pid}:\n${still}`);
  }
}

/**
 * @param {string} label
 * @param {{ forgePid?: number, detail?: string, elapsedMs?: number }} [opts]
 */
export function dumpFullWindowsPackagingState(label, opts = {}) {
  if (process.platform !== "win32") {
    console.log(`${PREFIX} skip (not win32): ${label}`);
    return;
  }
  section(`SNAPSHOT: ${label}`);
  if (opts.detail) line(`detail=${opts.detail}`);
  if (opts.elapsedMs != null) line(`elapsed=${(opts.elapsedMs / 1000).toFixed(1)}s`);
  dumpEnvironment();
  dumpHypothesisChecklist();
  dumpForgePatch();
  dumpDiskAndPaths();
  dumpOutAndTempTrees();
  dumpProcesses(opts.forgePid != null ? [opts.forgePid] : []);
  section(`END SNAPSHOT: ${label}`);
}
