# Windows release CI

GitHub Actions builds Windows installers on `windows-latest` using Forge **`ci:package:win`** (polls until `out/` exists) + **`ci:installers`**, with the `@electron-forge/core` patch (await packaging listr, validate `out/` paths).

## CI flow (default, v9.1.7+)

1. `npm run clean`
2. `node scripts/log-packaging-env.mjs`
3. `npm run ci:package:win` — `electron-forge package` via [`ci-forge-package-windows.mjs`](../scripts/ci-forge-package-windows.mjs) (fails fast if forge exits 0 without `out/`)
4. `node scripts/verify-ci-package-out.mjs --stage package --platform win32 --arch x64`
5. `npm run ci:installers` — `electron-forge make --skip-package` (Squirrel `.exe` / `.nupkg`)
6. `node scripts/verify-ci-package-out.mjs --stage make --platform win32 --arch x64`

Environment on `build-windows`:

- `NODE_OPTIONS=--max-old-space-size=8192`
- `TMP` / `TEMP` → `${{ github.workspace }}/.cache/packager-tmp`
- Pre-step clears `%RUNNER_TEMP%\electron-packager`
- Node **24** (better-sqlite3 native build on `windows-latest`)

Manual workflow debug: enable **Packaging debug** — sets `ATLARIX_PACKAGING_DEBUG=1` and `DEBUG=electron-packager:*` only (never `electron-forge:*`, which triggers listr fallback and can exit before packaging finishes).

### Success signals

| Signal | Bad | Good |
|--------|-----|------|
| Job duration | ~6–8 min | ~20–40 min |
| Log | Stops after “Packaging app for platform win32” | `[packageAfterPrune] done`, Squirrel make steps |
| Artifacts | No `out/` | `out/Atlarix-win32-x64/atlarix.exe`, `out/make/**/*.exe` |

## Debugging on macOS

You **cannot** produce a real `win32-x64` binary on macOS — Electron Forge/Packager target the host OS for native modules and layout.

| Approach | Useful for |
|----------|------------|
| `node scripts/simulate-ci-make.mjs --profile=fixed --platform=darwin --arch=arm64` | macOS split package + installers + verify (hooks, not Windows packager) |
| `NODE_OPTIONS=--max-old-space-size=8192 npm run package` | macOS packaging stress / memory |
| `gh workflow run release.yml -f packaging_debug=true` | Real Windows CI with packager verbose logs |
| Tag `v*` push | Full release pipeline |
| **UTM / Parallels** Windows 11 VM, Node 24 | Full local reproduce of `npm run ci:package` + `ci:installers` |

### Example: trigger Windows build from Mac

```bash
gh workflow run release.yml --ref main -f packaging_debug=true
```

Watch the `build-windows` job for Forge packaging steps and `[packageAfterPrune] done`.

## Escalation (if poller still fails)

Try **one change per GHA run**:

1. **`npm run ci:package`** — direct Forge package (same as macOS/Linux) if the poller adds no value.
2. **`npm run make` only** (v9.0.0 style) — single Forge make on Windows; keep macOS/Linux on split `ci:package` + `ci:installers`:

```yaml
- name: Build for Windows
  shell: pwsh
  run: npm run clean && npm run make
  env:
    NODE_OPTIONS: "--max-old-space-size=8192"
    TMP: ${{ github.workspace }}/.cache/packager-tmp
    TEMP: ${{ github.workspace }}/.cache/packager-tmp
```

3. **Squirrel-only** (package OK, `out/make` empty): confirm `author` / `description` in `package.json`; ensure `electron-winstaller` postinstall ran under npm ([Forge #3892](https://github.com/electron-userland/electron-forge/issues/3892)).

## Local / VM debug (legacy split-process)

The `win-ci-*` scripts bypass Forge listr and split Vite from packager. Useful on a Windows VM when isolating heap vs packager issues; **not** used in GHA by default.

```bash
npm ci
npm run clean
node scripts/win-ci-build.mjs
# or:
node scripts/win-ci-vite.mjs
node scripts/win-ci-package.mjs
```

## Related scripts

| Script | Role |
|--------|------|
| `scripts/log-packaging-env.mjs` | CI runner context before package |
| `scripts/verify-ci-package-out.mjs` | Fail fast if `out/` missing |
| `scripts/verify-forge-patch.mjs` | Ensures patch applied after `npm ci` |
| `scripts/ci-forge-package-windows.mjs` | Optional forge `package` poller (`ci:package:win`) |
| `scripts/win-ci-lib.mjs` | Shared packager/hook logic (local debug) |
| `scripts/win-ci-vite.mjs` | Vite-only step (local debug) |
| `scripts/win-ci-package.mjs` | Packager + make (local debug) |
| `scripts/ci-win-release.mjs` | Split-process orchestrator (`ci:make:win`, local debug) |
