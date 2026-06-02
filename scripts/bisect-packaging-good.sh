#!/usr/bin/env bash
# Exit codes for `git bisect run`: 0 = good, 1 = bad, 125 = skip
#
# Reproduces GitHub Actions packaging (CI=true) and checks that forge produced out/.
# Usage (from repo root, while git bisect is active):
#   git bisect run ./scripts/bisect-packaging-good.sh
#
# On macOS only (electron-forge package for darwin). On Linux CI, use workflow_dispatch instead.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[bisect-packaging] skip: run on macOS or use manual bisect + Release workflow on GitHub"
  exit 125
fi

ARCH="${BISECT_ARCH:-$(uname -m)}"
if [[ "$ARCH" == "x86_64" ]]; then
  ARCH="x64"
fi

echo "[bisect-packaging] commit=$(git rev-parse --short HEAD) arch=$ARCH"

export CI=true
export GITHUB_ACTIONS=true
export FORCE_COLOR=1
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"

if [[ ! -d node_modules/@electron-forge/core ]]; then
  echo "[bisect-packaging] npm ci (cold)"
  npm ci --prefer-offline --no-audit
elif git diff-tree -r --name-only HEAD@{1} HEAD 2>/dev/null | grep -qE '^package(-lock)?\.json$'; then
  echo "[bisect-packaging] npm ci (lockfile changed)"
  npm ci --prefer-offline --no-audit
fi

npm run clean
npx electron-forge package --arch="$ARCH"

if [[ -f scripts/verify-ci-package-out.mjs ]]; then
  node scripts/verify-ci-package-out.mjs --stage package --platform darwin --arch "$ARCH"
else
  if [[ ! -d out ]]; then
    echo "[bisect-packaging] BAD: missing out/"
    exit 1
  fi
  PKG="out/Atlarix-darwin-${ARCH}"
  if [[ ! -d "$PKG/Atlarix.app" ]]; then
    echo "[bisect-packaging] BAD: missing $PKG/Atlarix.app"
    exit 1
  fi
  echo "[bisect-packaging] GOOD: $PKG/Atlarix.app"
fi
