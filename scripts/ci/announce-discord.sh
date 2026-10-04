#!/usr/bin/env bash
# Post a release to the Discord forum channel.
#
#   DISCORD_WEBHOOK_URL=… scripts/ci/announce-discord.sh v15.0.0
#
# Used by release.yml (announce-release) and by announce.yml, the manual
# re-announce for a release whose tag run skipped it (v15.0.0: a false
# publish-release failure skipped every job after it).
set -euo pipefail
TAG="${1:?usage: announce-discord.sh <tag, e.g. v15.0.0>}"
VERSION="${TAG#v}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [ -z "${DISCORD_WEBHOOK_URL:-}" ]; then
  echo "DISCORD_WEBHOOK_URL not set; skipping Discord notification."
  exit 0
fi

cd "$ROOT"   # extract-changelog.sh reads docs/CHANGELOG.md (or $CHANGELOG_FILE) from here
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Discord stays a 40-line teaser deliberately — but a teaser that stops
# mid-sentence with no way to read the rest is just a truncated post. The link
# goes on every time, not only when the extract came back empty.
{
  echo "Release notes (technical):"
  echo ""
  bash "$ROOT/scripts/ci/extract-changelog.sh" "$VERSION" 40 || true
} > "$work/body.txt"

TAG="$TAG" BODY="$work/body.txt" OUT="$work/payload.json" python3 <<'PY'
import json, os
from pathlib import Path
ref = os.environ["TAG"]
version = ref.lstrip("v")
link = f"https://github.com/AmariahAK/atlarix-releases/releases/tag/{ref}"
tail = f"\n\nFull notes: {link}"
# The cap (Discord allows 4096) applies to the TEASER, so the link always fits:
# capping after appending it cut the link off whenever 40 lines ran long.
body = Path(os.environ["BODY"]).read_text(encoding="utf-8").rstrip()
limit = 3800 - len(tail)
if len(body) > limit:
    body = body[: limit - 1].rsplit("\n", 1)[0] + "\n…"
desc = body + tail
payload = {
    # Forum channels require thread_name (or thread_id) on webhook posts.
    "thread_name": f"Atlarix v{version} released"[:100],
    "embeds": [{
        "title": f"Atlarix v{version} released",
        "description": desc,
        "url": link,
    }],
}
Path(os.environ["OUT"]).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
PY
curl -fsS -X POST -H "Content-Type: application/json" -d @"$work/payload.json" "$DISCORD_WEBHOOK_URL" >/dev/null
echo "Announced ${TAG} on Discord."
