#!/usr/bin/env node
/**
 * Windows CI: run electron-forge package and block until out/Atlarix-win32-x64 exists.
 *
 * GHA windows-latest often returns from forge while electron-packager is still running.
 * Unset CI so listr uses the silent renderer (same as macOS/Linux), then poll for output.
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
const TIMEOUT_MS = 90 * 60 * 1_000;
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
    // Stay under ~16GB runner RAM; ASAR disabled on win CI reduces peak during finalize.
    NODE_OPTIONS: "--max-old-space-size=10240",
    CI: "",
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
  console.log("[ci-forge-package-windows] starting electron-forge package (unpacked asar on win CI)");
  logPackagingStep("ci-forge-package-windows:start", {
    detail: `wrapper-pid=${process.pid}`,
  });

  const forgeDone = startForgePackage();
  const deadline = Date.now() + TIMEOUT_MS;
  let forgeResult = null;
  let loggedEarlyExit = false;
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
        console.warn(
          "[ci-forge-package-windows] forge exited 0 but package dir missing; waiting for electron-packager…",
        );
        logPackagingStep("ci-forge-package-windows:forge-exit-0-still-waiting", {
          detail: `forge-pid=${forgeResult.pid ?? "?"}`,
        });
      }
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
