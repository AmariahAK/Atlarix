/**
 * Shared Windows CI packaging (Vite prePackage, direct electron-packager, make).
 * Used by win-ci-vite.mjs, win-ci-package.mjs, and win-ci-build.mjs.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { runForgePrePackageBuilds } from "./forge-packaging-hooks.mjs";
import { loadForgeConfig, resolveCjsDefault } from "./forge-config-load.mjs";
import { logPackagingStep } from "./packaging-diagnostics.mjs";
import {
  createFastPackagerIgnore,
  wrapPackagerIgnore,
} from "./win-ci-packager-ignore.mjs";
import {
  createPackagerPhaseLogger,
  dumpPackagerInstrumentation,
  logPackagerHeartbeatDetailed,
  logPackagerWorkDirSnapshot,
  logSourceDirStats,
  PREFIX_PHASE,
} from "./win-ci-packager-instrumentation.mjs";
import {
  ensureElectronZipReady,
  installWindowsCiElectronExtractPatch,
  resolveElectronCacheRoot,
} from "./win-ci-electron-zip.mjs";
import { sequentialPackagerHooks } from "./win-ci-packager-hooks.mjs";

/** Windows CI: fail if packager produces no out/ within this window. */
export const PACKAGER_TIMEOUT_MS = 50 * 60 * 1000;
const HEARTBEAT_MS = 60_000;

const require = createRequire(import.meta.url);
installWindowsCiElectronExtractPatch();
const { runHook } = require("@electron-forge/core/dist/util/hook.js");
const { readMutatedPackageJson } = require("@electron-forge/core/dist/util/read-package-json.js");
const { getElectronVersion } = require("@electron-forge/core-utils/dist/electron-version.js");
const outDirFn = resolveCjsDefault("@electron-forge/core/dist/util/out-dir.js");
const { packager } = require("@electron/packager");
const { rebuild } = require("@electron/rebuild");

export const PLATFORM = "win32";
export const ARCH = "x64";
export const APP = "Atlarix";
export const PACKAGE_DIR = path.join(process.cwd(), "out", `${APP}-${PLATFORM}-${ARCH}`);
/** Workspace-local temp (npm TMP/TEMP on CI); not used as packager tmpdir on GHA win32. */
export const PACKAGER_TMP = path.join(process.cwd(), ".cache", "packager-tmp");
export const MAIN_JS = path.join(process.cwd(), ".vite", "build", "main.js");

/**
 * Packager temp must not live under `dir` or fs.copy hits "subdirectory of itself".
 * On GHA Windows use RUNNER_TEMP; locally keep .cache/packager-tmp.
 */
export function resolvePackagerTmpdir() {
  if (process.platform === "win32" && process.env.GITHUB_ACTIONS === "true") {
    const base = process.env.RUNNER_TEMP || os.tmpdir();
    return path.join(base, "atlarix-electron-packager");
  }
  return PACKAGER_TMP;
}

const fatalRegistered = new Set();

export function registerFatalHandlers(tag) {
  if (fatalRegistered.has(tag)) return;
  fatalRegistered.add(tag);
  let fatalExit = false;
  const exitOnFatal = (code) => {
    if (fatalExit) return;
    fatalExit = true;
    process.exit(code);
  };
  process.on("unhandledRejection", (err) => {
    console.error(`[${tag}] unhandledRejection:`, err);
    dumpFailureDiagnostics(tag);
    exitOnFatal(1);
  });
  process.on("uncaughtException", (err) => {
    console.error(`[${tag}] uncaughtException:`, err);
    dumpFailureDiagnostics(tag);
    exitOnFatal(1);
  });
}

