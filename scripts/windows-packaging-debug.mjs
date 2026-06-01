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

/** @param {string} [snapshotLabel] */
function inferSnapshotPhase(snapshotLabel = "") {
  const label = snapshotLabel.toLowerCase();
  if (/pre-clean|post-clean|pre-build|wrapper-start|log-packaging-env/.test(label)) {
    return "pre";
  }
  if (/post-package|post-build|post-make|wrapper-success|post-mortem/.test(label)) {
    return "post";
  }
  if (/wrapper-forge-exit|wrapper-waiting|wrapper-grace|wrapper-timeout/.test(label)) {
    return "mid";
  }
  return "unknown";
}

function fileProbe(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, size: 0, readable: false };
  }
  try {
    const st = fs.statSync(filePath);
    fs.accessSync(filePath, fs.constants.R_OK);
    return { exists: true, size: st.size, readable: true };
  } catch {
    return { exists: true, size: 0, readable: false };
  }
}

export function dumpViteBuildArtifacts() {
  section("VITE BUILD ARTIFACTS (packager inputs)");
  const root = process.cwd();
  const files = [
    [".vite/build/main.js", "main process bundle"],
    [".vite/build/preload.js", "preload bundle"],
    [".vite/build/renderer/main_window/index.html", "renderer entry"],
  ];
  for (const [rel, desc] of files) {
    const full = path.join(root, rel);
    const p = fileProbe(full);
    if (!p.exists) {
      line(`MISSING  ${rel}  (${desc})`);
      continue;
    }
    line(
      `${p.readable ? "OK" : "NO_READ"}  ${rel}  ${formatBytes(p.size)}  (${desc})`,
    );
  }
  const buildDir = path.join(root, ".vite", "build");
  if (fs.existsSync(buildDir)) {
    try {
      const names = fs.readdirSync(buildDir);
      line(`vite/build top-level (${names.length}): ${names.slice(0, 20).join(", ") || "(empty)"}`);
    } catch (e) {
      line(`cannot list .vite/build: ${e.message}`);
    }
  }
}

export function dumpPackageDirResolution() {
  section("PACKAGE DIR RESOLUTION (win-ci / verify)");
  const root = process.cwd();
  const packageDir = path.join(root, "out", `${APP}-${PLATFORM}-${ARCH}`);
  const exe = path.join(packageDir, "atlarix.exe");
  line(`process.cwd()=${root}`);
  line(`expected PACKAGE_DIR=${packageDir}`);
  line(`expected exe=${exe}`);
  line(`packageDir exists=${fs.existsSync(packageDir)}`);
  line(`atlarix.exe exists=${fs.existsSync(exe)}`);
  if (fs.existsSync(path.join(root, "out"))) {
    try {
      line(`out/ entries: ${fs.readdirSync(path.join(root, "out")).join(", ") || "(empty)"}`);
    } catch (e) {
      line(`out/ not listable: ${e.message}`);
    }
  }
}

export function dumpPackagerTempDetail() {
  section("PACKAGER TEMP DETAIL");
  const root = process.cwd();
  const ep = path.join(root, ".cache", "packager-tmp", "electron-packager");
  if (!fs.existsSync(ep)) {
    line(`(missing) ${ep}`);
    return;
  }
  let templates = [];
  try {
    templates = fs.readdirSync(ep).filter((n) => n.includes("template"));
  } catch (e) {
    line(`cannot read electron-packager dir: ${e.message}`);
    return;
  }
  if (templates.length === 0) {
    line(`no *template* dirs under ${ep}`);
    return;
  }
  for (const name of templates) {
    const full = path.join(ep, name);
    const size = formatBytes(dirSizeBytes(full));
    let children = "";
    try {
      const entries = fs.readdirSync(full);
      children = entries.slice(0, 12).join(", ");
      if (entries.length > 12) children += ` … +${entries.length - 12}`;
    } catch {
      children = "(unreadable)";
    }
    line(`template ${name}  size=${size}  children=[${children}]`);
  }
}

export function dumpOutWriteProbe() {
  section("out/ WRITE PROBE");
  const root = process.cwd();
  const outDir = path.join(root, "out");
  if (!fs.existsSync(outDir)) {
    line("out/ missing — skip write probe (packager has not created it yet)");
    return;
  }
  const probe = path.join(outDir, ".atlatrix-packaging-probe");
  try {
    fs.writeFileSync(probe, `probe ${new Date().toISOString()}\n`);
    fs.unlinkSync(probe);
    line(`OK wrote and deleted ${probe}`);
  } catch (e) {
    line(`FAIL write probe: ${e.message}`);
  }
}

