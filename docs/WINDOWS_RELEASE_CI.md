# Windows release CI

GitHub Actions builds Windows installers on `windows-latest` using the **same flow as Linux**:

1. `npm run clean`
2. `npm run ci:package`
3. `verify-ci-package-out` (package)
4. `npm run ci:installers`
5. `verify-ci-package-out` (make)

Environment (see `.github/workflows/release.yml` `build-windows`):

- Node **24**
- `NODE_OPTIONS=--max-old-space-size=8192`
- `TMP` / `TEMP` → `${{ github.workspace }}/.cache/packager-tmp`
- No `DEBUG` (avoids listr fallback side effects)

## Forge patch

`patches/@electron-forge+core+7.11.1.patch` awaits the packaging listr + `packagerPromise`, validates `out/` paths, and **does not** enable listr CI fallback on `win32` for `package.js` (mac/linux CI unchanged).

Verified in CI via `node scripts/verify-forge-patch.mjs` after `npm ci`.

## Local / escalation

| Command | When |
|---------|------|
| `npm run make` | Full local Windows release (clean + package + installers) |
| `npm run ci:build:win` | Split Vite + direct packager (optional; not used in GHA) |
| `npm run ci:package:win` | Forge package poller (legacy debug) |
| `npm run dump:windows-packaging` | Manual state dump |

## Success signals

- Logs include `[packageAfterPrune]` and Squirrel make output
- `out/Atlarix-win32-x64/atlarix.exe` exists
- Job duration ~20–40 minutes (not ~6–8 min with empty `out/`)
