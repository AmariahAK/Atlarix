#!/usr/bin/env bash
# Extract a version section from docs/CHANGELOG.md for release notes / Discord.
# Usage: extract-changelog.sh <version_without_v> [max_lines]
# Writes body to stdout; exits 1 if file missing.

set -euo pipefail

VERSION="${1:?version required (e.g. 8.5.2)}"
MAX_LINES="${2:-80}"
CHANGELOG_FILE="${CHANGELOG_FILE:-docs/CHANGELOG.md}"

if [[ ! -f "$CHANGELOG_FILE" ]]; then
  echo "CHANGELOG file not found: $CHANGELOG_FILE" >&2
  exit 1
fi

awk "
  /^## \[?v?${VERSION}\]?( |$)/{found=1; next}
  /^## /{if(found) exit}
  found{print}
" "$CHANGELOG_FILE" | sed '/^---$/d' | sed '/^$/N;/^\n$/d' | head -n "$MAX_LINES"
