#!/usr/bin/env node
/**
 * Windows CI step 1: production Vite bundles only (Forge prePackage).
 * Exits after build so packager runs in a fresh Node process with empty heap.
 */
import {
  buildProductionViteBundles,
  logFailureContext,
  registerFatalHandlers,
} from "./win-ci-lib.mjs";

const TAG = "win-ci-vite";

registerFatalHandlers(TAG);

async function main() {
  console.log(`[${TAG}] production Vite build (Forge prePackage)`);
  await buildProductionViteBundles(TAG);
  console.log(`[${TAG}] OK: .vite/build ready`);
}

main().catch((err) => {
  console.error(`[${TAG}] fatal:`, err);
  logFailureContext(TAG);
  process.exit(1);
});
