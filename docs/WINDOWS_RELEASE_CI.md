# Windows release CI

Windows uses **direct `@electron/packager`** (no `electron-forge package` on GHA) because Forge’s package listr exits before `out/` is written on `windows-latest`.

## CI flow (v9.1.12+)

1. `npm run clean`
2. **`node scripts/win-ci-vite.mjs`** — production Vite / Forge prePackage
3. **`node scripts/win-ci-package.mjs`** — `spawnSync` → `win-ci-packager-worker.mjs` (`@electron/packager`) then `electron-forge make --skip-package`
4. `verify-ci-package-out` (package, then make)

Packager runs in a **child Node process** so the parent cannot exit before `out/` exists (GHA win32 event-loop quirk).

Environment on package/make step:

- Node **24**
- `NODE_OPTIONS=--max-old-space-size=8192`
- `TMP` / `TEMP` → `${{ github.workspace }}/.cache/packager-tmp`

macOS/Linux still use `ci:package` + `ci:installers`.

## Local

```powershell
npm run clean
node scripts/win-ci-vite.mjs
node scripts/win-ci-package.mjs
```

Or full Forge: `npm run make` (local Windows VM).

## Escalation / legacy

| Script | Role |
|--------|------|
| `npm run ci:package` + `ci:installers` | Same as Linux (fails on GHA win32 today) |
| `npm run ci:package:win` | Forge package poller |
| `npm run dump:windows-packaging` | Manual debug dump |

## Success signals

- `[win-ci-package] OK packaged app at …\out\Atlarix-win32-x64`
- `[packageAfterPrune]` in logs
- `out/make` contains Squirrel installer artifacts
- Job ~20–40 minutes
