/**
 * Shared Windows CI packaging (Vite prePackage, direct electron-packager, make).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { runForgePrePackageBuilds } from "./forge-packaging-hooks.mjs";
import { loadForgeConfig, resolveCjsDefault } from "./forge-config-load.mjs";
import {
  createFastPackagerIgnore,
  wrapPackagerIgnore,
} from "./win-ci-packager-ignore.mjs";
import {
  ensureElectronZipReady,
  installWindowsCiElectronExtractPatch,
  resolveElectronCacheRoot,
} from "./win-ci-electron-zip.mjs";
import { sequentialPackagerHooks } from "./win-ci-packager-hooks.mjs";

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
export const PACKAGER_TMP = path.join(process.cwd(), ".cache", "packager-tmp");
export const MAIN_JS = path.join(process.cwd(), ".vite", "build", "main.js");

export function resolvePackagerTmpdir() {
  if (process.platform === "win32" && process.env.GITHUB_ACTIONS === "true") {
    const base = process.env.RUNNER_TEMP || os.tmpdir();
    return path.join(base, "atlarix-electron-packager");
  }
  return PACKAGER_TMP;
}

const fatalRegistered = new Set();

export function logFailureContext(tag) {
  console.error(`[${tag}] cwd=${process.cwd()}`);
  console.error(`[${tag}] out/ exists=${fs.existsSync(path.join(process.cwd(), "out"))}`);
  console.error(`[${tag}] .vite/build/main.js exists=${fs.existsSync(MAIN_JS)}`);
  console.error(`[${tag}] expected package dir=${PACKAGE_DIR}`);
}

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
    logFailureContext(tag);
    exitOnFatal(1);
  });
  process.on("uncaughtException", (err) => {
    console.error(`[${tag}] uncaughtException:`, err);
    logFailureContext(tag);
    exitOnFatal(1);
  });
}

export function assertMainJs(tag) {
  if (!fs.existsSync(MAIN_JS)) {
    console.error(`::error::[${tag}] Missing .vite/build/main.js — run win-ci-vite.mjs first`);
    logFailureContext(tag);
    process.exit(1);
  }
}

export async function buildProductionViteBundles(tag) {
  const fsExtra = (await import("fs-extra")).default;
  await fsExtra.remove(path.join(process.cwd(), ".vite"));

  await runForgePrePackageBuilds({ platform: PLATFORM, arch: ARCH });

  if (!fs.existsSync(MAIN_JS)) {
    console.error(`::error::[${tag}] Missing .vite/build/main.js after Forge prePackage builds`);
    logFailureContext(tag);
    process.exit(1);
  }
}

export async function packageAppDirect(tag) {
  const fsExtra = (await import("fs-extra")).default;
  const fg = (await import("fast-glob")).default;

  const dir = process.cwd();
  console.log(`[${tag}] loading forge.config`);
  const forgeConfig = await loadForgeConfig(dir);

  const packageJSON = await readMutatedPackageJson(dir, forgeConfig);
  const calculatedOutDir = outDirFn(dir, forgeConfig);
  const electronVersion = await getElectronVersion(dir, packageJSON);

  const packagerTmpdir = resolvePackagerTmpdir();
  fs.mkdirSync(packagerTmpdir, { recursive: true });
  fs.mkdirSync(PACKAGER_TMP, { recursive: true });

  const afterCopyHooks = [
    async (buildPath, _ev, _pPlatform, _pArch) => {
      const bins = await fg(path.join(buildPath, "**/.bin/**/*"));
      for (const bin of bins) {
        await fsExtra.remove(bin);
      }
    },
    async (buildPath, ev, pPlatform, pArch) => {
      await runHook(forgeConfig, "packageAfterCopy", buildPath, ev, pPlatform, pArch);
    },
    async (buildPath, ev, pPlatform, pArch) => {
      if (process.env.GITHUB_ACTIONS !== "true") {
        await rebuild({
          buildPath,
          electronVersion: ev,
          platform: pPlatform,
          arch: pArch,
          force: true,
          ...forgeConfig.rebuildConfig,
        });
      }
    },
    async (buildPath, _ev, _pPlatform, _pArch) => {
      const copiedPackageJSON = await readMutatedPackageJson(buildPath, forgeConfig);
      if (copiedPackageJSON.config?.forge) {
        delete copiedPackageJSON.config.forge;
      }
      await fsExtra.writeJson(path.join(buildPath, "package.json"), copiedPackageJSON, {
        spaces: 2,
      });
    },
  ];

  const afterPruneHooks = [
    async (buildPath, ev, pPlatform, pArch) => {
      await runHook(forgeConfig, "packageAfterPrune", buildPath, ev, pPlatform, pArch);
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
    tmpdir: packagerTmpdir,
    ...forgeConfig.packagerConfig,
    download: {
      ...forgeConfig.packagerConfig?.download,
      cacheRoot: electronCacheRoot,
    },
    ignore: wrapPackagerIgnore(
      useFastIgnore ? createFastPackagerIgnore(forgeIgnore) : forgeIgnore,
    ),
    dir,
    arch: ARCH,
    platform: PLATFORM,
    afterCopy: sequentialPackagerHooks(afterCopyHooks),
    afterPrune: sequentialPackagerHooks(afterPruneHooks),
    afterExtract: sequentialPackagerHooks([
      async (buildPath, ev, pPlatform, pArch) => {
        await runHook(forgeConfig, "packageAfterExtract", buildPath, ev, pPlatform, pArch);
      },
    ]),
    out: calculatedOutDir,
    electronVersion,
  };

  const prune = packageOpts.prune !== false;
  const asar = Boolean(packageOpts.asar);

  console.log(
    `[${tag}] packager out=${calculatedOutDir} tmpdir=${packagerTmpdir} fastIgnore=${useFastIgnore} prune=${prune} asar=${asar}`,
  );

  if (onGhaWin) {
    try {
      await ensureElectronZipReady({
        version: electronVersion,
        platform: PLATFORM,
        arch: ARCH,
        cacheRoot: electronCacheRoot,
      });
    } catch (err) {
      console.error(`::error::[${tag}] ${err.message}`);
      logFailureContext(tag);
      process.exit(1);
    }
  }

  let outputPaths;
  try {
    outputPaths = await packager(packageOpts);
  } catch (err) {
    console.error(`[${tag}] packager threw:`, err);
    logFailureContext(tag);
    process.exit(1);
  }

  if (!outputPaths?.length) {
    console.error("::error::@electron/packager produced no output paths");
    logFailureContext(tag);
    process.exit(1);
  }

  for (const outputPath of outputPaths) {
    if (!fs.existsSync(outputPath)) {
      console.error(`::error::Packager output missing on disk: ${outputPath}`);
      logFailureContext(tag);
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
    logFailureContext(tag);
    process.exit(1);
  }

  console.log(`[${tag}] OK packaged app at ${PACKAGE_DIR}`);
}

export function runMakeSkipPackage(tag) {
  console.log(`[${tag}] electron-forge make --skip-package`);
  const forgeCli = require.resolve("@electron-forge/cli/dist/electron-forge.js");
  const result = spawnSync(process.execPath, [forgeCli, "make", "--skip-package"], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(`::error::[${tag}] make --skip-package failed (exit ${result.status ?? "?"})`);
    logFailureContext(tag);
    process.exit(result.status ?? 1);
  }
}