/**
 * @param {string} [snapshotLabel]
 */
export function dumpHypothesisChecklist(snapshotLabel = "") {
  const phase = inferSnapshotPhase(snapshotLabel);
  section(`HYPOTHESIS CHECKLIST (phase=${phase}, label=${snapshotLabel || "?"})`);
  const root = process.cwd();
  const viteMain = path.join(root, ".vite", "build", "main.js");
  const packageDir = path.join(root, "out", `${APP}-${PLATFORM}-${ARCH}`);
  const exe = path.join(packageDir, "atlarix.exe");
  const state = {
    viteMain: fs.existsSync(viteMain),
    packageDir: fs.existsSync(packageDir),
    exe: fs.existsSync(exe),
    packagerTmp: fs.existsSync(path.join(root, ".cache", "packager-tmp", "electron-packager")),
  };

  const rows = [
    {
      name: "Vite prePackage",
      criterion: ".vite/build/main.js exists",
      eval: () => {
        if (phase === "pre") return "N/A     (before ci:package:win — expected missing)";
        return state.viteMain ? "OK" : "FAIL";
      },
    },
    {
      name: "out/ written",
      criterion: `out/${APP}-${PLATFORM}-${ARCH}/atlarix.exe`,
      eval: () => {
        if (phase === "pre") return "N/A     (before packaging — expected missing)";
        if (state.exe) return "OK";
        if (state.packageDir) return "PARTIAL (dir only)";
        return "FAIL";
      },
    },
    {
      name: "packageAfterPrune",
      criterion: "[packageAfterPrune] start in logs",
      eval: () =>
        phase === "pre"
          ? "N/A     (search logs after packager runs)"
          : "(grep logs — hook runs inside packager finalize)",
    },
    {
      name: "electron-packager temp",
      criterion: ".cache/packager-tmp/electron-packager populated",
      eval: () => {
        if (phase === "pre") return "N/A";
        return state.packagerTmp ? "OK" : "MISSING";
      },
    },
    {
      name: "Forge package.js patch",
      criterion: "await packagingRunner.run + output path checks",
      eval: () => "(see FORGE PATCH section — package.js only)",
    },
    {
      name: "Listr win32+CI",
      criterion: "fallback when CI=true on Windows",
      eval: () => (process.env.CI === "true" ? "active on GHA" : "off locally"),
    },
  ];

  for (const row of rows) {
    line(`${row.eval().padEnd(36)} ${row.name} — ${row.criterion}`);
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
  section("FORGE PATCH (ci:package uses package.js)");
  const root = process.cwd();
  const packageApi = path.join(root, "node_modules/@electron-forge/core/dist/api/package.js");
  const makeApi = path.join(root, "node_modules/@electron-forge/core/dist/api/make.js");
  const packageNeedles = [
    "await packagingRunner.run()",
    "packager output missing at",
    "process.platform === 'win32' && Boolean(process.env.CI)",
    "ctx.packagerPromise = (0, packager_1.packager)",
  ];
  if (!fs.existsSync(packageApi)) {
    line("package.js: MISSING");
  } else {
    const text = fs.readFileSync(packageApi, "utf8");
    for (const n of packageNeedles) {
      line(`package.js ${text.includes(n) ? "OK" : "MISSING"}: ${n}`);
    }
  }
  line("(make.js listr patch only — not used by electron-forge package; OK if MISSING below)");
  if (fs.existsSync(makeApi)) {
    const makeText = fs.readFileSync(makeApi, "utf8");
    line(
      `make.js win32 CI fallback: ${makeText.includes("process.platform === 'win32' && Boolean(process.env.CI)") ? "OK" : "MISSING"}`,
    );
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
  dumpHypothesisChecklist(label);
  dumpViteBuildArtifacts();
  dumpPackageDirResolution();
  dumpForgePatch();
  dumpDiskAndPaths();
  dumpPackagerTempDetail();
  dumpOutWriteProbe();
  dumpOutAndTempTrees();
  dumpProcesses(opts.forgePid != null ? [opts.forgePid] : []);
  section(`END SNAPSHOT: ${label}`);
}
