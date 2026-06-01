/**
 * Detailed @electron/packager instrumentation for Windows CI.
 * Tracks phases, temp-dir growth (staging tmp-* / resources/app), and source stats.
 */
import fs from "node:fs";
import path from "node:path";
import { formatMemory } from "./packaging-diagnostics.mjs";

export const PREFIX_PHASE = "[win-packager-phase]";
export const PREFIX_SNAPSHOT = "[win-packager-snapshot]";
export const PREFIX_HEARTBEAT = "[win-packager-heartbeat]";

const DEFAULT_MAX_FILES = 80_000;

/**
 * @param {number} n
 */
export function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

/**
 * Bounded directory walk: bytes, file count, dir count, truncated flag.
 * @param {string} target
 * @param {{ maxFiles?: number }} [opts]
 */
export function directoryStats(target, opts = {}) {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const started = Date.now();
  let bytes = 0;
  let files = 0;
  let dirs = 0;
  let truncated = false;

  if (!fs.existsSync(target)) {
    return { bytes: 0, files: 0, dirs: 0, truncated: false, exists: false, walkMs: 0 };
  }

  const st = fs.statSync(target);
  if (!st.isDirectory()) {
    return {
      bytes: st.size,
      files: 1,
      dirs: 0,
      truncated: false,
      exists: true,
      walkMs: Date.now() - started,
    };
  }

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
      if (files >= maxFiles) {
        truncated = true;
        break;
      }
      const full = path.join(dir, e.name);
      try {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          dirs++;
          stack.push(full);
        } else if (e.isFile()) {
          bytes += fs.statSync(full).size;
          files++;
        }
      } catch {
        /* skip */
      }
    }
    if (truncated) break;
  }

  return {
    bytes,
    files,
    dirs,
    truncated,
    exists: true,
    walkMs: Date.now() - started,
  };
}

function statFmt(stats) {
  if (!stats.exists) return "missing";
  const trunc = stats.truncated ? " (truncated)" : "";
  return `${formatBytes(stats.bytes)} files=${stats.files} dirs=${stats.dirs} walk=${stats.walkMs}ms${trunc}`;
}

/**
 * @param {string} packagerTmp workspace tmpdir (contains electron-packager/)
 */
function electronPackagerRoot(packagerTmp) {
  return path.join(packagerTmp, "electron-packager");
}

/**
 * Newest matching child dirs under electron-packager temp.
 * @param {string} epRoot
 * @param {(name: string) => boolean} predicate
 */
