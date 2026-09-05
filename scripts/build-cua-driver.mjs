#!/usr/bin/env node
/**
 * Build the pinned cua-driver binary and stage it at `native/.dist/cua-driver[.exe]`.
 *
 * Usage: node scripts/build-cua-driver.mjs --target <triple>
 *        (or --arch arm64|x64 on darwin/win/linux, resolved to a triple)
 *
 * WHY A STAGING DIRECTORY: `forge.config.ts`'s `extraResource` is a statically
 * evaluated array with no access to the requested `--arch`, but `build-macos` is an
 * `arch: [arm64, x64]` matrix and cargo writes to `target/<triple>/release/`. Staging
 * gives forge one arch-agnostic path.
 *
 * THE HAZARD THAT INTRODUCES, and its guard: a stale `native/.dist/` from a previous
 * arch would be packaged silently. `npm run clean` only rimrafs `out` and
 * `scaffold/node_modules`, so it will not help. Hence: delete first, then assert the
 * arch of what we produced. `verify-ci-package-out.mjs` asserts it again on the copy
 * inside the package, because that is the artifact that ships.
 *
 * TWO ENVIRONMENT SETTINGS THAT ARE NOT OPTIONAL. `cargo install --git` honours
 * neither the package's `.cargo/config.toml` (cargo discovers config from the CWD
 * upward, not from the package) nor its `rust-toolchain.toml`. Both confirmed
 * observationally 2026-09-04. So we set them here:
 *   - macOS: MACOSX_DEPLOYMENT_TARGET=13.0 (upstream's floor)
 *   - Windows: RUSTFLAGS=-C target-feature=+crt-static, or the shipped exe needs the
 *     VC++ redistributable — and it will start fine on every CI runner and every dev
 *     box, failing only for users.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertBinaryArch, archForTriple } from "./binary-arch.mjs";
import { argValue } from "./cli-args.mjs";

const TAG = "build-cua-driver";
const ROOT = process.cwd();
const DIST = path.join(ROOT, "native/.dist");
const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, "native/cua-driver/PIN.json"), "utf8"));

const TRIPLES = {
  darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
  win32: { arm64: "aarch64-pc-windows-msvc", x64: "x86_64-pc-windows-msvc" },
  linux: { arm64: "aarch64-unknown-linux-gnu", x64: "x86_64-unknown-linux-gnu" },
};

// Shared so `--arch=x64` and `--arch x64` both work. The local version handled
// only the space form, which silently built the HOST arch for the x64 matrix leg.
function arg(name) {
  return argValue(process.argv, name);
}

const explicitTarget = arg("target");
const arch = arg("arch") ?? process.arch;
const target = explicitTarget ?? TRIPLES[process.platform]?.[arch];
if (!target) {
  console.error(`::error::[${TAG}] cannot resolve a target for ${process.platform}/${arch}`);
  process.exit(1);
}

const exe = process.platform === "win32" ? ".exe" : "";
const staged = path.join(DIST, `cua-driver${exe}`);

// Delete FIRST. A failed build must not leave the previous arch's binary behind
// looking like a success.
fs.rmSync(staged, { force: true });

const installRoot = path.join(DIST, `.cargo-root-${target}`);
fs.rmSync(installRoot, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const env = { ...process.env };
if (target.includes("apple-darwin")) env.MACOSX_DEPLOYMENT_TARGET = "13.0";
if (target.includes("windows-msvc")) {
  env.RUSTFLAGS = [env.RUSTFLAGS, "-C target-feature=+crt-static"].filter(Boolean).join(" ");
}

const args = [
  "install",
  "--locked", // keep it: reproducibility is the point. It WARNS about a yanked
  // `chacha20` in upstream's lockfile — that warning is expected, and
  // dropping the flag to silence it is the wrong fix.
  "--git",
  PIN.repo,
  "--rev",
  PIN.rev,
  PIN.package,
  "--target",
  target,
  "--root",
  installRoot,
];

console.log(`[${TAG}] cargo ${args.join(" ")}`);
console.log(`[${TAG}] env: MACOSX_DEPLOYMENT_TARGET=${env.MACOSX_DEPLOYMENT_TARGET ?? "-"} RUSTFLAGS=${env.RUSTFLAGS ?? "-"}`);
try {
  execFileSync("cargo", args, { stdio: "inherit", env });
} catch {
  console.error(`::error::[${TAG}] cargo install failed for ${target}`);
  process.exit(1);
}

const built = path.join(installRoot, "bin", `${PIN.package}${exe}`);
if (!fs.existsSync(built)) {
  console.error(`::error::[${TAG}] cargo reported success but ${built} is missing`);
  process.exit(1);
}
fs.copyFileSync(built, staged);
if (process.platform !== "win32") fs.chmodSync(staged, 0o755);
fs.rmSync(installRoot, { recursive: true, force: true });

// Assert what we actually produced, not what we asked for.
try {
  const archs = assertBinaryArch(staged, archForTriple(target), TAG);
  const { size } = fs.statSync(staged);
  console.log(
    `[${TAG}] OK — ${staged} (${archs.join("+")}, ${(size / 1024 / 1024).toFixed(1)} MB, ` +
      `${PIN.package} v${PIN.version} @ ${PIN.rev.slice(0, 12)})`,
  );
} catch (e) {
  console.error(`::error::${e.message}`);
  process.exit(1);
}
