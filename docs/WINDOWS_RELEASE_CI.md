# Windows release CI

GitHub Actions builds Windows installers on `windows-latest` using Forge **`ci:package:win`** (polls until `out/` exists) + **`ci:installers`**, with the `@electron-forge/core` patch (await packaging listr, validate `out/` paths).

## CI flow (default)

1. `npm run clean`
2. `node scripts/log-packaging-env.mjs` + full debug snapshot
3. `node scripts/dump-windows-packaging-state.mjs --label post-clean`
4. `npm run ci:package:win` — Forge package with step-by-step `[ci-forge-package-windows]` logs
5. `verify-ci-package-out` (package) + `dump-windows-packaging-state --label post-package`
6. `npm run ci:installers`
7. `verify-ci-package-out` (make)

On failure, GHA runs **`dump-windows-packaging-state --label post-mortem`**.

## Deep debugging (Windows only, v9.1.8+)

Always enabled on **`build-windows`** (macOS/Linux unchanged):

| Env | Purpose |
|-----|---------|
| `ATLARIX_WINDOWS_PACKAGING_DEBUG=1` | Full snapshots, hypothesis checklist, directory trees |
| `ATLARIX_PACKAGING_DEBUG=1` | `[packaging-diag]` memory / hook logs |
| `DEBUG=electron-packager:*,@electron-forge/core:*` | Verbose packager + Forge core (not bare `electron-forge:*`) |

### Log prefixes to search in GHA

| Prefix | Source |
|--------|--------|
| `[win-packaging-debug]` | [`scripts/windows-packaging-debug.mjs`](../scripts/windows-packaging-debug.mjs) — env, patch check, `out/` / temp trees, processes |
| `[ci-forge-package-windows]` | Wrapper steps + elapsed time |
| `[packaging-diag]` | Memory during wait / hooks |
| `[packageAfterPrune]` | Forge hook (proves packager reached finalize) |
| `electron-packager` / `@electron-forge/core` | `DEBUG` namespaces |

### Hypothesis checklist (in every snapshot)

Each snapshot prints OK/FAIL for:

- Vite `.vite/build/main.js`
- Forge patch (`await packagingRunner.run`, win32 CI listr)
- `out/Atlarix-win32-x64/atlarix.exe`
- Temp `electron-packager` under `.cache/packager-tmp`

If **`forge exit 0`** but checklist shows **FAIL** for `out/` and you never see **`[packageAfterPrune] start`**, packaging died during listr/packager (not Squirrel make).

### Local (Windows VM)

```powershell
$env:ATLARIX_WINDOWS_PACKAGING_DEBUG = "1"
$env:DEBUG = "electron-packager:*,@electron-forge/core:*"
npm run dump:windows-packaging
npm run clean
npm run ci:package:win
```

### Workflow snapshots

- `pre-build` — after temp prep, before clean
- `post-clean` — before `ci:package:win`
- `post-package` — after package verify (if reached)
- `post-mortem` — on job failure
- `wrapper-forge-exit-0` — immediately when Forge exits 0 without `out/`

Environment on `build-windows`:

- `NODE_OPTIONS=--max-old-space-size=8192`
- `TMP` / `TEMP` → `${{ github.workspace }}/.cache/packager-tmp`
- Pre-step clears `%RUNNER_TEMP%\electron-packager`
- Node **24**

### Success signals

| Signal | Bad | Good |
|--------|-----|------|
| Job duration | ~6–8 min (then 10m grace) | ~20–40 min |
| Log | Stops after “Packaging app for platform win32” | `[packageAfterPrune] done`, Squirrel make |
| Artifacts | No `out/` | `out/Atlarix-win32-x64/atlarix.exe` |

## Debugging on macOS

You **cannot** produce a real `win32-x64` binary on macOS.

| Approach | Useful for |
|----------|------------|
| `gh workflow run release.yml` | Real Windows CI with full debug |
| Windows 11 VM + commands above | Local reproduce |

## Escalation (if poller still fails)

1. **`npm run ci:package`** — direct Forge (same as mac/linux)
2. **`npm run make` only** (v9.0.0 style) on Windows only
3. Squirrel-only: `author` / `description`, `electron-winstaller` postinstall

## Related scripts

| Script | Role |
|--------|------|
| `scripts/windows-packaging-debug.mjs` | Shared dump / checklist |
| `scripts/dump-windows-packaging-state.mjs` | CLI snapshots |
| `scripts/ci-forge-package-windows.mjs` | CI package poller |
| `scripts/log-packaging-env.mjs` | Pre-build env + Windows snapshot |
