#!/usr/bin/env node
/**
 * Windows CI step 2: electron-packager + packageAfterPrune + make --skip-package.
 * Requires win-ci-vite.mjs to have run first (.vite/build/main.js).
 */
import fs from "node:fs";
import {
  PACKAGE_DIR,
  assertMainJs,
  dumpFailureDiagnostics,
  packageAppDirect,
  registerFatalHandlers,
  runMakeSkipPackage,
} from "./win-ci-lib.mjs";
import { logPackagingStep, formatMemory } from "./packaging-diagnostics.mjs";

const TAG = "win-ci-package";

registerFatalHandlers(TAG);

async function main() {
  console.log(`[${TAG}] packager + installers (fresh Node process)`);
  const mem = process.memoryUsage();
  const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
  console.log(
    `[${TAG}] memory at start: heapUsed=${mib(mem.heapUsed)} rss=${mib(mem.rss)} (expect well under 500 MiB)`,
  );
  logPackagingStep(`${TAG}:start`, { detail: formatMemory() });

  assertMainJs(TAG);
  await packageAppDirect(TAG);

  if (!fs.existsSync(PACKAGE_DIR)) {
    console.error(`::error::[${TAG}] Package dir missing before make: ${PACKAGE_DIR}`);
    dumpFailureDiagnostics(TAG);
    process.exit(1);
  }

  runMakeSkipPackage(TAG);
  logPackagingStep(`${TAG}:done`);
  console.log(`[${TAG}] complete`);
}

main().catch((err) => {
  console.error(`[${TAG}] fatal:`, err);
  dumpFailureDiagnostics(TAG);
  process.exit(1);
});
