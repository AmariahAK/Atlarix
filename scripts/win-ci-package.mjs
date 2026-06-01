#!/usr/bin/env node
/**
 * Windows CI step 2: electron-packager (subprocess) + make --skip-package.
 * Requires win-ci-vite.mjs to have run first (.vite/build/main.js).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_DIR,
  assertMainJs,
  dumpFailureDiagnostics,
  registerFatalHandlers,
  runMakeSkipPackage,
} from "./win-ci-lib.mjs";
import { logPackagingStep, formatMemory } from "./packaging-diagnostics.mjs";

const TAG = "win-ci-package";
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "win-ci-packager-worker.mjs");

registerFatalHandlers(TAG);

console.log(`[${TAG}] packager + installers (spawnSync packager worker)`);
console.log(
  `[${TAG}] instrumentation: [win-packager-phase] [win-packager-snapshot] [win-packager-heartbeat] (see win-ci-packager-instrumentation.mjs)`,
);
const mem = process.memoryUsage();
const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
console.log(
  `[${TAG}] memory at start: heapUsed=${mib(mem.heapUsed)} rss=${mib(mem.rss)} (expect well under 500 MiB)`,
);
logPackagingStep(`${TAG}:start`, { detail: formatMemory() });

assertMainJs(TAG);

console.log(`[${TAG}] spawning packager worker: node ${path.basename(WORKER)}`);
const packagerRun = spawnSync(process.execPath, [WORKER], {
  stdio: "inherit",
  env: process.env,
  cwd: process.cwd(),
  windowsHide: true,
});

if (packagerRun.error) {
  console.error(`[${TAG}] failed to spawn packager worker:`, packagerRun.error);
  dumpFailureDiagnostics(TAG);
  process.exit(1);
}

const packagerCode = packagerRun.status ?? 1;
if (packagerCode !== 0) {
  console.error(`::error::[${TAG}] packager worker exited ${packagerCode}`);
  if (packagerRun.signal) {
    console.error(`::error::signal: ${packagerRun.signal}`);
  }
  dumpFailureDiagnostics(TAG);
  process.exit(packagerCode);
}

if (!fs.existsSync(PACKAGE_DIR)) {
  console.error(`::error::[${TAG}] Package dir missing after packager worker: ${PACKAGE_DIR}`);
  dumpFailureDiagnostics(TAG);
  process.exit(1);
}

console.log(`[${TAG}] packager worker OK: ${PACKAGE_DIR}`);

runMakeSkipPackage(TAG);
logPackagingStep(`${TAG}:done`);
console.log(`[${TAG}] complete`);