function logPackagerTempDirs() {
  const workspaceTmp = PACKAGER_TMP;
  console.error(`workspace packager-tmp ${workspaceTmp} exists: ${fs.existsSync(workspaceTmp)}`);
  if (fs.existsSync(workspaceTmp)) {
    try {
      const entries = fs.readdirSync(workspaceTmp);
      console.error(
        `workspace packager-tmp entries (max 15): ${entries.slice(0, 15).join(", ") || "(empty)"}`,
      );
    } catch {
      /* ignore */
    }
  }
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

export function dumpFailureDiagnostics(tag) {
  console.error(`\n=== ${tag} failure diagnostics ===`);
  console.error(`cwd: ${process.cwd()}`);
  console.error(`time: ${new Date().toISOString()}`);
  console.error(`packageDir expected: ${PACKAGE_DIR}`);
  console.error(`out/ exists: ${fs.existsSync(path.join(process.cwd(), "out"))}`);
  if (fs.existsSync(path.join(process.cwd(), "out"))) {
    try {
      console.error(
        `out/ entries: ${fs.readdirSync(path.join(process.cwd(), "out")).join(", ") || "(empty)"}`,
      );
    } catch {
      /* ignore */
    }
  }
  console.error(`.vite/build exists: ${fs.existsSync(MAIN_JS)}`);
  logPackagerTempDirs();
  dumpPackagerInstrumentation(tag, { packagerTmp: resolvePackagerTmpdir() });
  console.error("=== end diagnostics ===\n");
}

export function assertMainJs(tag) {
  if (!fs.existsSync(MAIN_JS)) {
    console.error(`::error::[${tag}] Missing .vite/build/main.js — run win-ci-vite.mjs first`);
    dumpFailureDiagnostics(tag);
    process.exit(1);
  }
}

export async function buildProductionViteBundles(tag) {
  const fsExtra = (await import("fs-extra")).default;
  await fsExtra.remove(path.join(process.cwd(), ".vite"));

  await runForgePrePackageBuilds({ platform: PLATFORM, arch: ARCH });

  if (!fs.existsSync(MAIN_JS)) {
    console.error(`::error::[${tag}] Missing .vite/build/main.js after Forge prePackage builds`);
    dumpFailureDiagnostics(tag);
    process.exit(1);
  }
}

export async function packageAppDirect(tag) {
  const fsExtra = (await import("fs-extra")).default;
  const fg = (await import("fast-glob")).default;
  const phases = createPackagerPhaseLogger(tag);

  const dir = process.cwd();
  phases.start("load-forge-config");
  console.log(`[${tag}] loading forge.config`);
  const forgeConfig = await loadForgeConfig(dir);
  phases.end("load-forge-config");

  const packageJSON = await readMutatedPackageJson(dir, forgeConfig);
  const calculatedOutDir = outDirFn(dir, forgeConfig);
  const electronVersion = await getElectronVersion(dir, packageJSON);

  const packagerTmpdir = resolvePackagerTmpdir();
  fs.mkdirSync(packagerTmpdir, { recursive: true });
  fs.mkdirSync(PACKAGER_TMP, { recursive: true });

  const afterCopySubHooks = [
    async (buildPath, ev, pPlatform, pArch) => {
      phases.start("afterCopy:strip-bin-symlinks", { buildPath });
      try {
        const bins = await fg(path.join(buildPath, "**/.bin/**/*"));
        console.log(`${PREFIX_PHASE} [${tag}] strip .bin count=${bins.length}`);
        for (const bin of bins) {
          await fsExtra.remove(bin);
        }
        phases.end("afterCopy:strip-bin-symlinks", { detail: `removed=${bins.length}` });
      } catch (err) {
        phases.end("afterCopy:strip-bin-symlinks", { detail: `error=${err.message}` });
        throw err;
      }
    },
    async (buildPath, ev, pPlatform, pArch) => {
      phases.start("afterCopy:packageAfterCopy", { buildPath });
      try {
        await runHook(forgeConfig, "packageAfterCopy", buildPath, ev, pPlatform, pArch);
        phases.end("afterCopy:packageAfterCopy");
      } catch (err) {
        phases.end("afterCopy:packageAfterCopy", { detail: `error=${err.message}` });
        throw err;
      }
    },
    async (buildPath, ev, pPlatform, pArch) => {
      phases.start("afterCopy:native-rebuild", { buildPath });
      try {
        if (process.env.GITHUB_ACTIONS !== "true") {
          console.log(`[${tag}] rebuilding native modules in packaged app (local)`);
          await rebuild({
            buildPath,
            electronVersion: ev,
            platform: pPlatform,
            arch: pArch,
            force: true,
            ...(forgeConfig.rebuildConfig ?? {}),
          });
        } else {
          console.log(`[${tag}] skipping afterCopy rebuild on GHA (packageAfterPrune rebuilds)`);
        }
        phases.end("afterCopy:native-rebuild", { detail: "skipped-on-gha" });
      } catch (err) {
        phases.end("afterCopy:native-rebuild", { detail: `error=${err.message}` });
        throw err;
      }
    },
    async (buildPath, ev, pPlatform, pArch) => {
      phases.start("afterCopy:write-package-json", { buildPath });
      try {
        const copiedPackageJSON = await readMutatedPackageJson(buildPath, forgeConfig);
        if (copiedPackageJSON.config?.forge) {
          delete copiedPackageJSON.config.forge;
        }
        await fsExtra.writeJson(path.join(buildPath, "package.json"), copiedPackageJSON, {
          spaces: 2,
        });
        phases.end("afterCopy:write-package-json");
        logPackagerWorkDirSnapshot(`${tag}-after-copy`, packagerTmpdir);
      } catch (err) {
        phases.end("afterCopy:write-package-json", { detail: `error=${err.message}` });
        throw err;
      }
    },
  ];

  const afterPruneHooks = [
    async (buildPath, ev, pPlatform, pArch) => {
      phases.start("afterPrune:packageAfterPrune", { buildPath });
      try {
        console.log(`[${tag}] hook afterPrune → packageAfterPrune`);
        await runHook(forgeConfig, "packageAfterPrune", buildPath, ev, pPlatform, pArch);
        phases.end("afterPrune:packageAfterPrune");
        logPackagerWorkDirSnapshot(`${tag}-after-prune`, packagerTmpdir);
      } catch (err) {
        phases.end("afterPrune:packageAfterPrune", { detail: `error=${err.message}` });
        throw err;
      }
    },
  ];

  const forgeIgnore = forgeConfig.packagerConfig?.ignore;
  const useFastIgnore =
    process.platform === "win32" &&
    process.env.GITHUB_ACTIONS === "true" &&
    typeof forgeIgnore === "function";

  const electronCacheRoot = resolveElectronCacheRoot(dir);
  const onGhaWin =
    process.platform === "win32" && process.env.GITHUB_ACTIONS === "true";

  const packageOpts = {
    overwrite: true,
    ignore: [/^\/out\//g],
    quiet: false,
    tmpdir: packagerTmpdir,
    ...forgeConfig.packagerConfig,
    download: {
      ...(forgeConfig.packagerConfig?.download ?? {}),
      cacheRoot: electronCacheRoot,
    },
    ignore: wrapPackagerIgnore(
      useFastIgnore ? createFastPackagerIgnore(forgeIgnore) : forgeIgnore,
    ),
    dir,
    arch: ARCH,
    platform: PLATFORM,
    beforeCopy: sequentialPackagerHooks([
      async (buildPath) => {
        phases.start("copy-walk", {
          buildPath,
          detail: "fs.copy repo→resources/app (ends when first afterCopy runs)",
        });
        logPackagerWorkDirSnapshot(`${tag}-before-copy`, packagerTmpdir);
      },
    ]),
    afterCopy: sequentialPackagerHooks([
      async (buildPath) => {
        phases.end("copy-walk", { detail: "copy+prune filter walk finished" });
      },
      ...afterCopySubHooks,
    ]),
    afterPrune: sequentialPackagerHooks(afterPruneHooks),
    afterExtract: sequentialPackagerHooks([
      async (buildPath, ev, pPlatform, pArch) => {
        phases.start("afterExtract", { buildPath });
        try {
          await runHook(forgeConfig, "packageAfterExtract", buildPath, ev, pPlatform, pArch);
          phases.end("afterExtract");
          logPackagerWorkDirSnapshot(`${tag}-after-extract`, packagerTmpdir);
        } catch (err) {
          phases.end("afterExtract", { detail: `error=${err.message}` });
          throw err;
        }
      },
    ]),
    out: calculatedOutDir,
    electronVersion,
  };

  if (
    process.env.GITHUB_ACTIONS === "true" &&
    !process.env.DEBUG?.includes("electron-packager")
  ) {
    process.env.DEBUG = "electron-packager:*";
  }
  if (process.env.ATLARIX_PACKAGING_DEBUG === "1") {
    process.env.DEBUG = process.env.DEBUG ?? "electron-packager:*";
  }

  const prune = packageOpts.prune !== false;
  const asar = Boolean(packageOpts.asar);

  console.log(`[${tag}] running @electron/packager (direct, no listr)`);
  console.log(
    `[${tag}] out=${calculatedOutDir} tmpdir=${packagerTmpdir} electronCache=${electronCacheRoot} fastIgnore=${useFastIgnore} prune=${prune} asar=${asar} electron=${electronVersion}`,
  );
  logSourceDirStats(dir);
  logPackagerWorkDirSnapshot(`${tag}-pre-packager`, packagerTmpdir);

  if (onGhaWin) {
    phases.start("electron-zip-ready", { detail: `cacheRoot=${electronCacheRoot}` });
    try {
      const zipPath = await ensureElectronZipReady({
        version: electronVersion,
        platform: PLATFORM,
        arch: ARCH,
        cacheRoot: electronCacheRoot,
      });
      phases.end("electron-zip-ready", { detail: path.basename(zipPath) });
    } catch (err) {
      phases.end("electron-zip-ready", { detail: `error=${err.message}` });
      console.error(`::error::[${tag}] ${err.message}`);
      dumpFailureDiagnostics(tag);
      process.exit(1);
    }
  }

  let outputPaths;
  logPackagingStep(`${tag}:packager-start`, {
    detail: `tmpdir=${packagerTmpdir} prune=${prune} asar=${asar}`,
  });
  const packagerStartedAt = Date.now();
  const heartbeatCtx = {
    outDir: calculatedOutDir,
    packagerTmp: packagerTmpdir,
    packageDir: PACKAGE_DIR,
    startedAt: packagerStartedAt,
    maxMs: PACKAGER_TIMEOUT_MS,
    phaseLogger: phases,
    lastScan: undefined,
  };
  const instrumentPackager =
    process.platform === "win32" &&
    (process.env.GITHUB_ACTIONS === "true" ||
      process.env.ATLARIX_PACKAGING_DEBUG === "1" ||
      process.env.ATLARIX_WINDOWS_PACKAGING_DEBUG === "1");

  phases.start("packager-await", { detail: "await packager() — includes extract, copy, asar, move" });
  const keepAlive = instrumentPackager
    ? setInterval(() => logPackagerHeartbeatDetailed(tag, heartbeatCtx), HEARTBEAT_MS)
    : null;
  try {
    outputPaths = await packager(packageOpts);
  } catch (err) {
    console.error(`[${tag}] packager threw:`, err);
    phases.end("packager-await", { detail: `threw=${err.message}` });
    dumpFailureDiagnostics(tag);
    process.exit(1);
  } finally {
    if (keepAlive) clearInterval(keepAlive);
  }
  phases.end("packager-await", { detail: `paths=${outputPaths?.length ?? 0}` });
  if (instrumentPackager) {
    logPackagerHeartbeatDetailed(tag, heartbeatCtx);
    logPackagerWorkDirSnapshot(`${tag}-post-packager`, packagerTmpdir);
  }
  logPackagingStep(`${tag}:packager-done`, { detail: `paths=${outputPaths?.length ?? 0}` });

  console.log(`[${tag}] packager returned: ${JSON.stringify(outputPaths)}`);

  if (!outputPaths?.length) {
    console.error("::error::@electron/packager produced no output paths");
    dumpFailureDiagnostics(tag);
    process.exit(1);
  }

  for (const outputPath of outputPaths) {
    if (!fs.existsSync(outputPath)) {
      console.error(`::error::Packager output missing on disk: ${outputPath}`);
      dumpFailureDiagnostics(tag);
      process.exit(1);
    }
  }

  await runHook(forgeConfig, "postPackage", {
    arch: ARCH,
    outputPaths,
    platform: PLATFORM,
  });

  if (!fs.existsSync(PACKAGE_DIR)) {
    console.error(`::error::Expected package dir missing: ${PACKAGE_DIR}`);
    dumpFailureDiagnostics(tag);
    process.exit(1);
  }

  console.log(`[${tag}] OK packaged app at ${PACKAGE_DIR}`);
}

export function runMakeSkipPackage(tag) {
  console.log(`\n[${tag}] electron-forge make --skip-package`);
  const forgeCli = require.resolve("@electron-forge/cli/dist/electron-forge.js");
  const result = spawnSync(process.execPath, [forgeCli, "make", "--skip-package"], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(`::error::[${tag}] make --skip-package failed (exit ${result.status ?? "?"})`);
    dumpFailureDiagnostics(tag);
    process.exit(result.status ?? 1);
  }
}
