#!/usr/bin/env node
/**
 * CLI: full Windows packaging state dump (release CI post-mortem or manual).
 *
 * Usage:
 *   node scripts/dump-windows-packaging-state.mjs --label pre-build
 *   node scripts/dump-windows-packaging-state.mjs --label post-build
 *   node scripts/dump-windows-packaging-state.mjs --label post-mortem
 *
 * Local replay (Windows VM):
 *   npm run clean
 *   npm run dump:windows-packaging -- --label pre-build
 *   npm run ci:package:win
 *   npm run dump:windows-packaging -- --label post-build
 */
import { dumpFullWindowsPackagingState } from "./windows-packaging-debug.mjs";

function parseArgs(argv) {
  let label = "manual";
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--label" && argv[i + 1]) label = argv[++i];
  }
  return label;
}

const label = parseArgs(process.argv);
dumpFullWindowsPackagingState(label);
process.exit(0);
