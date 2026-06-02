#!/usr/bin/env node
/**
 * Child process: run @electron/packager to completion (Windows CI).
 * Invoked via spawnSync from win-ci-package.mjs so the parent waits for exit code.
 */
import {
  assertMainJs,
  logFailureContext,
  packageAppDirect,
  registerFatalHandlers,
} from "./win-ci-lib.mjs";

const TAG = "win-ci-packager-worker";

registerFatalHandlers(TAG);

async function main() {
  assertMainJs(TAG);
  await packageAppDirect(TAG);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[${TAG}] fatal:`, err);
    logFailureContext(TAG);
    process.exit(1);
  });
