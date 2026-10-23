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
 * ONE ROW PER (helper, target). A helper may need several triples, so a single
 * `target` per helper does not express the matrix — the closing count is a count
 * of PAIRS, and a missing pair is a HARD FAILURE under CI (see below). It was a
 * `::warning::` once, which quietly reopened the hole this script exists to close.
 */
const HELPERS = [
  {
    name: "atlarix-sandbox",
    target: "x86_64-pc-windows-msvc",
    dir: "native/atlarix-sandbox",
  },
  {
    name: "atlarix-sandbox-linux",
    target: "x86_64-unknown-linux-gnu",
    dir: "native/atlarix-sandbox-linux",
  },
  // The bridge relay is NOT cfg-gated the way the two sandbox helpers are — it
  // compiles on every host — so a plain `cargo build` would catch its mistakes.
  // It is listed anyway, on both a unix and a windows triple, because its ONE
  // platform-specific piece is the `connect()` pair: a unix socket on one side
  // and a named pipe on the other, each behind a `#[cfg]`. Exactly the shape
  // this script exists for — the Windows arm compiles nowhere else.
  {
    name: "atlarix-bridge",
    target: "x86_64-pc-windows-msvc",
    dir: "native/atlarix-bridge",
  },
  {
    name: "atlarix-bridge",
    target: "x86_64-unknown-linux-gnu",
    dir: "native/atlarix-bridge",
  },
  // The computer-use executor: its capture, input, DPI and permission code is
  // per-OS (`#[cfg]` arms and per-target dependencies), so each OS is checked.
  // Linux needs the pipewire/xcb headers xcap builds against (release.yml
  // installs them in this job).
  {
    name: "atlarix-computer",
    target: "x86_64-pc-windows-msvc",
    dir: "native/atlarix-computer",
  },
  {
    name: "atlarix-computer",
    target: "x86_64-unknown-linux-gnu",
    dir: "native/atlarix-computer",
  },
  {
    name: "atlarix-computer",
    target: "aarch64-apple-darwin",
    dir: "native/atlarix-computer",
  },
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
      [
        "check",
        "--quiet",
        "--manifest-path",
        manifest,
        "--target",
        helper.target,
      ],
      { stdio: "inherit" },
    );
    checked++;
  } catch {
    console.error(
      `::error::[${TAG}] ${helper.name} failed to type-check for ${helper.target}`,
    );
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(
  `[${TAG}] OK — ${checked}/${HELPERS.length} (helper, target) pair(s) type-checked`,
);
