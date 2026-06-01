#!/usr/bin/env node
/**
 * Child process: run @electron/packager to completion (Windows CI).
 * Invoked via spawnSync from win-ci-package.mjs so the parent cannot exit
 * before packager finishes (Node event loop / handle issue on GHA win32).
 */
import {
  assertMainJs,
  dumpFailureDiagnostics,
  packageAppDirect,
  registerFatalHandlers,
} from "./win-ci-lib.mjs";

const TAG = "win-ci-packager-worker";

registerFatalHandlers(TAG);

try {
  assertMainJs(TAG);
  await packageAppDirect(TAG);
} catch (err) {
  console.error(`[${TAG}] fatal:`, err);
  dumpFailureDiagnostics(TAG);
  process.exit(1);
}
