# Windows release CI

Windows uses **direct `@electron/packager`** (no `electron-forge package` on GHA) because Forge’s package listr exits before `out/` is written on `windows-latest`.

## CI flow (v9.1.14+)

1. `npm run clean`
2. **`node scripts/win-ci-vite.mjs`** — production Vite / Forge prePackage
3. **`node scripts/win-ci-package.mjs`** — `spawnSync` → `win-ci-packager-worker.mjs` → `electron-forge make --skip-package`
4. `verify-ci-package-out` (package, then make)

### Packager worker

- Child process + event-loop keep-alive
- **`fastIgnore`** on GHA: skip most `node_modules` without running full `forge.config` ignore on every file
- **`[win-packager-heartbeat]`** every 60s: template size, `out/` / exe existence
- **50 min** in-process timeout; GHA step **55 min** `timeout-minutes`
- `DEBUG=electron-packager:*` on the package step

### `packageAfterPrune`

- Light logs on GHA (`logTopNodeModules`, `npm install` count)
- Full `dump-windows-packaging-state` only when `ATLARIX_WINDOWS_PACKAGING_DEBUG=1`

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

## Success signals

- Heartbeats show **template size growing** then `packageDir=true exe=true`
- `[packageAfterPrune] start` / `done`
- `[win-ci-package] OK packaged app at …\out\Atlarix-win32-x64`
- `out/make` Squirrel artifacts

## Escalation

| Script | Role |
|--------|------|
| `npm run make` | Full local / fallback Forge make |
| `npm run dump:windows-packaging` | Manual debug dump |
