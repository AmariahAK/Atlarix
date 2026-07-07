# `atlarix-sandbox-linux` — Linux Landlock helper

Write-confining sandbox helper for Atlarix `run_command` on Linux — the sibling of
`native/atlarix-sandbox` (Windows AppContainer). Ships bundled with the app so the
sandbox is **self-contained** (no dependency on an OS-installed `bwrap`); `bwrap`
remains a runtime fallback in `wrap-command.ts` when the helper isn't present.

> **Status:** authored on macOS (Landlock is a Linux kernel feature — the crate is
> `#![cfg(target_os = "linux")]`, so it can't be compiled or run on macOS). **First
> real compile + validation happens in the Linux CI job** (`build-linux` in
> `.github/workflows/release.yml` runs `cargo build --release`). Budget one fix-up
> iteration for the exact `landlock` (v0.4) API surface. Until a Linux build bundles
> it, `wrap-command.ts` falls back to `bwrap`, then unsandboxed.

## Contract (what `wrap-command.ts` calls)

```
atlarix-sandbox-linux --workspace <dir> [--writable <dir>]... -- <command string>
```

- Exit code = the wrapped command's exit code (the process `exec`s the command).
- stdout/stderr pass through.

## Policy

- Handle only WRITE-family Landlock accesses (deny-by-default); grant them back under
  the workspace + each `--writable` root. Reads/exec are NOT handled → unrestricted.
- Network is untouched (Landlock governs the filesystem only) — network stays on.
- **Best-effort** (`Ruleset::default()`): uses the most capable ABI the kernel offers
  and degrades on older kernels (ABI v1 = 5.13; v2 = 5.19). If Landlock is
  unavailable, the command runs unconfined (the harness approval gate is the other layer).

## Build

```
cargo build --release --manifest-path native/atlarix-sandbox-linux/Cargo.toml
# or: npm run build:linux-sandbox
# → native/atlarix-sandbox-linux/target/release/atlarix-sandbox-linux
```

No code-signing needed on Linux. Bundled via `extraResource` in `forge.config.ts`
(guarded on `linux` + `fs.existsSync`); resolved at runtime from
`process.resourcesPath/atlarix-sandbox-linux` (override: `ATLARIX_SANDBOX_HELPER_LINUX`).

## Test matrix (mirror the macOS/Windows validation, run on Linux)

- Write inside the workspace → succeeds.
- Write outside the workspace (e.g. `$HOME/evil.txt`) → denied (EACCES) on kernel ≥5.13.
- `npm install` (network + cache writes under a `--writable` root) → succeeds.
- Old kernel / no Landlock → runs unconfined with a stderr warning.
- Helper missing → `wrap-command.ts` falls back to `bwrap`, then unsandboxed.
