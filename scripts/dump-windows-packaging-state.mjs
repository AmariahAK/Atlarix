#!/usr/bin/env node
/**
 * CLI: full Windows packaging state dump (release CI post-mortem or manual).
 *
 * Usage:
 *   node scripts/dump-windows-packaging-state.mjs --label pre-build
 *   node scripts/dump-windows-packaging-state.mjs --label post-mortem
 */
import { dumpFullWindowsPackagingState } from "./windows-packaging-debug.mjs";

function parseLabel(argv) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--label" && argv[i + 1]) return argv[++i];
  }
  return "manual";
}

const label = parseLabel(process.argv);
dumpFullWindowsPackagingState(label);
process.exit(0);
