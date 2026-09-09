#!/usr/bin/env node
/**
 * Windows release build (local): Vite then packager in separate Node processes.
 * Same steps as CI: win-ci-vite.mjs then win-ci-package.mjs.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logFailureContext, registerFatalHandlers } from "./win-ci-lib.mjs";

const TAG = "win-ci-build";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VITE_SCRIPT = path.join(__dirname, "win-ci-vite.mjs");
const PACKAGE_SCRIPT = path.join(__dirname, "win-ci-package.mjs");

registerFatalHandlers(TAG);

function runNodeScript(label, scriptPath) {
  console.log(`\n[${TAG}] ${label}`);
  console.log(`$ node ${path.basename(scriptPath)}`);
  const result = spawnSync(process.execPath, [scriptPath], {
    stdio: "inherit",
    env: process.env,
    shell: false,
  });
  if (result.status !== 0) {
    console.error(
      `::error::[${TAG}] ${label} failed (exit ${result.status ?? "?"})`,
    );
    logFailureContext(TAG);
    process.exit(result.status ?? 1);
  }
}

console.log(`[${TAG}] Windows release build (split Vite + package processes)`);
runNodeScript("vite", VITE_SCRIPT);
runNodeScript("package + make", PACKAGE_SCRIPT);
console.log(`[${TAG}] complete`);
