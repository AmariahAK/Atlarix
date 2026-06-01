# Windows release CI

GitHub Actions builds Windows installers on `windows-latest` using a **split Node process** flow so Vite does not share a heap with `electron-packager` (avoids ~3GB retained heap and early process abort on GHA).

## CI flow (default)

1. `npm run clean`
2. `node scripts/ci-win-release.mjs`
   - `win-ci-vite.mjs` — Forge prePackage / production Vite bundles
   - `win-ci-package.mjs` — `@electron/packager`, `packageAfterPrune`, `electron-forge make --skip-package`
3. `verify-ci-package-out.mjs` (package + make stages)

Environment on `build-windows`:

- `NODE_OPTIONS=--max-old-space-size=8192`
- `TMP` / `TEMP` → `${{ github.workspace }}/.cache/packager-tmp`
- Pre-step clears `%RUNNER_TEMP%\electron-packager`

Entrypoint: `npm run ci:make:win` → `scripts/ci-win-release.mjs`.

## Local Windows

```bash
npm ci
npm run clean
node scripts/win-ci-build.mjs
# or the same two steps as CI:
node scripts/win-ci-vite.mjs
node scripts/win-ci-package.mjs
```

## Debugging on macOS

You **cannot** produce a real `win32-x64` binary on macOS — Electron Forge/Packager target the host OS for native modules and layout.

| Approach | Useful for |
|----------|------------|
| `node scripts/simulate-ci-make.mjs --profile=fixed --platform=darwin --arch=arm64` | macOS split package + installers + verify (hooks, not Windows packager) |
| `NODE_OPTIONS=--max-old-space-size=8192 npm run package` | macOS packaging stress / memory |
| Push branch + `gh workflow run release.yml` | Real Windows CI |
| Tag `v*` push | Full release pipeline |
| **UTM / Parallels** Windows 11 VM, Node 24 | Full local reproduce of `win-ci-vite` + `win-ci-package` |

Optional debug on manual workflow runs: enable **Packaging debug** input (`ATLARIX_PACKAGING_DEBUG=1`, `DEBUG=electron-packager:*`).

### Example: trigger Windows build from Mac

```bash
gh workflow run release.yml --ref main -f packaging_debug=true
# Or push a tag after bumping package.json version to match vX.Y.Z
```

Watch the `build-windows` job for:

- `[win-ci-vite] OK`
- `[win-ci-package] memory at start` with heap **well under 500 MiB**
- `[packageAfterPrune] done`
- Job duration **~20–40 minutes** (not ~6–8 minutes)

## Fallback: single `npm run make` (v9.0.0 style)

If split-process still fails, temporarily change **Build for Windows** in [`.github/workflows/release.yml`](../.github/workflows/release.yml) to:

```yaml
- name: Build for Windows
  shell: pwsh
  run: npm run clean && npm run make
  env:
    NODE_OPTIONS: "--max-old-space-size=8192"
    TMP: ${{ github.workspace }}/.cache/packager-tmp
    TEMP: ${{ github.workspace }}/.cache/packager-tmp
```

Keep macOS/Linux on `ci:package` + `ci:installers`. This matched working releases around **v9.0.0** (~30 min Windows job).

## Related scripts

| Script | Role |
|--------|------|
| `scripts/win-ci-lib.mjs` | Shared packager/hook logic |
| `scripts/win-ci-vite.mjs` | Vite-only step |
| `scripts/win-ci-package.mjs` | Packager + Squirrel make |
| `scripts/ci-win-release.mjs` | CI orchestrator |
| `scripts/ci-forge-package-windows.mjs` | Legacy forge `package` poller (debug) |
| `scripts/verify-ci-package-out.mjs` | Fail fast if `out/` missing |
