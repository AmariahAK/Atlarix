#!/usr/bin/env bash
# Exit codes for `git bisect run`: 0 = good, 1 = bad, 125 = skip
#
# Reproduces GitHub Actions macOS build (npm run make + out/make check).
# Usage: git bisect run ./scripts/bisect-make-good.sh

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[bisect-make] skip: macOS only"
  exit 125
fi

ARCH="${BISECT_ARCH:-$(uname -m)}"
if [[ "$ARCH" == "x86_64" ]]; then
  ARCH="x64"
fi

echo "[bisect-make] commit=$(git rev-parse --short HEAD) arch=$ARCH"

export CI=true
export GITHUB_ACTIONS=true
export FORCE_COLOR=1
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"

echo "[bisect-make] npm ci"
npm ci --prefer-offline --no-audit

node scripts/simulate-ci-make.mjs "--arch=${ARCH}"

node scripts/verify-ci-package-out.mjs --stage make --platform darwin --arch "$ARCH"
echo "[bisect-make] GOOD: out/make present"
