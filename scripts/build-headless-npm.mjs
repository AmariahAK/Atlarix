#!/usr/bin/env node
/**
 * Stage `packages/headless` (the published `atlarix` package) from the built
 * headless bundle.
 *
 * Why a staging step rather than publishing the repo root: the root package.json
 * is the Electron app's, is named `atlarix`, and carries no `files` allow-list —
 * so a publish from there would push the entire proprietary source tree to the
 * public registry. The root is marked `private` to make that impossible; this
 * package is the only publishable artifact.
 *
 * What ships is deliberately small: the bundle, the two runtime assets it reads,
 * and nothing else. The sourcemap is excluded — 24MB, useless at runtime, and it
 * embeds the original TypeScript source (`build-headless-tarball.sh` drops it for
 * the same reason before uploading to the public releases host).
 *
 * `better-sqlite3` stays a real dependency rather than being vendored: it is
 * native, and npm resolves the right prebuild for whatever platform installs it.
 * The tarball had to pin linux/amd64 and build it inside a container; the package
 * does not.
 *
 * Usage: node scripts/build-headless-npm.mjs   (run after `npm run build:headless`)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "dist-headless");
const pkgDir = path.join(root, "packages/headless");
const dest = path.join(pkgDir, "dist-headless");

/**
 * Everything the bundle touches at runtime, and nothing else.
 *
 * `models-snapshot.json.gz` is the offline model catalog. It is not optional for
 * this package's purpose: benchmark sandboxes enforce an egress allow-list that
 * does not include models.dev, and with no catalog the per-model reasoning
 * profile is unavailable — which changes the shape of the reasoning parameter
 * that gets sent. Same command, different request, depending on the sandbox.
 */
const RUNTIME_FILES = [
  "atlarix-headless.mjs",
  "AGENTS.md",
  "tiktoken_bg.wasm",
  "models-snapshot.json.gz",
];

if (!fs.existsSync(path.join(src, "atlarix-headless.mjs"))) {
  console.error(
    "[build-headless-npm] dist-headless/atlarix-headless.mjs is missing — run `npm run build:headless` first.",
  );
  process.exit(1);
}

// Clean rather than merge: a stale file left from an earlier build would be
// published silently, and `files` would happily ship it.
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

for (const name of RUNTIME_FILES) {
  const from = path.join(src, name);
  if (!fs.existsSync(from)) {
    console.error(`[build-headless-npm] missing required runtime file: ${name}`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(dest, name));
}

// The published version tracks the app's — one number for the desktop build and
// the CLI that shares its agent loop, so a benchmark row's `agent_version` names
// something a person can actually go and look at. `--version` reports the same
// value, injected into the bundle by build-headless.mjs from this same field.
const rootVersion = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
const pkgPath = path.join(pkgDir, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.version = rootVersion;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// `bin` targets are executed directly by the shell via the symlink npm creates.
fs.chmodSync(path.join(dest, "atlarix-headless.mjs"), 0o755);

const bytes = RUNTIME_FILES.reduce(
  (n, f) => n + fs.statSync(path.join(dest, f)).size,
  0,
);
console.log(
  `[build-headless-npm] staged atlarix@${rootVersion} — ${RUNTIME_FILES.length} files, ${(bytes / 1e6).toFixed(1)} MB`,
);
console.log(`[build-headless-npm] publish with: npm publish ${path.relative(root, pkgDir)}`);
