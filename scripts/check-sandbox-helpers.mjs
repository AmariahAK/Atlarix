#!/usr/bin/env node
/**
 * Type-check BOTH Rust sandbox helpers against their real target triples, from any
 * host.
 *
 * WHY THIS EXISTS: each helper starts with `#![cfg(windows)]` / `#![cfg(target_os =
 * "linux")]`, so on a macOS dev machine `cargo build` compiles an EMPTY binary and
 * reports success. That is not a hypothetical gap — it is how the Windows
 * AppContainer helper shipped for several releases with code that broke `bash.exe`
 * and git: it compiled on every machine that ever looked at it, and CI only ever
 * ran `cargo build` too.
 *
 * `cargo check --target <triple>` sets `cfg(windows)` / `cfg(target_os = "linux")`
 * for real and type-checks the actual body. It needs no cross-linker because
 * `check` never links — only the target's std, via `rustup target add`.
 *
 * This catches compile-level mistakes only. Behaviour is still the `sandbox` probe's
 * job (`src/main/self-test.ts`), which runs in every CI package job.
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TAG = "check-sandbox-helpers";
const ROOT = process.cwd();

/**
 * ONE ROW PER (helper, target). `atlarix-cu` needs three triples — two darwin and
 * one windows — so a single `target` per helper no longer expresses the matrix, and
 * the closing count is a count of PAIRS.
 */
const HELPERS = [
  { name: "atlarix-sandbox", target: "x86_64-pc-windows-msvc", dir: "native/atlarix-sandbox" },
  {
    name: "atlarix-sandbox-linux",
    target: "x86_64-unknown-linux-gnu",
    dir: "native/atlarix-sandbox-linux",
  },
  // The computer-use helper: macOS Vision OCR + the private-SPI probe + the public
  // CGEventPostToPid fallback, and Windows.Media.Ocr. No linux row — Linux OCR goes
  // through `tesseract` from TypeScript, so the crate has no linux body to check.
  { name: "atlarix-cu", target: "aarch64-apple-darwin", dir: "native/atlarix-cu" },
  { name: "atlarix-cu", target: "x86_64-apple-darwin", dir: "native/atlarix-cu" },
  { name: "atlarix-cu", target: "x86_64-pc-windows-msvc", dir: "native/atlarix-cu" },
];

function installedTargets() {
  try {
    return execSync("rustup target list --installed", { encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

let cargoOk = true;
try {
  execFileSync("cargo", ["--version"], { stdio: "ignore" });
} catch {
  cargoOk = false;
}
if (!cargoOk) {
  // Not every contributor has Rust. Skip rather than fail — CI does have it.
  console.log(`[${TAG}] cargo not found; skipping (CI enforces this)`);
  process.exit(0);
}

const targets = installedTargets();
let failed = false;
let checked = 0;

for (const helper of HELPERS) {
  const manifest = path.join(ROOT, helper.dir, "Cargo.toml");
  if (!fs.existsSync(manifest)) {
    console.error(`::error::[${TAG}] missing manifest: ${manifest}`);
    failed = true;
    continue;
  }
  if (!targets.includes(helper.target)) {
    // A MISSING TARGET IS A FAILURE UNDER CI, NOT A WARNING.
    //
    // This used to warn and continue everywhere, which reintroduces the exact hole
    // the script exists to close: an unchecked `#![cfg]`-gated crate compiles to an
    // empty binary and reports success. A warning in a green log is not a control.
    // Locally it stays a warning — not every contributor installs five triples —
    // but CI must have them, and the darwin ones are the least likely to be present
    // on a contributor's machine, which is precisely why they need enforcing.
    const msg =
      `target ${helper.target} not installed — ${helper.name} NOT type-checked. ` +
      `Install it with: rustup target add ${helper.target}`;
    if (process.env.CI) {
      console.error(`::error::[${TAG}] ${msg}`);
      failed = true;
    } else {
      console.log(`::warning::[${TAG}] ${msg}`);
    }
    continue;
  }

  console.log(`[${TAG}] cargo check ${helper.name} --target ${helper.target}`);
  try {
    execFileSync(
      "cargo",
      ["check", "--quiet", "--manifest-path", manifest, "--target", helper.target],
      { stdio: "inherit" },
    );
    checked++;
  } catch {
    console.error(`::error::[${TAG}] ${helper.name} failed to type-check for ${helper.target}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`[${TAG}] OK — ${checked}/${HELPERS.length} (helper, target) pair(s) type-checked`);
