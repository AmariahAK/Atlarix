#!/usr/bin/env node
/**
 * Windows CI: run win-ci-build.mjs and block until the packaged app exists.
 *
 * Used from release.yml via `npm run ci:make:win`. Polls for out/Atlarix-win32-x64
 * while the child runs; catches early exit / npm exit-code quirks on GHA.
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
const WIN_CI_BUILD = path.join(__dirname, "win-ci-build.mjs");
const POLL_MS = 5_000;
const MEM_LOG_EVERY_MS = 30_000;
const TIMEOUT_MS = 150 * 60 * 1_000;
const EARLY_EXIT_GRACE_MS = 10 * 60 * 1_000;
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

function startWinCiBuild() {
  const env = {
    ...process.env,
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS ?? "true",
  };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WIN_CI_BUILD], {
      env,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });

    console.log(
      `[ci-win-release] spawned win-ci-build pid=${child.pid ?? "?"} wrapper-pid=${process.pid} script=${WIN_CI_BUILD}`,
    );

    child.on("error", (err) => {
      console.error("::error::Failed to spawn win-ci-build:", err.message);
      resolve({ code: 1, signal: null, pid: child.pid });
    });

    child.on("close", (code, signal) => {
      resolve({ code: code ?? 1, signal: signal ?? null, pid: child.pid });
    });
  });
}

async function main() {
  console.log("[ci-win-release] starting win-ci-build");
  logPackagingStep("ci-win-release:start", { detail: `wrapper-pid=${process.pid}` });

  const buildDone = startWinCiBuild();
  const deadline = Date.now() + TIMEOUT_MS;
  let buildResult = null;
  let loggedEarlyExit = false;
  let earlyExitAt = null;
  let lastMemLog = Date.now();

  while (Date.now() < deadline) {
    if (buildResult !== null && buildResult.code === 0) {
      if (!packageReady()) {
        console.error(`::error::win-ci-build exited 0 but ${PACKAGE_DIR} is missing`);
        logPackagingStep("ci-win-release:exit-0-missing-package", {
          detail: `child-pid=${buildResult.pid ?? "?"}`,
        });
        return 1;
      }
      logPackagingStep("ci-win-release:success", { detail: PACKAGE_DIR });
      logBuildPathSizes(PACKAGE_DIR, "final package dir");
      console.log(`[ci-win-release] OK: ${PACKAGE_DIR}`);
      return 0;
    }

    if (buildResult !== null && buildResult.code !== 0) {
      console.error(
        `::error::win-ci-build exited ${buildResult.code} before success (packageReady=${packageReady()})`,
      );
      if (buildResult.signal) {
        console.error(`::error::signal: ${buildResult.signal}`);
      }
      logPackagingStep("ci-win-release:failed", {
        detail: `exit ${buildResult.code}`,
      });
      return buildResult.code;
    }

    if (shouldLogPackagingDiagnostics() && Date.now() - lastMemLog >= MEM_LOG_EVERY_MS) {
      lastMemLog = Date.now();
      logPackagingStep("ci-win-release:waiting", {
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

    if (buildResult !== null) {
      await sleep(POLL_MS);
    } else {
      const pending = Promise.race([buildDone, sleep(POLL_MS).then(() => null)]);
      const maybe = await pending;
      if (maybe !== null) {
        buildResult = maybe;
        if (buildResult.code !== 0) {
          continue;
        }
        if (!packageReady()) {
          if (!loggedEarlyExit) {
            loggedEarlyExit = true;
            earlyExitAt = Date.now();
            console.warn(
              "[ci-win-release] win-ci-build exited 0 but package dir missing; waiting…",
            );
            logPackagingStep("ci-win-release:exit-0-still-waiting", {
              detail: `child-pid=${buildResult.pid ?? "?"}`,
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
        `::error::win-ci-build exited 0 but ${PACKAGE_DIR} still missing after ${EARLY_EXIT_GRACE_MS / 60_000}m`,
      );
      logPackagingStep("ci-win-release:early-exit-grace-expired", {
        detail: `child-pid=${buildResult?.pid ?? "?"}`,
      });
      return 1;
    }
  }

  buildResult ??= await buildDone;
  logPackagingStep("ci-win-release:timeout", {
    detail: `exit ${buildResult.code}`,
  });
  console.error(
    `::error::Timed out after ${TIMEOUT_MS / 60_000}m (win-ci-build exit ${buildResult.code}, packageReady=${packageReady()})`,
  );
  return 1;
}

process.exit(await main());
