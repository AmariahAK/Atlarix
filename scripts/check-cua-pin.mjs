#!/usr/bin/env node
/**
 * Validate `native/cua-driver/PIN.json` — the whole of our supply-chain control over
 * the vendored computer-use backend.
 *
 * WHY THIS EXISTS: cua-driver cannot join the `HELPERS` table in
 * check-sandbox-helpers.mjs, because there is no local manifest to `cargo check`
 * — the source is never in this repo. The pin file IS the dependency, so the pin
 * file is what gets checked.
 *
 * It catches the two ways a pin rots:
 *
 *  1. A MOVING REF. `--rev main` or `--rev v0.23.2` looks pinned and is not: the
 *     first is a branch and the second is a tag, and both can be repointed at
 *     different bytes by anyone with push access. Only a full 40-character SHA is
 *     immutable, and that is the difference between "we build a known artifact"
 *     and "we build whatever is there today". Requiring the full SHA also rules
 *     out an abbreviated one, which can become ambiguous as the repo grows.
 *  2. A TOOLCHAIN THAT NO LONGER MATCHES CI. `cargo install --git` does not honour
 *     upstream's `rust-toolchain.toml`, so the version is set by the workflows
 *     instead. If PIN.json and the workflows disagree, the recorded toolchain is a
 *     lie and nobody finds out until a build behaves differently from the note.
 *
 * No network. Cheap enough to run in `quality` on every push.
 */
import fs from "node:fs";
import path from "node:path";

const TAG = "check-cua-pin";
const ROOT = process.cwd();
const PIN_PATH = path.join(ROOT, "native/cua-driver/PIN.json");
const LICENSE_PATH = path.join(ROOT, "native/cua-driver/LICENSE");

/** Workflows that pin the Rust toolchain for the cua-driver build. */
const WORKFLOWS = [".github/workflows/release.yml", ".github/workflows/msix.yml"];

const errors = [];
const fail = (msg) => errors.push(msg);

// ── the pin file itself ──────────────────────────────────────────────────────
let pin;
try {
  pin = JSON.parse(fs.readFileSync(PIN_PATH, "utf8"));
} catch (e) {
  console.error(`::error::[${TAG}] cannot read/parse ${PIN_PATH}: ${e.message}`);
  process.exit(1);
}

if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(String(pin.repo ?? ""))) {
  fail(`repo must be an https GitHub URL; got ${JSON.stringify(pin.repo)}`);
}
if (!/^[0-9a-f]{40}$/.test(String(pin.rev ?? ""))) {
  fail(
    `rev must be a full 40-char commit SHA (a branch or tag is NOT a pin — it can be ` +
      `repointed); got ${JSON.stringify(pin.rev)}`,
  );
}
if (!/^[a-z0-9-]+$/.test(String(pin.package ?? ""))) {
  fail(`package must be a crate name; got ${JSON.stringify(pin.package)}`);
}
if (!/^\d+\.\d+\.\d+/.test(String(pin.version ?? ""))) {
  fail(`version must be semver; got ${JSON.stringify(pin.version)}`);
}
if (!/^\d+\.\d+\.\d+$/.test(String(pin.toolchain ?? ""))) {
  fail(
    `toolchain must be an exact Rust version like "1.97.1" — "stable" is not a pin, and ` +
      `cargo install --git does not honour upstream's rust-toolchain.toml; got ` +
      JSON.stringify(pin.toolchain),
  );
}

// ── the license MIT obliges us to retain ─────────────────────────────────────
try {
  const license = fs.readFileSync(LICENSE_PATH, "utf8");
  if (license.trim().length < 200 || !/MIT License/i.test(license)) {
    fail(`${LICENSE_PATH} does not look like the upstream MIT license text`);
  }
} catch {
  fail(`missing ${LICENSE_PATH} — MIT requires retaining the license and copyright notice`);
}

// ── the toolchain the workflows actually install ─────────────────────────────
// Only checked when a workflow already references the toolchain, so this script
// lands before the CI changes without failing the build in between.
for (const wf of WORKFLOWS) {
  const p = path.join(ROOT, wf);
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, "utf8");
  if (!text.includes("cua-driver")) continue; // not wired up yet
  const pinned = [...text.matchAll(/dtolnay\/rust-toolchain@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  const mismatched = pinned.filter((v) => v !== pin.toolchain);
  if (mismatched.length) {
    fail(
      `${wf} pins rust-toolchain@${[...new Set(mismatched)].join(", ")} but PIN.json says ` +
        `${pin.toolchain} — one of them is wrong`,
    );
  }
}

if (errors.length) {
  for (const e of errors) console.error(`::error::[${TAG}] ${e}`);
  process.exit(1);
}
console.log(
  `[${TAG}] OK — ${pin.package} v${pin.version} @ ${String(pin.rev).slice(0, 12)} ` +
    `(rust ${pin.toolchain})`,
);
