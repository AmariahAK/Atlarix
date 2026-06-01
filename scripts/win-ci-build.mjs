#!/usr/bin/env node
/**
 * Windows CI release build — bypasses electron-forge listr for the package step.
 *
 * 1. Forge generateAssets + prePackage (production Vite via plugin-vite)
 * 2. @electron/packager directly (awaited, no listr)
 * 3. packageAfterPrune + plugin hooks via forge hook runner
 * 4. electron-forge make --skip-package (Squirrel only)
 *
 * CI entrypoint: npm run ci:make:win → scripts/ci-win-release.mjs (polls until out/ exists).
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
const PLATFORM = "win32";
const ARCH = "x64";
const APP = "Atlarix";
const PACKAGE_DIR = path.join(process.cwd(), "out", `${APP}-${PLATFORM}-${ARCH}`);
const PACKAGER_TMP = path.join(process.cwd(), ".cache", "packager-tmp");

let fatalExit = false;
function exitOnFatal(code) {
  if (fatalExit) return;
  fatalExit = true;
  process.exit(code);
}

process.on("unhandledRejection", (err) => {
  console.error("[win-ci-build] unhandledRejection:", err);
  dumpFailureDiagnostics();
  exitOnFatal(1);
});

process.on("uncaughtException", (err) => {
  console.error("[win-ci-build] uncaughtException:", err);
  dumpFailureDiagnostics();
  exitOnFatal(1);
});

function run(label, cmd, args, env = process.env) {
  console.log(`\n[win-ci-build] ${label}`);
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(`::error::${label} failed (exit ${result.status ?? "?"})`);
    dumpFailureDiagnostics();
    process.exit(result.status ?? 1);
  }
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
      console.error(`electron-packager temp entries (max 15): ${entries.slice(0, 15).join(", ") || "(empty)"}`);
    } catch {
      /* ignore */
    }
  }
}

function dumpFailureDiagnostics() {
  console.error("\n=== win-ci-build failure diagnostics ===");
  console.error(`cwd: ${process.cwd()}`);
  console.error(`time: ${new Date().toISOString()}`);
  console.error(`packageDir expected: ${PACKAGE_DIR}`);
  console.error(`out/ exists: ${fs.existsSync(path.join(process.cwd(), "out"))}`);
  if (fs.existsSync(path.join(process.cwd(), "out"))) {
    try {
      console.error(`out/ entries: ${fs.readdirSync(path.join(process.cwd(), "out")).join(", ") || "(empty)"}`);
    } catch {
      /* ignore */
    }
  }
  const viteBuild = path.join(process.cwd(), ".vite", "build");
  console.error(`.vite/build exists: ${fs.existsSync(viteBuild)}`);
  logPackagerTempDirs();
  console.error("=== end diagnostics ===\n");
}

async function buildProductionViteBundles() {
  const fsExtra = (await import("fs-extra")).default;
  await fsExtra.remove(path.join(process.cwd(), ".vite"));

  await runForgePrePackageBuilds({ platform: PLATFORM, arch: ARCH });

  const mainJs = path.join(process.cwd(), ".vite", "build", "main.js");
  if (!fs.existsSync(mainJs)) {
    console.error("::error::Missing .vite/build/main.js after Forge prePackage builds");
    dumpFailureDiagnostics();
    process.exit(1);
  }
}

async function packageAppDirect() {
  const fsExtra = (await import("fs-extra")).default;
  const fg = (await import("fast-glob")).default;

  const dir = process.cwd();
  console.log("[win-ci-build] loading forge.config");
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
          console.log("[win-ci-build] rebuilding native modules in packaged app (local)");
          await rebuild({
            buildPath,
            electronVersion: ev,
            platform: pPlatform,
            arch: pArch,
            force: true,
            ...(forgeConfig.rebuildConfig ?? {}),
          });
        } else {
          console.log(
            "[win-ci-build] skipping afterCopy rebuild on GHA (packageAfterPrune rebuilds)",
          );
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
    quiet: process.env.GITHUB_ACTIONS !== "true",
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

  console.log("[win-ci-build] running @electron/packager (direct, no listr)");
  console.log(`[win-ci-build] out=${calculatedOutDir} tmpdir=${PACKAGER_TMP}`);

  let outputPaths;
  logPackagingStep("win-ci-build:packager-start", { detail: `tmpdir=${PACKAGER_TMP}` });
  try {
    outputPaths = await packager(packageOpts);
  } catch (err) {
    console.error("[win-ci-build] packager threw:", err);
    dumpFailureDiagnostics();
    process.exit(1);
  }
  logPackagingStep("win-ci-build:packager-done", { detail: `paths=${outputPaths?.length ?? 0}` });

  console.log(`[win-ci-build] packager returned: ${JSON.stringify(outputPaths)}`);

  if (!outputPaths?.length) {
    console.error("::error::@electron/packager produced no output paths");
    dumpFailureDiagnostics();
    process.exit(1);
  }

  for (const outputPath of outputPaths) {
    if (!fs.existsSync(outputPath)) {
      console.error(`::error::Packager output missing on disk: ${outputPath}`);
      dumpFailureDiagnostics();
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
    dumpFailureDiagnostics();
    process.exit(1);
  }

  console.log(`[win-ci-build] OK packaged app at ${PACKAGE_DIR}`);
}

async function main() {
  console.log("[win-ci-build] Windows release build (direct packager path)");
  await buildProductionViteBundles();
  await packageAppDirect();

  if (!fs.existsSync(PACKAGE_DIR)) {
    console.error(`::error::Package dir missing before make: ${PACKAGE_DIR}`);
    dumpFailureDiagnostics();
    process.exit(1);
  }

  const forgeCli = require.resolve("@electron-forge/cli/dist/electron-forge.js");
  run("electron-forge make --skip-package", process.execPath, [forgeCli, "make", "--skip-package"]);

  console.log("[win-ci-build] complete");
}

main().catch((err) => {
  console.error("[win-ci-build] fatal:", err);
  dumpFailureDiagnostics();
  process.exit(1);
});
