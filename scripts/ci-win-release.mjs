#!/usr/bin/env node
/**
 * Windows CI: win-ci-vite.mjs then win-ci-package.mjs (separate Node processes).
 *
 * Used from release.yml via `npm run ci:make:win`. Step 1 frees Vite heap before packager.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatMemory,
  logBuildPathSizes,
  logPackagingStep,
  shouldLogPackagingDiagnostics,
} from "./packaging-diagnostics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIN_CI_VITE = path.join(__dirname, "win-ci-vite.mjs");
const WIN_CI_PACKAGE = path.join(__dirname, "win-ci-package.mjs");
const POLL_MS = 5_000;
const MEM_LOG_EVERY_MS = 30_000;
const TIMEOUT_MS = 150 * 60 * 1_000;
const EARLY_EXIT_GRACE_MS = 10 * 60 * 1_000;
/** Fail fast when package child exits 0 almost immediately (OOM / abort). */
const FAST_FAIL_MS = 120 * 1_000;
const APP = "Atlarix";
const PLATFORM = "win32";
const ARCH = "x64";
const PACKAGE_DIR = path.join(process.cwd(), "out", `${APP}-${PLATFORM}-${ARCH}`);

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

function spawnScript(scriptPath, label) {
  const env = {
    ...process.env,
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS ?? "true",
  };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      env,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });

    console.log(
      `[ci-win-release] spawned ${label} pid=${child.pid ?? "?"} wrapper-pid=${process.pid}`,
    );

    child.on("error", (err) => {
      console.error(`::error::Failed to spawn ${label}:`, err.message);
      resolve({ code: 1, signal: null, pid: child.pid, startedAt: Date.now() });
    });

    child.on("close", (code, signal) => {
      resolve({
        code: code ?? 1,
        signal: signal ?? null,
        pid: child.pid,
        startedAt: child.startedAt,
      });
    });

    child.startedAt = Date.now();
  });
}

async function runViteStep() {
  console.log("[ci-win-release] step 1: win-ci-vite");
  logPackagingStep("ci-win-release:vite-start");
  const result = await spawnScript(WIN_CI_VITE, "win-ci-vite");
  if (result.code !== 0) {
    console.error(`::error::win-ci-vite exited ${result.code}`);
    if (result.signal) console.error(`::error::signal: ${result.signal}`);
    return result.code;
  }
  logPackagingStep("ci-win-release:vite-done");
  console.log("[ci-win-release] win-ci-vite OK");
  return 0;
}

async function runPackageStep() {
  console.log("[ci-win-release] step 2: win-ci-package");
  logPackagingStep("ci-win-release:package-start");

  const packageDone = spawnScript(WIN_CI_PACKAGE, "win-ci-package");
  const deadline = Date.now() + TIMEOUT_MS;
  let packageResult = null;
  let loggedEarlyExit = false;
  let earlyExitAt = null;
  let lastMemLog = Date.now();

  while (Date.now() < deadline) {
    if (packageResult !== null && packageResult.code === 0) {
      if (!packageReady()) {
        const elapsed = Date.now() - (packageResult.startedAt ?? Date.now());
        if (elapsed < FAST_FAIL_MS) {
          console.error(
            `::error::win-ci-package exited 0 after ${Math.round(elapsed / 1000)}s but ${PACKAGE_DIR} is missing (likely OOM or process abort — check logs above)`,
          );
          logPackagingStep("ci-win-release:fast-fail-early-exit-0", {
            detail: `elapsed=${elapsed}ms`,
          });
          return 1;
        }
        console.error(`::error::win-ci-package exited 0 but ${PACKAGE_DIR} is missing`);
        logPackagingStep("ci-win-release:exit-0-missing-package", {
          detail: `child-pid=${packageResult.pid ?? "?"}`,
        });
        return 1;
      }
      logPackagingStep("ci-win-release:success", { detail: PACKAGE_DIR });
      logBuildPathSizes(PACKAGE_DIR, "final package dir");
      console.log(`[ci-win-release] OK: ${PACKAGE_DIR}`);
      return 0;
    }

    if (packageResult !== null && packageResult.code !== 0) {
      console.error(
        `::error::win-ci-package exited ${packageResult.code} (packageReady=${packageReady()})`,
      );
      if (packageResult.signal) {
        console.error(`::error::signal: ${packageResult.signal}`);
      }
      logPackagingStep("ci-win-release:failed", { detail: `exit ${packageResult.code}` });
      return packageResult.code;
    }

    if (shouldLogPackagingDiagnostics() && Date.now() - lastMemLog >= MEM_LOG_EVERY_MS) {
      lastMemLog = Date.now();
      logPackagingStep("ci-win-release:package-waiting", {
        detail: `packageReady=${packageReady()} | wrapper ${formatMemory()}`,
      });
      if (fs.existsSync(path.join(process.cwd(), "out"))) {
        try {
          const outEntries = fs.readdirSync(path.join(process.cwd(), "out"));
          console.log(`[ci-win-release] out/ entries: ${outEntries.join(", ") || "(empty)"}`);
        } catch {
          /* ignore */
        }
      }
    }

    if (packageResult !== null) {
      await sleep(POLL_MS);
    } else {
      const pending = Promise.race([packageDone, sleep(POLL_MS).then(() => null)]);
      const maybe = await pending;
      if (maybe !== null) {
        packageResult = maybe;
        if (packageResult.code !== 0) continue;
        if (!packageReady()) {
          const elapsed = Date.now() - (packageResult.startedAt ?? Date.now());
          if (elapsed < FAST_FAIL_MS) {
            console.error(
              `::error::win-ci-package exited 0 after ${Math.round(elapsed / 1000)}s without ${PACKAGE_DIR} (likely OOM — check logs)`,
            );
            logPackagingStep("ci-win-release:fast-fail-early-exit-0", {
              detail: `elapsed=${elapsed}ms`,
            });
            return 1;
          }
          if (!loggedEarlyExit) {
            loggedEarlyExit = true;
            earlyExitAt = Date.now();
            console.warn(
              "[ci-win-release] win-ci-package exited 0 but package dir missing; waiting…",
            );
            logPackagingStep("ci-win-release:exit-0-still-waiting", {
              detail: `child-pid=${packageResult.pid ?? "?"}`,
            });
          }
        }
      }
    }

    if (
      earlyExitAt !== null &&
      Date.now() - earlyExitAt >= EARLY_EXIT_GRACE_MS &&
      !packageReady()
    ) {
      console.error(
        `::error::win-ci-package exited 0 but ${PACKAGE_DIR} still missing after ${EARLY_EXIT_GRACE_MS / 60_000}m`,
      );
      logPackagingStep("ci-win-release:early-exit-grace-expired", {
        detail: `child-pid=${packageResult?.pid ?? "?"}`,
      });
      return 1;
    }
  }

  packageResult ??= await packageDone;
  logPackagingStep("ci-win-release:timeout", { detail: `exit ${packageResult.code}` });
  console.error(
    `::error::Timed out after ${TIMEOUT_MS / 60_000}m (win-ci-package exit ${packageResult.code}, packageReady=${packageReady()})`,
  );
  return 1;
}

async function main() {
  console.log("[ci-win-release] Windows release (split Vite + package processes)");
  logPackagingStep("ci-win-release:start", { detail: `wrapper-pid=${process.pid}` });

  const viteCode = await runViteStep();
  if (viteCode !== 0) return viteCode;

  return runPackageStep();
}

process.exit(await main());
