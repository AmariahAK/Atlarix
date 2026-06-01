# Windows release CI

GitHub Actions builds Windows installers on `windows-latest` using **direct `@electron/packager`** (no Forge `package` listr on Windows), then **`electron-forge make --skip-package`**.

## CI flow (default, v9.1.9+)

1. `npm run clean`
2. `node scripts/log-packaging-env.mjs` (env summary + light probes)
3. `node scripts/dump-windows-packaging-state.mjs --label post-clean`
4. `npm run ci:build:win` — `win-ci-vite.mjs` (Vite/prePackage) then `win-ci-package.mjs` (packager + Squirrel make)
5. `dump-windows-packaging-state --label post-build` + PowerShell `Test-Path` probes
6. `verify-ci-package-out` (package + make)

On failure, GHA runs **`dump-windows-packaging-state --label post-mortem`**.

### Why not `electron-forge package` on Windows?

Forge’s listr **fallback renderer** on `win32` + `CI` caused the CLI to exit **0** ~0.35s after `Packaging app for platform win32` while `out/` was never written. The `@electron-forge/core` patch awaits `packagerPromise`, but the process still exited early. **Bypass:** call `@electron/packager` in-process via [`scripts/win-ci-lib.mjs`](../scripts/win-ci-lib.mjs) (`packageAppDirect`).

Escalation / local debug: `npm run ci:package:win` (Forge poller) — see [`scripts/ci-forge-package-windows.mjs`](../scripts/ci-forge-package-windows.mjs).

## Deep debugging (Windows only)

Always enabled on **`build-windows`** (macOS/Linux unchanged):

| Env | Purpose |
|-----|---------|
| `ATLARIX_WINDOWS_PACKAGING_DEBUG=1` | Full snapshots, hypothesis checklist, directory trees |
| `ATLARIX_PACKAGING_DEBUG=1` | `[packaging-diag]` memory / hook logs |

Do **not** set `DEBUG=electron-forge:*` on Windows package steps (listr). `win-ci-lib` may set `electron-packager:*` when `ATLARIX_PACKAGING_DEBUG=1`.

### Log prefixes to search in GHA

| Prefix | Source |
|--------|--------|
| `[win-packaging-debug]` | [`scripts/windows-packaging-debug.mjs`](../scripts/windows-packaging-debug.mjs) |
| `[win-ci-vite]` / `[win-ci-package]` | Direct packager path |
| `[packageAfterPrune]` | Forge hook during packager finalize |
| `[ci-forge-package-windows]` | Legacy Forge poller only |

### Hypothesis checklist (in every snapshot)

Labels drive **phase** (`pre` / `mid` / `post`):

- **pre** (`pre-build`, `post-clean`): Vite and `out/` show **N/A**
- **post** (`post-build`, `post-package`, `post-mortem`): Vite **OK**, `out/…/atlarix.exe` **OK**

### Local (Windows VM)

```powershell
$env:ATLARIX_WINDOWS_PACKAGING_DEBUG = "1"
npm run clean
npm run dump:windows-packaging -- --label pre-build
npm run ci:build:win
npm run dump:windows-packaging -- --label post-build
```

### Workflow snapshots

- `pre-build` — after temp prep, before clean
- `post-clean` — before `ci:build:win`
- `post-build` — after `ci:build:win`
- `post-package` — after verify
- `post-mortem` — on job failure

Environment on `build-windows`:

- `NODE_OPTIONS=--max-old-space-size=8192`
- `TMP` / `TEMP` → `${{ github.workspace }}/.cache/packager-tmp`
- Node **24**

### Success signals

| Signal | Bad | Good |
|--------|-----|------|
| Job duration | ~6–8 min | ~20–40 min |
| Log | Stops after “Packaging app for platform win32” with no `[packageAfterPrune]` | `[win-ci-package] OK packaged app`, Squirrel make |
| Artifacts | No `out/` | `out/Atlarix-win32-x64/atlarix.exe` |

## Debugging on macOS

You **cannot** produce a real `win32-x64` binary on macOS. Use `gh workflow run release.yml` or a Windows VM.

## Related scripts

| Script | Role |
|--------|------|
| `scripts/win-ci-vite.mjs` | Production Vite / prePackage |
| `scripts/win-ci-package.mjs` | Direct packager + `make --skip-package` |
| `scripts/win-ci-lib.mjs` | Shared packager hooks |
| `scripts/ci-forge-package-windows.mjs` | Legacy Forge poller |
| `scripts/windows-packaging-debug.mjs` | Snapshots / checklist |
