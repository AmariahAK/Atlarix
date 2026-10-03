#!/bin/sh
# Publish the CLI's atlarix-<platform> npm packages from a release, by hand.
#
#   scripts/publish-cli-npm.sh v14.53.0
#
# For a package's FIRST publish. CI publishes with trusted publishing (no
# token), which npm only allows for a package that already exists; and since
# bypass-2FA tokens are no longer issued, that first publish needs the owner's
# 2FA. This takes the release's own CLI archives (checked against its
# SHA256SUMS-cli.txt, as the install script does), stages the packages with
# build-cli-npm.mjs, and publishes each one not on npm yet. npm asks for 2FA in
# the browser (--auth-type=web) and carries on once it is approved.
#
# Afterwards: add GitHub Actions (AmariahAK/Atlarix, release.yml) as each
# package's trusted publisher, and every later release publishes from CI.
set -eu
TAG="${1:?usage: publish-cli-npm.sh <release tag, e.g. v14.53.0>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="AmariahAK/atlarix-releases"

want="${TAG#v}"
have=$(node -p "require('$ROOT/package.json').version")
[ "$want" = "$have" ] || { echo "package.json is $have but the tag is $TAG: check out $TAG first."; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
echo "Downloading the CLI archives of $TAG…"
gh release download "$TAG" --repo "$REPO" --dir "$tmp/dl" --pattern 'atlarix-cli-*' --pattern 'SHA256SUMS-cli.txt'

cd "$tmp/dl"
for f in atlarix-cli-*; do
  sum=$(grep " \*\{0,1\}$f\$" SHA256SUMS-cli.txt | cut -d' ' -f1)
  [ -n "$sum" ] || { echo "No checksum for $f"; exit 1; }
  [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" = "$sum" ] || { echo "Checksum mismatch for $f: nothing was published."; exit 1; }
  target="${f%.tar.gz}"; target="${target%.zip}"
  mkdir -p "$tmp/bins/$target"
  case "$f" in
    *.zip) unzip -q "$f" -d "$tmp/bins/$target" ;;
    *) tar -xzf "$f" -C "$tmp/bins/$target" ;;
  esac
done
echo "All archives match the release's checksums."

cd "$ROOT"
node scripts/build-cli-npm.mjs "$tmp/bins" "$tmp/npm"

for p in "$tmp"/npm/*/; do
  name=$(node -p "require('$p/package.json').name")
  if npm view "$name@$want" version >/dev/null 2>&1; then
    echo "$name@$want is already on npm"
    continue
  fi
  echo "Publishing $name@$want (approve with 2FA in the browser)…"
  (cd "$p" && npm publish --access public --auth-type=web)
done
echo "Done. Next: add the trusted publisher on each new package (AmariahAK/Atlarix, workflow release.yml)."
