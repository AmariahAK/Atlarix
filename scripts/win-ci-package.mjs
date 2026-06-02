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
  logFailureContext,
  registerFatalHandlers,
  runMakeSkipPackage,
} from "./win-ci-lib.mjs";

const TAG = "win-ci-package";
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "win-ci-packager-worker.mjs");

registerFatalHandlers(TAG);

console.log(`[${TAG}] packager + installers`);

assertMainJs(TAG);

const packagerRun = spawnSync(process.execPath, [WORKER], {
  stdio: "inherit",
  env: process.env,
  cwd: process.cwd(),
  windowsHide: true,
});

if (packagerRun.error) {
  console.error(`[${TAG}] failed to spawn packager worker:`, packagerRun.error);
  logFailureContext(TAG);
  process.exit(1);
}

const packagerCode = packagerRun.status ?? 1;
if (packagerCode !== 0) {
  console.error(`::error::[${TAG}] packager worker exited ${packagerCode}`);
  if (packagerRun.signal) {
    console.error(`::error::signal: ${packagerRun.signal}`);
  }
  logFailureContext(TAG);
  process.exit(packagerCode);
}

if (!fs.existsSync(PACKAGE_DIR)) {
  console.error(`::error::[${TAG}] Package dir missing after packager worker: ${PACKAGE_DIR}`);
  logFailureContext(TAG);
  process.exit(1);
}

console.log(`[${TAG}] packager worker OK: ${PACKAGE_DIR}`);

runMakeSkipPackage(TAG);
console.log(`[${TAG}] complete`);
