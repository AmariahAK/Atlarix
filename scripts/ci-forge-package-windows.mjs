#!/usr/bin/env node
/**
 * Windows CI: run electron-forge package and block until out/Atlarix-win32-x64 exists.
 *
 * Prefer `npm run ci:package` in release.yml (same as macOS/Linux). This wrapper remains
 * for local debugging when listr exits before packager finishes.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import {
  formatMemory,
  logBuildPathSizes,
  logPackagingStep,
  shouldLogPackagingDiagnostics,
} from "./packaging-diagnostics.mjs";

const require = createRequire(import.meta.url);
const POLL_MS = 5_000;
const MEM_LOG_EVERY_MS = 30_000;
const TIMEOUT_MS = 150 * 60 * 1_000; // 150 min — Vite + packager + rebuild on Windows can hit 90min
const EARLY_EXIT_GRACE_MS = 10 * 60 * 1_000; // fail fast if forge exit 0 but out/ never appears
const APP = "Atlarix";
const PLATFORM = "win32";
const ARCH = "x64";
const PACKAGE_DIR = path.join(process.cwd(), "out", `${APP}-${PLATFORM}-${ARCH}`);
const FORGE_CLI = require.resolve("@electron-forge/cli/dist/electron-forge.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function packageReady() {
  if (!fs.existsSync(PACKAGE_DIR)) return false;
  const exe = path.join(PACKAGE_DIR, "atlarix.exe");
  if (fs.existsSync(exe)) return true;
  try {
    return fs.readdirSync(PACKAGE_DIR).length > 0;
  } catch {
    return false;
  }
}

function startForgePackage() {
  const env = {
    ...process.env,
    // Stay under ~16GB runner RAM during packager finalize + asar.
    NODE_OPTIONS: "--max-old-space-size=10240",
    // GHA sets CI=true; silent listr renderer (see patches/@electron-forge+core+7.11.1.patch).
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS ?? "true",
  };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [FORGE_CLI, "package"], {
      env,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });

    console.log(
      `[ci-forge-package-windows] spawned forge pid=${child.pid ?? "?"} wrapper-pid=${process.pid} cli=${FORGE_CLI}`,
    );

    child.on("error", (err) => {
      console.error("::error::Failed to spawn electron-forge package:", err.message);
      resolve({ code: 1, signal: null, pid: child.pid });
    });

    child.on("close", (code, signal) => {
      resolve({ code: code ?? 1, signal: signal ?? null, pid: child.pid });
    });
  });
}

async function main() {
  console.log("[ci-forge-package-windows] starting electron-forge package");
  logPackagingStep("ci-forge-package-windows:start", {
    detail: `wrapper-pid=${process.pid}`,
  });

  const forgeDone = startForgePackage();
  const deadline = Date.now() + TIMEOUT_MS;
  let forgeResult = null;
  let loggedEarlyExit = false;
  let earlyExitAt = null;
  let lastMemLog = Date.now();

  while (Date.now() < deadline) {
    if (packageReady()) {
      forgeResult ??= await forgeDone;
      if (forgeResult.code !== 0) {
        console.warn(
          `[ci-forge-package-windows] forge exited ${forgeResult.code} but ${PACKAGE_DIR} exists; continuing`,
        );
      }
      logPackagingStep("ci-forge-package-windows:success", { detail: PACKAGE_DIR });
      logBuildPathSizes(PACKAGE_DIR, "final package dir");
      console.log(`[ci-forge-package-windows] OK: ${PACKAGE_DIR}`);
      return 0;
    }

    if (shouldLogPackagingDiagnostics() && Date.now() - lastMemLog >= MEM_LOG_EVERY_MS) {
      lastMemLog = Date.now();
      logPackagingStep("ci-forge-package-windows:waiting", {
        detail: `no ${PACKAGE_DIR} yet | wrapper ${formatMemory()}`,
      });
      if (fs.existsSync(path.join(process.cwd(), "out"))) {
        try {
          const outEntries = fs.readdirSync(path.join(process.cwd(), "out"));
          console.log(`[ci-forge-package-windows] out/ entries: ${outEntries.join(", ") || "(empty)"}`);
        } catch {
          /* ignore */
        }
      }
    }

    if (forgeResult !== null) {
      // forge has already exited — use a real sleep so setTimeout callbacks can fire.
      // Racing an already-resolved Promise creates a tight microtask loop that starves
      // the macrotask queue: abandoned sleep() timers never fire, their promises pile up,
      // and the wrapper heap explodes to OOM without doing any useful work.
      await sleep(POLL_MS);
    } else {
      const pending = Promise.race([forgeDone, sleep(POLL_MS).then(() => null)]);
      const maybe = await pending;
      if (maybe !== null) {
        forgeResult = maybe;
        if (forgeResult.code !== 0) {
          console.error(
            `::error::electron-forge package exited ${forgeResult.code} before ${PACKAGE_DIR} existed`,
          );
          if (forgeResult.signal) {
            console.error(`::error::signal: ${forgeResult.signal}`);
          }
          logPackagingStep("ci-forge-package-windows:failed", {
            detail: `forge exit ${forgeResult.code}`,
          });
          return forgeResult.code;
        }
        if (!loggedEarlyExit) {
          loggedEarlyExit = true;
          earlyExitAt = Date.now();
          console.warn(
            "[ci-forge-package-windows] forge exited 0 but package dir missing; waiting for electron-packager…",
          );
          logPackagingStep("ci-forge-package-windows:forge-exit-0-still-waiting", {
            detail: `forge-pid=${forgeResult.pid ?? "?"}`,
          });
        }
      }
    }

    if (
      earlyExitAt !== null &&
      Date.now() - earlyExitAt >= EARLY_EXIT_GRACE_MS &&
      !packageReady()
    ) {
      console.error(
        `::error::forge exited 0 but ${PACKAGE_DIR} still missing after ${EARLY_EXIT_GRACE_MS / 60_000}m (listr finished before packager; check @electron-forge patch)`,
      );
      logPackagingStep("ci-forge-package-windows:early-exit-grace-expired", {
        detail: `forge-pid=${forgeResult?.pid ?? "?"}`,
      });
      return 1;
    }
  }

  forgeResult ??= await forgeDone;
  logPackagingStep("ci-forge-package-windows:timeout", {
    detail: `forge exit ${forgeResult.code}`,
  });
  console.error(
    `::error::Timed out after ${TIMEOUT_MS / 60_000}m waiting for ${PACKAGE_DIR} (forge exit ${forgeResult.code})`,
  );
  return 1;
}

process.exit(await main());
