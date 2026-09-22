#!/usr/bin/env node
/**
 * Run electron-forge with a V8 heap sized to THIS machine.
 *
 * `package`, `make` and `publish` used to hardcode
 * `cross-env NODE_OPTIONS=--max-old-space-size=8192`. On a 16 GB workstation
 * that is a reasonable ceiling. On the 8 GB MacBook Air this repo is developed
 * on, it tells V8 it may grow one heap to the entire machine's RAM — and V8
 * takes that literally, because `--max-old-space-size` is a promise about how
 * far it may grow before it must collect, not a reservation it checks against
 * what is free.
 *
 * Measured consequence, packaging on the 8 GB machine: 4% free memory and
 * 39.7 GB of a 41 GB swap file in use, `kernel_task` at 151% CPU (macOS
 * throttling a thrashing system), every app on the machine lagging, ending in a
 * hard restart.
 *
 * THE HISTORY MATTERS HERE, because it says this flag never had a reason to be
 * on the local path. `a08a802f` ("fix(release): Windows package OOM") removed
 * the forced 8192 from `ci:package` / `ci:installers` precisely because forcing
 * it CAUSED the OOM it was meant to prevent. CI has run without it ever since.
 * The constant survived only on the three scripts a developer runs by hand — the
 * one place nobody re-measured.
 *
 * So: half the machine, floored at 2 GB so a small machine still gets a workable
 * heap, capped at 8 GB so a large one does not hand V8 a number so big it stops
 * collecting until the machine is in trouble.
 *
 *   8 GB  → 4096 MB   (was 8192 — the setting that took the machine down)
 *   16 GB → 8192 MB   (unchanged in practice)
 *   64 GB → 8192 MB   (capped; more heap is not the constraint at that size)
 *
 * `ATLARIX_PACKAGE_HEAP_MB` overrides it. An inherited `NODE_OPTIONS` that
 * already sets a heap size is left alone — an explicit caller outranks this.
 */

import { spawn } from "node:child_process";
import os from "node:os";
import { resolveHeapMb } from "./lib/machine-limits.mjs";

const MB = 1024 * 1024;

const forgeArgs = process.argv.slice(2);
if (forgeArgs.length === 0) {
  console.error("usage: forge-with-heap.mjs <package|make|publish> [args…]");
  process.exit(2);
}

const inherited = process.env.NODE_OPTIONS ?? "";
const alreadySized = /--max-old-space-size=/.test(inherited);
const heapMb = resolveHeapMb(os.totalmem(), process.env);
const nodeOptions = alreadySized
  ? inherited
  : `${inherited} --max-old-space-size=${heapMb}`.trim();

console.log(
  alreadySized
    ? `[forge] heap: inherited from NODE_OPTIONS (${inherited.trim()})`
    : `[forge] heap: ${heapMb} MB (machine has ${Math.round(os.totalmem() / MB)} MB)`,
);

// `npx` rather than a bare binary name so this works the same on Windows, where
// the executable is `electron-forge.cmd` and a bare spawn without a shell fails.
const child = spawn("npx", ["electron-forge", ...forgeArgs], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});
child.on("close", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error(`[forge] failed to start: ${err.message}`);
  process.exit(1);
});
