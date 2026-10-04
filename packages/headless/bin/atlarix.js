#!/usr/bin/env node
/**
 * `atlarix` from npm. Runs this platform's compiled CLI — the interactive
 * terminal app, the same binary as the curl / Homebrew / winget installs — from
 * its `atlarix-<os>-<arch>` package (an optional dependency, so npm installs
 * only the one that fits).
 *
 * With no matching package (an unusual platform, or `--no-optional`), it runs
 * the bundled Node build instead: the batch agent (`atlarix run …`) that CI,
 * the cloud agent and benchmarks use. So `npx atlarix run …` works everywhere.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);

function isMusl() {
  if (process.platform !== "linux") return false;
  try {
    return !process.report?.getReport()?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

const os = process.platform === "win32" ? "windows" : process.platform;
const name = `atlarix-${os}-${process.arch}${isMusl() ? "-musl" : ""}`;
const exe = process.platform === "win32" ? "atlarix.exe" : "atlarix";

let binary = null;
try {
  binary = require.resolve(`${name}/bin/${exe}`);
} catch {
  /* not installed for this platform */
}

if (binary) {
  const r = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
  if (r.error) {
    console.error(`atlarix: could not start ${binary}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.signal) process.kill(process.pid, r.signal);
  process.exit(r.status ?? 1);
}

const batch = process.argv.slice(2).some((a) => a === "run" || a.startsWith("--prompt") || a === "--version" || a === "-v");
if (!batch) {
  console.error(
    `atlarix: the interactive CLI isn't installed for ${os}-${process.arch} (package ${name}).\n` +
      "Install it from https://atlarix.dev/install, or reinstall without --no-optional.\n" +
      "Scripts and CI can still use `atlarix run --prompt …`.",
  );
  process.exit(1);
}
// The Node build needs better-sqlite3, which is NOT a dependency of this
// package: every platform with a prebuilt CLI (all seven we publish) never
// reaches this line, and carrying it cost everyone 40 packages and a native
// download on `npm install -g atlarix` (2026-10-04). The rare platform without
// one installs it beside atlarix, where Node's lookup finds it.
try {
  require.resolve("better-sqlite3");
} catch {
  console.error(
    `atlarix: no prebuilt CLI for ${os}-${process.arch}, and the Node fallback needs better-sqlite3.\n` +
      "Install it beside atlarix: npm install -g better-sqlite3",
  );
  process.exit(1);
}
await import(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist-headless", "atlarix-headless.mjs"));
