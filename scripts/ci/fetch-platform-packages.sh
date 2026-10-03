#!/usr/bin/env bash
# Put a CLI target's platform-specific packages where the Bun build finds them,
# without `npm install` (which would prune or rewrite the tree): each is
# `npm pack`ed at the version package-lock pins and unpacked into node_modules.
#   - @opentui/core-<os>-<arch>[-musl]: the TUI's native renderer
#   - @vscode/ripgrep-<os>-<arch>: prints its rg path for ATLARIX_RG_PATH
# (ripgrep's Linux builds are static, so musl targets share them.)
#
# Usage: eval "$(scripts/ci/fetch-platform-packages.sh <target> <work dir>)"
#   target: darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64 |
#           linux-x64-musl | linux-arm64-musl | windows-x64
# Prints: export ATLARIX_RG_PATH=...
set -euo pipefail
target="$1"; work="$2"
os="${target%%-*}"; rest="${target#*-}"; arch="${rest%%-*}"; libc=""
[[ "$target" == *-musl ]] && libc="-musl"
npm_os="$os"; [ "$os" = windows ] && npm_os=win32
mkdir -p "$work"

unpack() { # <package> <dest>
  local pkg="$1" dest="$2" version tarball
  version=$(node -p "(require('./package-lock.json').packages['node_modules/$1']||{}).version || require('./node_modules/@opentui/core/package.json').optionalDependencies['$1'] || ''")
  [ -n "$version" ] || { echo "no pinned version for $pkg" >&2; exit 1; }
  tarball=$(cd "$work" && npm pack --silent "${pkg}@${version}" | tail -1)
  rm -rf "$dest"; mkdir -p "$dest"
  tar -xzf "$work/$tarball" -C "$dest" --strip-components=1
}

unpack "@opentui/core-${npm_os}-${arch}${libc}" "node_modules/@opentui/core-${npm_os}-${arch}${libc}"
unpack "@vscode/ripgrep-${npm_os}-${arch}" "$work/ripgrep-${npm_os}-${arch}"
exe=rg; [ "$os" = windows ] && exe=rg.exe
echo "export ATLARIX_RG_PATH=$(cd "$work" && pwd)/ripgrep-${npm_os}-${arch}/bin/$exe"
