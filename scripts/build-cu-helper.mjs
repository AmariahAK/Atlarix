#!/usr/bin/env node
/**
 * Build the first-party `atlarix-cu` helper and stage it at
 * `native/.dist/atlarix-cu[.exe]`.
 *
 * Usage: node scripts/build-cu-helper.mjs --target <triple>
 *        (or --arch arm64|x64)
 *
 * `atlarix-cu` is ours, not vendored: the macOS private-SPI probe, the public
 * `CGEventPostToPid` input fallback, and OS-native OCR (macOS Vision / Windows
 * Windows.Media.Ocr). Linux OCR stays in TypeScript around `tesseract`, so this
 * crate only ever targets darwin and windows.
 *
 * Same staging rationale and the same delete-then-assert-arch guard as
 * build-cua-driver.mjs — see that file's header. This one differs in two ways: it
 * builds a LOCAL crate (so `cargo build`, not `cargo install --git`, and the
 * package's own `.cargo/config.toml` WOULD be honoured), and it is `#![cfg]`-gated
 * per OS, which is exactly why `check-sandbox-helpers.mjs` type-checks it against
 * every triple from the Linux runner: a plain build on the wrong host compiles an
 * empty binary and reports success.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertBinaryArch, archForTriple } from "./binary-arch.mjs";

const TAG = "build-cu-helper";
const ROOT = process.cwd();
const DIST = path.join(ROOT, "native/.dist");
const CRATE = path.join(ROOT, "native/atlarix-cu");
const MANIFEST = path.join(CRATE, "Cargo.toml");

const TRIPLES = {
  darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
  win32: { arm64: "aarch64-pc-windows-msvc", x64: "x86_64-pc-windows-msvc" },
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Linux has no atlarix-cu: no OS OCR to bind, and the input fallback is macOS-only.
// Exit 0 rather than failing, so a single CI step can be shared across platforms.
if (process.platform === "linux" && !arg("target")) {
  console.log(`[${TAG}] no atlarix-cu on linux (OCR goes through tesseract in TS); skipping`);
  process.exit(0);
}

const arch = arg("arch") ?? process.arch;
const target = arg("target") ?? TRIPLES[process.platform]?.[arch];
if (!target) {
  console.error(`::error::[${TAG}] cannot resolve a target for ${process.platform}/${arch}`);
  process.exit(1);
}

if (!fs.existsSync(MANIFEST)) {
  console.error(`::error::[${TAG}] missing ${MANIFEST}`);
  process.exit(1);
}

const exe = process.platform === "win32" ? ".exe" : "";
const staged = path.join(DIST, `atlarix-cu${exe}`);
fs.rmSync(staged, { force: true });
fs.mkdirSync(DIST, { recursive: true });

console.log(`[${TAG}] cargo build --release --target ${target}`);
try {
  execFileSync(
    "cargo",
    ["build", "--release", "--manifest-path", MANIFEST, "--target", target],
    { stdio: "inherit", env: process.env },
  );
} catch {
  console.error(`::error::[${TAG}] cargo build failed for ${target}`);
  process.exit(1);
}

const built = path.join(CRATE, "target", target, "release", `atlarix-cu${exe}`);
if (!fs.existsSync(built)) {
  console.error(`::error::[${TAG}] cargo reported success but ${built} is missing`);
  process.exit(1);
}
fs.copyFileSync(built, staged);
if (process.platform !== "win32") fs.chmodSync(staged, 0o755);

try {
  const archs = assertBinaryArch(staged, archForTriple(target), TAG);
  const { size } = fs.statSync(staged);
  console.log(
    `[${TAG}] OK — ${staged} (${archs.join("+")}, ${(size / 1024).toFixed(0)} KB)`,
  );
} catch (e) {
  console.error(`::error::${e.message}`);
  process.exit(1);
}
