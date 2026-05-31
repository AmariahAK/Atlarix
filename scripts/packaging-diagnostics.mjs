#!/usr/bin/env node
/**
 * Packaging diagnostics for CI (especially windows-latest): memory + directory sizes.
 * Used from forge packageAfterPrune and ci-forge-package-windows.mjs.
 */
import fs from "node:fs";
import path from "node:path";

const PREFIX = "[packaging-diag]";

export function shouldLogPackagingDiagnostics() {
  return (
    process.env.ATLARIX_PACKAGING_DEBUG === "1" ||
    process.env.GITHUB_ACTIONS === "true"
  );
}

export function formatMemory() {
  const m = process.memoryUsage();
  const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `heapUsed=${mib(m.heapUsed)} heapTotal=${mib(m.heapTotal)} rss=${mib(m.rss)} external=${mib(m.external)}`;
}

/** @param {string} step @param {{ buildPath?: string, detail?: string }} [opts] */
export function logPackagingStep(step, opts = {}) {
  if (!shouldLogPackagingDiagnostics()) return;
  const parts = [`${PREFIX} ${step}`, formatMemory()];
  if (opts.buildPath) parts.push(`buildPath=${opts.buildPath}`);
  if (opts.detail) parts.push(opts.detail);
  console.log(parts.join(" | "));
}

/**
 * Recursive byte size (does not follow symlinks).
 * @param {string} target
 */
export function directorySizeBytes(target) {
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
        /* skip inaccessible */
      }
    }
  }
  return total;
}

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

/** @param {string} buildPath */
export function logBuildPathSizes(buildPath, label = "buildPath sizes") {
  if (!shouldLogPackagingDiagnostics()) return;
  const dirs = [
    buildPath,
    path.join(buildPath, ".vite"),
    path.join(buildPath, ".vite", "build"),
    path.join(buildPath, "node_modules"),
  ];
  const lines = [`${PREFIX} ${label} (${process.platform})`];
  for (const d of dirs) {
    const size = directorySizeBytes(d);
    const exists = fs.existsSync(d);
    lines.push(`  ${exists ? formatBytes(size) : "(missing)"}  ${d}`);
  }
  console.log(lines.join("\n"));
}

/**
 * Top-level node_modules package sizes (cross-platform; no `du`).
 * @param {string} buildPath
 * @param {number} [limit]
 */
export function logTopNodeModules(buildPath, limit = 20) {
  if (!shouldLogPackagingDiagnostics()) return;
  const nm = path.join(buildPath, "node_modules");
  if (!fs.existsSync(nm)) {
    console.log(`${PREFIX} node_modules missing at ${nm}`);
    return;
  }

  let names;
  try {
    names = fs.readdirSync(nm);
  } catch (err) {
    console.log(`${PREFIX} cannot read node_modules: ${err.message}`);
    return;
  }

  const sizes = [];
  for (const name of names) {
    const full = path.join(nm, name);
    try {
      sizes.push({ name, bytes: directorySizeBytes(full) });
    } catch {
      sizes.push({ name, bytes: 0 });
    }
  }
  sizes.sort((a, b) => b.bytes - a.bytes);
  const top = sizes.slice(0, limit);
  console.log(`${PREFIX} top node_modules (${top.length}/${names.length} packages):`);
  for (const { name, bytes } of top) {
    console.log(`  ${formatBytes(bytes).padStart(10)}  ${name}`);
  }
}

/** @param {string[]} packages */
export function logToInstallSummary(packages) {
  if (!shouldLogPackagingDiagnostics()) return;
  const preview = packages.slice(0, 40).join(", ");
  const more = packages.length > 40 ? ` … +${packages.length - 40} more` : "";
  console.log(`${PREFIX} toInstall count=${packages.length}: ${preview}${more}`);
}
