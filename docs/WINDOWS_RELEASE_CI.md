# Windows release CI

Windows uses **direct `@electron/packager`** (no `electron-forge package` on GHA) because Forge’s package listr exits before `out/` is written on `windows-latest`.

## CI flow

1. `npm run clean`
2. **`node scripts/win-ci-vite.mjs`** — production Vite / Forge prePackage
3. **`node scripts/win-ci-package.mjs`** — `spawnSync` → `win-ci-packager-worker.mjs` → `electron-forge make --skip-package`
4. `verify-ci-package-out` (package, then make)

### Packager worker

- Child process + event-loop keep-alive
- **`fastIgnore`** on GHA: skip most `node_modules` without running full `forge.config` ignore on every file
- **`sequentialPackagerHooks`** — Forge-compatible callback hooks so `packageAfterCopy` / **`packageAfterPrune`** run
- **Electron zip** (`scripts/win-ci-electron-zip.mjs`): verify zip size before packager; on GHA win32 **bypass `extract-zip`** with PowerShell `Expand-Archive`
- **`verify-ci-package-out`** on win32: `resources/app.asar`, `resources/ast-grep-grammars/**/parser.so`, Setup.exe ≥ 200 MiB

Environment on package/make step:

- Node **24**
- `NODE_OPTIONS=--max-old-space-size=8192`
- `ELECTRON_CACHE` → `${{ github.workspace }}/.cache/electron`
- `TMP` / `TEMP` → `${{ github.workspace }}/.cache/packager-tmp`
- Packager `tmpdir` on GHA → `$RUNNER_TEMP/atlarix-electron-packager`
- `forge.config` / fast ignore exclude `/.cache` and `/out` from the app copy; **`/package.json` is always included**

Workflow also runs `node scripts/win-ci-electron-zip.mjs --verify` after `electron/install.js`.

macOS/Linux use `ci:package` + `ci:installers`.

## Local

```powershell
npm run clean
node scripts/win-ci-vite.mjs
node scripts/win-ci-package.mjs
```

Or: `npm run ci:build:win` after Vite prerequisites are met.

## Success signals

- `[packageAfterPrune] start` / `done` and `removed N .map file(s)`
- `[win-ci-packager-worker] OK packaged app at …\out\Atlarix-win32-x64`
- `verify-ci-package-out` OK for package and make stages
- `out/make` Squirrel artifacts
