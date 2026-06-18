#!/bin/bash
# Build the Atlarix headless bundle + a LINUX Node-ABI better-sqlite3 into a
# tarball the Terminal-Bench adapter fetches at install time.
#
# better-sqlite3 is native, so its .node must match the TB container (linux glibc
# x64). We therefore build INSIDE a Linux Node container, FORCED to linux/amd64
# (the Terminal-Bench images are amd64 — e.g. alexgshaw/fix-git — and run under
# emulation on Apple Silicon, so a default arm64 build would fail to dlopen).
# Do NOT build on macOS.
PLATFORM="${TARBALL_PLATFORM:-linux/amd64}"
#
# Output: dist-headless-tarball/atlarix-headless-<ver>.tar.gz
#   layout when unpacked to /opt/atlarix:
#     dist-headless/atlarix-headless.mjs
#     node_modules/{better-sqlite3,@ast-grep/*}/...  (Node-ABI; resolved by node_modules walk)
#
# The headless bundle externalizes its NATIVE deps (they can't be bundled), so
# every one the runtime import graph touches must be shipped here at its repo
# version: better-sqlite3 (db) + @ast-grep/napi & the lang grammars (blueprint).
#
# Usage: scripts/build-headless-tarball.sh   (requires Docker)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="$ROOT/dist-headless-tarball"
VER="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"
mkdir -p "$OUT"

# 1) Bundle the JS (host esbuild is fine — pure JS, no native).
npm run build:headless

# 2) Build the Linux Node-ABI native deps + assemble the tarball in a Linux
#    container so the native binaries match the TB runtime. Versions are read
#    from the repo package.json so the shipped ABI tracks what we develop against.
echo "[build-headless-tarball] packing native deps for platform: $PLATFORM"
docker run --rm --platform "$PLATFORM" -v "$ROOT:/src" -w /tmp/pack node:22-bookworm bash -lc '
  set -euo pipefail
  mkdir -p /tmp/pack/dist-headless /tmp/pack/node_modules
  cp -r /src/dist-headless/* /tmp/pack/dist-headless/
  # Drop the sourcemap: not needed at runtime, ~24MB, and it exposes original TS
  # source — must not ship to the PUBLIC atlarix-releases host.
  rm -f /tmp/pack/dist-headless/*.map
  cd /tmp/pack
  npm init -y >/dev/null 2>&1
  # Native externals the headless bundle imports at runtime, pinned to repo versions.
  SPECS=$(node -e '"'"'
    const d = require("/src/package.json").dependencies || {};
    const names = ["better-sqlite3","@ast-grep/napi","@ast-grep/lang-python","@ast-grep/lang-go"];
    process.stdout.write(names.map(n => d[n] ? `${n}@${d[n]}` : n).join(" "));
  '"'"')
  echo "[pack] installing native deps: $SPECS"
  npm install --no-save --omit=dev $SPECS >/dev/null 2>&1
  # Fail loudly if any required native module is missing from the packed tree.
  node -e '"'"'
    const r = require("module").createRequire("/tmp/pack/x.js");
    for (const n of ["better-sqlite3","@ast-grep/napi","@ast-grep/lang-python","@ast-grep/lang-go"]) {
      r.resolve(n); // throws if not installed
    }
    console.log("[pack] all native deps resolve OK");
  '"'"'
  # Strip foreign-arch ast-grep grammar prebuilds (keep only Linux-X64, the TB
  # runtime) — shrinks the tarball so it fetches reliably over CDN/tunnel.
  find node_modules/@ast-grep -type d -name "prebuild-*" ! -name "prebuild-Linux-X64" -exec rm -rf {} + 2>/dev/null || true
  tar -czf /src/dist-headless-tarball/atlarix-headless-'"$VER"'.tar.gz dist-headless node_modules
'

echo "[build-headless-tarball] wrote $OUT/atlarix-headless-$VER.tar.gz"
echo "Host it (e.g. attach to atlarix-releases) and export ATLARIX_HEADLESS_TARBALL_URL=<url>"
