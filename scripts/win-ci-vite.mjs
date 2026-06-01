#!/usr/bin/env node
/**
 * Windows CI step 1: production Vite bundles only (Forge prePackage).
 * Exits after build so packager runs in a fresh Node process with empty heap.
 */
import {
  buildProductionViteBundles,
  dumpFailureDiagnostics,
  registerFatalHandlers,
} from "./win-ci-lib.mjs";
import { logPackagingStep } from "./packaging-diagnostics.mjs";

const TAG = "win-ci-vite";

registerFatalHandlers(TAG);

async function main() {
  console.log(`[${TAG}] production Vite build (Forge prePackage)`);
  logPackagingStep(`${TAG}:start`);
  await buildProductionViteBundles(TAG);
  logPackagingStep(`${TAG}:done`);
  console.log(`[${TAG}] OK: .vite/build ready`);
}

main().catch((err) => {
  console.error(`[${TAG}] fatal:`, err);
  dumpFailureDiagnostics(TAG);
  process.exit(1);
});