function findNewestDirs(epRoot, predicate) {
  if (!fs.existsSync(epRoot)) return [];
  let names;
  try {
    names = fs.readdirSync(epRoot).filter(predicate);
  } catch {
    return [];
  }
  const dirs = names
    .map((name) => {
      const full = path.join(epRoot, name);
      try {
        const st = fs.statSync(full);
        if (!st.isDirectory()) return null;
        return { name, path: full, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return dirs;
}

/**
 * Describe active packager work directories (template, staging tmp-*, resources/app, app.asar).
 * @param {string} packagerTmp
 * @param {{ maxFiles?: number }} [opts]
 */
export function scanPackagerWorkDirs(packagerTmp, opts = {}) {
  const ep = electronPackagerRoot(packagerTmp);
  const result = {
    packagerTmp,
    electronPackagerRoot: ep,
    epExists: fs.existsSync(ep),
    epEntries: /** @type {string[]} */ ([]),
    template: /** @type {null | { name: string, path: string, stats: ReturnType<typeof directoryStats> }} */ (
      null
    ),
    staging: /** @type {null | { name: string, path: string, stats: ReturnType<typeof directoryStats>, resourcesApp: ReturnType<typeof directoryStats> | null, appAsar: { exists: boolean, bytes: number } | null }} */ (
      null
    ),
  };

  if (!result.epExists) return result;

  try {
    result.epEntries = fs.readdirSync(ep);
  } catch {
    result.epEntries = [];
  }

  const templates = findNewestDirs(ep, (n) => n.includes("template"));
  if (templates.length > 0) {
    const t = templates[0];
    result.template = {
      name: t.name,
      path: t.path,
      stats: directoryStats(t.path, opts),
    };
  }

  const stagings = findNewestDirs(ep, (n) => n.startsWith("tmp-"));
  if (stagings.length > 0) {
    const s = stagings[0];
    const resourcesApp = path.join(s.path, "resources", "app");
    const appAsar = path.join(s.path, "resources", "app.asar");
    let asarInfo = null;
    if (fs.existsSync(appAsar)) {
      try {
        asarInfo = { exists: true, bytes: fs.statSync(appAsar).size };
      } catch {
        asarInfo = { exists: true, bytes: 0 };
      }
    }
    result.staging = {
      name: s.name,
      path: s.path,
      stats: directoryStats(s.path, opts),
      resourcesApp: fs.existsSync(resourcesApp)
        ? directoryStats(resourcesApp, opts)
        : null,
      appAsar: asarInfo,
    };
  }

  return result;
}

/**
 * @param {ReturnType<typeof scanPackagerWorkDirs>} scan
 */
export function formatWorkDirScan(scan) {
  const lines = [];
  lines.push(
    `epRoot=${scan.epExists ? scan.electronPackagerRoot : "missing"} entries=${scan.epEntries.length}`,
  );
  if (scan.epEntries.length > 0) {
    lines.push(`  ep children: ${scan.epEntries.slice(0, 12).join(", ")}${scan.epEntries.length > 12 ? " …" : ""}`);
  }
  if (scan.template) {
    lines.push(`  template ${scan.template.name}: ${statFmt(scan.template.stats)}`);
  } else {
    lines.push("  template: none");
  }
  if (scan.staging) {
    lines.push(`  staging ${scan.staging.name}: ${statFmt(scan.staging.stats)}`);
    if (scan.staging.resourcesApp) {
      lines.push(`    resources/app: ${statFmt(scan.staging.resourcesApp)}`);
    } else {
      lines.push("    resources/app: missing");
    }
    if (scan.staging.appAsar) {
      lines.push(`    resources/app.asar: ${formatBytes(scan.staging.appAsar.bytes)}`);
    } else {
      lines.push("    resources/app.asar: missing");
    }
  } else {
    lines.push("  staging tmp-*: none");
  }
  return lines.join("\n");
}

/**
 * @param {string} label
 * @param {string} packagerTmp
 */
export function logPackagerWorkDirSnapshot(label, packagerTmp) {
  const scan = scanPackagerWorkDirs(packagerTmp, { maxFiles: 40_000 });
  console.log(`${PREFIX_SNAPSHOT} ${label}\n${formatWorkDirScan(scan)}`);
  return scan;
}

/**
 * Quick stats on the repo before packager runs (no full repo walk).
 * @param {string} cwd
 */
export function logSourceDirStats(cwd) {
  const lines = [`${PREFIX_SNAPSHOT} source-dir cwd=${cwd}`];
  const viteMain = path.join(cwd, ".vite", "build", "main.js");
  lines.push(`  .vite/build/main.js: ${fs.existsSync(viteMain) ? "yes" : "MISSING"}`);
  const viteBuild = path.join(cwd, ".vite", "build");
  if (fs.existsSync(viteBuild)) {
    lines.push(`  .vite/build: ${statFmt(directoryStats(viteBuild, { maxFiles: 5_000 }))}`);
  }
  const nm = path.join(cwd, "node_modules");
  if (fs.existsSync(nm)) {
    let top;
    try {
      top = fs.readdirSync(nm);
    } catch (err) {
      top = [];
      lines.push(`  node_modules: unreadable (${err.message})`);
    }
    if (top) {
      lines.push(`  node_modules top-level packages: ${top.length}`);
    }
  } else {
    lines.push("  node_modules: missing");
  }
  const outDir = path.join(cwd, "out");
  lines.push(`  out/: ${fs.existsSync(outDir) ? fs.readdirSync(outDir).join(", ") || "(empty)" : "missing"}`);
  console.log(lines.join("\n"));
}

/**
 * @param {string} tag
 */
export function createPackagerPhaseLogger(tag) {
  /** @type {{ name: string, startedAt: number, detail?: string } | null} */
  let current = null;
  /** @type {string} */
  let lastCompleted = "(none)";

  return {
    get lastPhase() {
      return current ? `${current.name} (running ${((Date.now() - current.startedAt) / 1000).toFixed(0)}s)` : lastCompleted;
    },

    /**
     * @param {string} name
     * @param {{ buildPath?: string, detail?: string }} [opts]
     */
    start(name, opts = {}) {
      if (current) {
        const elapsed = ((Date.now() - current.startedAt) / 1000).toFixed(1);
        console.log(
          `${PREFIX_PHASE} [${tag}] end ${current.name} (${elapsed}s) — nested start ${name}`,
        );
      }
      current = { name, startedAt: Date.now(), detail: opts.detail };
      const parts = [`${PREFIX_PHASE} [${tag}] start ${name}`, formatMemory()];
      if (opts.buildPath) parts.push(`buildPath=${opts.buildPath}`);
      if (opts.detail) parts.push(opts.detail);
      console.log(parts.join(" | "));
    },

    /**
     * @param {string} name
     * @param {{ detail?: string }} [opts]
     */
    end(name, opts = {}) {
      if (!current || current.name !== name) {
        console.warn(
          `${PREFIX_PHASE} [${tag}] end ${name} (no matching start; current=${current?.name ?? "none"})`,
        );
        return;
      }
      const elapsedSec = ((Date.now() - current.startedAt) / 1000).toFixed(1);
      const parts = [`${PREFIX_PHASE} [${tag}] end ${name} (${elapsedSec}s)`, formatMemory()];
      if (opts.detail) parts.push(opts.detail);
      if (Number(elapsedSec) >= 120) {
        parts.push("::warning:: slow phase on Windows CI");
      }
      console.log(parts.join(" | "));
      lastCompleted = `${name} (${elapsedSec}s ago)`;
      current = null;
    },
  };
}

/**
 * @param {string} tag
 * @param {{
 *   outDir: string,
 *   packagerTmp: string,
 *   packageDir: string,
 *   startedAt: number,
 *   maxMs: number,
 *   phaseLogger: ReturnType<typeof createPackagerPhaseLogger>,
 *   lastScan?: ReturnType<typeof scanPackagerWorkDirs>,
 * }} ctx
 */
export function logPackagerHeartbeatDetailed(tag, ctx) {
  const elapsedSec = ((Date.now() - ctx.startedAt) / 1000).toFixed(0);
  const scan = scanPackagerWorkDirs(ctx.packagerTmp, { maxFiles: 50_000 });

  const prevStagingBytes = ctx.lastScan?.staging?.stats?.bytes ?? 0;
  const curStagingBytes = scan.staging?.stats?.bytes ?? 0;
  const prevAppBytes = ctx.lastScan?.staging?.resourcesApp?.bytes ?? 0;
  const curAppBytes = scan.staging?.resourcesApp?.bytes ?? 0;
  const prevTemplateBytes = ctx.lastScan?.template?.stats?.bytes ?? 0;
  const curTemplateBytes = scan.template?.stats?.bytes ?? 0;
  const deltaStaging = curStagingBytes - prevStagingBytes;
  const deltaApp = curAppBytes - prevAppBytes;
  const deltaTemplate = curTemplateBytes - prevTemplateBytes;

  const outExists = fs.existsSync(ctx.outDir);
  const pkgExists = fs.existsSync(ctx.packageDir);
  const exe = path.join(ctx.packageDir, "atlarix.exe");

  const summary = [
    `${PREFIX_HEARTBEAT} [${tag}] elapsed=${elapsedSec}s`,
    `phase=${ctx.phaseLogger.lastPhase}`,
    formatMemory(),
    `out/=${outExists}`,
    `packageDir=${pkgExists}`,
    `exe=${fs.existsSync(exe)}`,
  ];

  if (scan.staging) {
    summary.push(
      `staging=${scan.staging.name} ${formatBytes(curStagingBytes)} (Δ${formatBytes(Math.max(0, deltaStaging))})`,
    );
    if (scan.staging.resourcesApp) {
      summary.push(
        `resources/app ${formatBytes(curAppBytes)} files=${scan.staging.resourcesApp.files} (Δ${formatBytes(Math.max(0, deltaApp))})`,
      );
    }
    if (scan.staging.appAsar) {
      summary.push(`app.asar=${formatBytes(scan.staging.appAsar.bytes)}`);
    }
  } else if (scan.template) {
    summary.push(
      `template-only ${scan.template.name} ${formatBytes(curTemplateBytes)} files=${scan.template.stats.files} (Δ${formatBytes(Math.max(0, deltaTemplate))}) — pre-staging (extract or initialize)`,
    );
  } else {
    summary.push("no template/staging under electron-packager (pre-extract or wrong tmpdir)");
  }

  console.log(summary.join(" | "));

  if (deltaStaging === 0 && deltaApp === 0 && !pkgExists && Number(elapsedSec) >= 180) {
    let stallHint;
    if (!scan.staging) {
      if (scan.template && deltaTemplate === 0 && scan.template.stats.bytes < 5 * 1024 * 1024) {
        stallHint = `stuck during Electron zip extract (template flat at ${formatBytes(curTemplateBytes)}, ${scan.template.stats.files} file(s) — extract-zip or Expand-Archive)`;
      } else if (scan.template && deltaTemplate === 0) {
        stallHint = `stuck after partial extract (template ${formatBytes(curTemplateBytes)} unchanged) — before staging tmp-*`;
      } else {
        stallHint = "stuck before electron-packager temp dirs (download or mkdir)";
      }
    } else {
      stallHint = "stuck in copy-walk, prune/galactus, or asar";
    }
    console.log(`${PREFIX_HEARTBEAT} [${tag}] ::warning:: no progress for 3+ min — ${stallHint}`);
    logPackagerWorkDirSnapshot(`${tag}-heartbeat-stall-hint`, ctx.packagerTmp);
  }

  ctx.lastScan = scan;

  if (Date.now() - ctx.startedAt > ctx.maxMs) {
    console.error(
      `::error::[${tag}] packager exceeded ${(ctx.maxMs / 60_000).toFixed(0)}m | last phase: ${ctx.phaseLogger.lastPhase}`,
    );
    dumpPackagerInstrumentation(tag, ctx);
    process.exit(1);
  }
}

/**
 * @param {string} tag
 * @param {{ packagerTmp: string, phaseLogger?: ReturnType<typeof createPackagerPhaseLogger> }} ctx
 */
export function dumpPackagerInstrumentation(tag, ctx) {
  console.error(`\n=== ${tag} packager instrumentation dump ===`);
  console.error(`time: ${new Date().toISOString()}`);
  if (ctx.phaseLogger) {
    console.error(`last phase: ${ctx.phaseLogger.lastPhase}`);
  }
  console.error(formatMemory());
  logSourceDirStats(process.cwd());
  logPackagerWorkDirSnapshot(`${tag}-failure`, ctx.packagerTmp);
  const ep = electronPackagerRoot(ctx.packagerTmp);
  if (fs.existsSync(ep)) {
    try {
      for (const name of fs.readdirSync(ep)) {
        const full = path.join(ep, name);
        let kind = "?";
        try {
          kind = fs.statSync(full).isDirectory() ? "dir" : "file";
        } catch {
          /* ignore */
        }
        console.error(`  ${kind.padEnd(4)} ${name}`);
      }
    } catch {
      /* ignore */
    }
  }
  console.error("=== end packager instrumentation ===\n");
}
