#!/usr/bin/env node
/**
 * Windows CI: run electron-forge package and block until out/Atlarix-win32-x64 exists.
 *
 * Prefer `npm run ci:package` in release.yml (same as macOS/Linux). Use this wrapper
 * (npm run ci:package:win) only as escalation if forge exits 0 without out/ on GHA.
 *
 * With ATLARIX_WINDOWS_PACKAGING_DEBUG=1 (default on GHA build-windows), emits full
 * snapshots via windows-packaging-debug.mjs at key steps.
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
import {
  dumpFullWindowsPackagingState,
  isWindowsDeepDebug,
} from "./windows-packaging-debug.mjs";

const require = createRequire(import.meta.url);
const POLL_MS = 5_000;
const MEM_LOG_EVERY_MS = 30_000;
const SNAPSHOT_EVERY_MS = 60_000;
const TIMEOUT_MS = 150 * 60 * 1_000;
const EARLY_EXIT_GRACE_MS = 10 * 60 * 1_000;
const APP = "Atlarix";
const PLATFORM = "win32";
const ARCH = "x64";
const PACKAGE_DIR = path.join(process.cwd(), "out", `${APP}-${PLATFORM}-${ARCH}`);
const FORGE_CLI = require.resolve("@electron-forge/cli/dist/electron-forge.js");

const startedAt = Date.now();
let lastSnapshotAt = 0;

function elapsedMs() {
  return Date.now() - startedAt;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maybeSnapshot(label, opts = {}) {
  if (!isWindowsDeepDebug()) return;
  const now = Date.now();
  const force = opts.force === true;
  if (!force && now - lastSnapshotAt < SNAPSHOT_EVERY_MS) return;
  lastSnapshotAt = now;
  dumpFullWindowsPackagingState(label, {
    forgePid: opts.forgePid,
    detail: opts.detail,
    elapsedMs: elapsedMs(),
  });
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

function logStep(step, detail) {
  logPackagingStep(`ci-forge-package-windows:${step}`, {
    detail: detail ?? formatMemory(),
  });
  console.log(`[ci-forge-package-windows] ${step}${detail ? ` | ${detail}` : ""} | elapsed=${(elapsedMs() / 1000).toFixed(1)}s`);
}

function startForgePackage() {
  const env = {
    ...process.env,
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=8192",
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS ?? "true",
    ATLARIX_WINDOWS_PACKAGING_DEBUG:
      process.env.ATLARIX_WINDOWS_PACKAGING_DEBUG ?? "1",
    ATLARIX_PACKAGING_DEBUG:
      process.env.ATLARIX_PACKAGING_DEBUG ??
      process.env.ATLARIX_WINDOWS_PACKAGING_DEBUG ??
      "1",
  };

  logStep("spawn-forge", `cli=${FORGE_CLI}`);
  if (isWindowsDeepDebug()) {
    console.log(
      `[ci-forge-package-windows] DEBUG namespaces: ${env.DEBUG ?? "(unset)"}`,
    );
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [FORGE_CLI, "package"], {
      env,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });

    console.log(
      `[ci-forge-package-windows] spawned forge pid=${child.pid ?? "?"} wrapper-pid=${process.pid}`,
    );

    child.on("error", (err) => {
      console.error("::error::Failed to spawn electron-forge package:", err.message);
      resolve({ code: 1, signal: null, pid: child.pid });
    });

    child.on("close", (code, signal) => {
      logStep("forge-closed", `code=${code ?? "?"} signal=${signal ?? "none"} pid=${child.pid ?? "?"}`);
      resolve({ code: code ?? 1, signal: signal ?? null, pid: child.pid });
    });
  });
}

async function main() {
  console.log("[ci-forge-package-windows] starting electron-forge package");
  logStep("start", `wrapper-pid=${process.pid}`);
  maybeSnapshot("wrapper-start", { force: true });

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
      logStep("success", PACKAGE_DIR);
      logBuildPathSizes(PACKAGE_DIR, "final package dir");
      maybeSnapshot("wrapper-success", { force: true, forgePid: forgeResult.pid });
      console.log(`[ci-forge-package-windows] OK: ${PACKAGE_DIR}`);
      return 0;
    }

    if (shouldLogPackagingDiagnostics() && Date.now() - lastMemLog >= MEM_LOG_EVERY_MS) {
      lastMemLog = Date.now();
      logStep("waiting", `no ${PACKAGE_DIR} yet | ${formatMemory()}`);
      maybeSnapshot("wrapper-waiting", { forgePid: forgeResult?.pid });
      if (fs.existsSync(path.join(process.cwd(), "out"))) {
        try {
          const outEntries = fs.readdirSync(path.join(process.cwd(), "out"));
          console.log(
            `[ci-forge-package-windows] out/ entries: ${outEntries.join(", ") || "(empty)"}`,
          );
        } catch {
          /* ignore */
        }
      }
    }

    if (forgeResult !== null) {
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
          logStep("failed", `forge exit ${forgeResult.code}`);
          maybeSnapshot("wrapper-forge-nonzero", {
            force: true,
            forgePid: forgeResult.pid,
          });
          return forgeResult.code;
        }
        if (!loggedEarlyExit) {
          loggedEarlyExit = true;
          earlyExitAt = Date.now();
          console.warn(
            "[ci-forge-package-windows] forge exited 0 but package dir missing; waiting for electron-packager…",
          );
          logStep("forge-exit-0-still-waiting", `forge-pid=${forgeResult.pid ?? "?"}`);
          maybeSnapshot("wrapper-forge-exit-0", {
            force: true,
            forgePid: forgeResult.pid,
            detail: "listr may have finished before packager wrote out/",
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
      logStep("early-exit-grace-expired", `forge-pid=${forgeResult?.pid ?? "?"}`);
      maybeSnapshot("wrapper-grace-expired", {
        force: true,
        forgePid: forgeResult?.pid,
        detail: "no out/ after 10m post forge exit 0",
      });
      return 1;
    }
  }

  forgeResult ??= await forgeDone;
  logStep("timeout", `forge exit ${forgeResult.code}`);
  maybeSnapshot("wrapper-timeout", { force: true, forgePid: forgeResult.pid });
  console.error(
    `::error::Timed out after ${TIMEOUT_MS / 60_000}m waiting for ${PACKAGE_DIR} (forge exit ${forgeResult.code})`,
  );
  return 1;
}

main().catch((err) => {
  console.error("[ci-forge-package-windows] fatal:", err);
  if (isWindowsDeepDebug()) {
    dumpFullWindowsPackagingState("wrapper-fatal", {
      force: true,
      detail: err?.message ?? String(err),
      elapsedMs: elapsedMs(),
    });
  }
  process.exit(1);
});
