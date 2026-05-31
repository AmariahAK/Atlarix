#!/usr/bin/env node
/**
 * Windows CI release build — bypasses electron-forge listr for the package step.
 *
 * 1. Forge generateAssets + prePackage (production Vite via plugin-vite)
 * 2. @electron/packager directly (awaited, no listr)
 * 3. packageAfterPrune + plugin hooks via forge hook runner
 * 4. electron-forge make --skip-package (Squirrel only)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { runForgePrePackageBuilds } from "./forge-packaging-hooks.mjs";
import { loadForgeConfig } from "./forge-config-load.mjs";

const require = createRequire(import.meta.url);
const PLATFORM = "win32";
const ARCH = "x64";
const APP = "Atlarix";
const PACKAGE_DIR = path.join(process.cwd(), "out", `${APP}-${PLATFORM}-${ARCH}`);

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
  const { runHook } = await import("@electron-forge/core/dist/util/hook.js");
  const { readMutatedPackageJson } = await import(
    "@electron-forge/core/dist/util/read-package-json.js"
  );
  const { getElectronVersion } = await import("@electron-forge/core-utils/dist/electron-version.js");
  const outDirFn = (await import("@electron-forge/core/dist/util/out-dir.js")).default;
  const { packager } = await import("@electron/packager");
  const { serialHooks } = await import("@electron/packager/dist/hooks.js");
  const fsExtra = (await import("fs-extra")).default;
  const fg = (await import("fast-glob")).default;
  const { rebuild } = await import("@electron/rebuild");

  const dir = process.cwd();
  console.log("[win-ci-build] loading forge.config");
  const forgeConfig = await loadForgeConfig(dir);

  const packageJSON = await readMutatedPackageJson(dir, forgeConfig);
  const calculatedOutDir = outDirFn(dir, forgeConfig);
  const electronVersion = await getElectronVersion(dir, packageJSON);

  const afterCopyHooks = [
    async (buildPath, ev, pPlatform, pArch, done) => {
      const bins = await fg(path.join(buildPath, "**/.bin/**/*"));
      for (const bin of bins) {
        await fsExtra.remove(bin);
      }
      done();
    },
    async (buildPath, ev, pPlatform, pArch, done) => {
      await runHook(forgeConfig, "packageAfterCopy", buildPath, ev, pPlatform, pArch);
      done();
    },
    async (buildPath, ev, pPlatform, pArch, done) => {
      console.log("[win-ci-build] rebuilding native modules in packaged app");
      await rebuild({
        buildPath,
        electronVersion: ev,
        platform: pPlatform,
        arch: pArch,
        force: true,
        ...(forgeConfig.rebuildConfig ?? {}),
      });
      done();
    },
    async (buildPath, ev, pPlatform, pArch, done) => {
      const copiedPackageJSON = await readMutatedPackageJson(buildPath, forgeConfig);
      if (copiedPackageJSON.config?.forge) {
        delete copiedPackageJSON.config.forge;
      }
      await fsExtra.writeJson(path.join(buildPath, "package.json"), copiedPackageJSON, {
        spaces: 2,
      });
      done();
    },
  ];

  const afterPruneHooks = [
    async (buildPath, ev, pPlatform, pArch, done) => {
      await runHook(forgeConfig, "packageAfterPrune", buildPath, ev, pPlatform, pArch);
      done();
    },
  ];

  const packageOpts = {
    overwrite: true,
    ignore: [/^\/out\//g],
    quiet: process.env.GITHUB_ACTIONS !== "true",
    ...forgeConfig.packagerConfig,
    dir,
    arch: ARCH,
    platform: PLATFORM,
    afterCopy: serialHooks(afterCopyHooks),
    afterPrune: serialHooks(afterPruneHooks),
    afterExtract: serialHooks([
      async (buildPath, ev, pPlatform, pArch, done) => {
        await runHook(forgeConfig, "packageAfterExtract", buildPath, ev, pPlatform, pArch);
        done();
      },
    ]),
    out: calculatedOutDir,
    electronVersion,
  };

  console.log("[win-ci-build] running @electron/packager (direct, no listr)");
  console.log(`[win-ci-build] out=${calculatedOutDir}`);

  let outputPaths;
  try {
    outputPaths = await packager(packageOpts);
  } catch (err) {
    console.error("[win-ci-build] packager threw:", err);
    dumpFailureDiagnostics();
    process.exit(1);
  }

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

  const forgeCli = require.resolve("@electron-forge/cli/dist/electron-forge.js");
  run("electron-forge make --skip-package", process.execPath, [forgeCli, "make", "--skip-package"]);

  console.log("[win-ci-build] complete");
}

main().catch((err) => {
  console.error("[win-ci-build] fatal:", err);
  dumpFailureDiagnostics();
  process.exit(1);
});
