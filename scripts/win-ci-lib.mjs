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

const require = createRequire(import.meta.url);
const { runHook } = require("@electron-forge/core/dist/util/hook.js");
const { readMutatedPackageJson } = require("@electron-forge/core/dist/util/read-package-json.js");
const { getElectronVersion } = require("@electron-forge/core-utils/dist/electron-version.js");
const outDirFn = resolveCjsDefault("@electron-forge/core/dist/util/out-dir.js");
const { packager } = require("@electron/packager");
const { serialHooks } = require("@electron/packager/dist/hooks.js");
const { rebuild } = require("@electron/rebuild");

export const PLATFORM = "win32";
export const ARCH = "x64";
export const APP = "Atlarix";
export const PACKAGE_DIR = path.join(process.cwd(), "out", `${APP}-${PLATFORM}-${ARCH}`);
export const PACKAGER_TMP = path.join(process.cwd(), ".cache", "packager-tmp");
export const MAIN_JS = path.join(process.cwd(), ".vite", "build", "main.js");

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

  const dir = process.cwd();
  console.log(`[${tag}] loading forge.config`);
  const forgeConfig = await loadForgeConfig(dir);

  const packageJSON = await readMutatedPackageJson(dir, forgeConfig);
  const calculatedOutDir = outDirFn(dir, forgeConfig);
  const electronVersion = await getElectronVersion(dir, packageJSON);

  fs.mkdirSync(PACKAGER_TMP, { recursive: true });

  const afterCopyHooks = [
    async (buildPath, ev, pPlatform, pArch, done) => {
      try {
        const bins = await fg(path.join(buildPath, "**/.bin/**/*"));
        for (const bin of bins) {
          await fsExtra.remove(bin);
        }
        done();
      } catch (err) {
        done(err);
      }
    },
    async (buildPath, ev, pPlatform, pArch, done) => {
      try {
        await runHook(forgeConfig, "packageAfterCopy", buildPath, ev, pPlatform, pArch);
        done();
      } catch (err) {
        done(err);
      }
    },
    async (buildPath, ev, pPlatform, pArch, done) => {
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
        done();
      } catch (err) {
        done(err);
      }
    },
    async (buildPath, ev, pPlatform, pArch, done) => {
      try {
        const copiedPackageJSON = await readMutatedPackageJson(buildPath, forgeConfig);
        if (copiedPackageJSON.config?.forge) {
          delete copiedPackageJSON.config.forge;
        }
        await fsExtra.writeJson(path.join(buildPath, "package.json"), copiedPackageJSON, {
          spaces: 2,
        });
        done();
      } catch (err) {
        done(err);
      }
    },
  ];

  const afterPruneHooks = [
    async (buildPath, ev, pPlatform, pArch, done) => {
      try {
        await runHook(forgeConfig, "packageAfterPrune", buildPath, ev, pPlatform, pArch);
        done();
      } catch (err) {
        done(err);
      }
    },
  ];

  const packageOpts = {
    overwrite: true,
    ignore: [/^\/out\//g],
    // Keep logs on GHA — quiet mode plus early Node exit made failures hard to diagnose.
    quiet: false,
    tmpdir: PACKAGER_TMP,
    ...forgeConfig.packagerConfig,
    dir,
    arch: ARCH,
    platform: PLATFORM,
    afterCopy: serialHooks(afterCopyHooks),
    afterPrune: serialHooks(afterPruneHooks),
    afterExtract: serialHooks([
      async (buildPath, ev, pPlatform, pArch, done) => {
        try {
          await runHook(forgeConfig, "packageAfterExtract", buildPath, ev, pPlatform, pArch);
          done();
        } catch (err) {
          done(err);
        }
      },
    ]),
    out: calculatedOutDir,
    electronVersion,
  };

  if (process.env.ATLARIX_PACKAGING_DEBUG === "1") {
    process.env.DEBUG = process.env.DEBUG ?? "electron-packager:*";
  }

  console.log(`[${tag}] running @electron/packager (direct, no listr)`);
  console.log(`[${tag}] out=${calculatedOutDir} tmpdir=${PACKAGER_TMP}`);

  let outputPaths;
  logPackagingStep(`${tag}:packager-start`, { detail: `tmpdir=${PACKAGER_TMP}` });
  try {
    outputPaths = await packager(packageOpts);
  } catch (err) {
    console.error(`[${tag}] packager threw:`, err);
    dumpFailureDiagnostics(tag);
    process.exit(1);
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
