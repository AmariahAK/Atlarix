# `atlarix-sandbox.exe` — Windows AppContainer helper

> **Status:** implemented in `native/atlarix-sandbox/` (Rust). Built + signed in
> the Windows CI job and bundled via `extraResource` in `forge.config.ts`. First
> real validation happens on a Windows build (the crate is authored on macOS);
> see `native/atlarix-sandbox/README.md` for the test matrix. Until a Windows
> build ships it, `wrap-command.ts` still falls back to unsandboxed with a warning.


The macOS (`sandbox-exec`) and Linux (`bwrap`) sandboxes are command-prefix wrappers
handled entirely in `wrap-command.ts`. Windows has no equivalent prefix, so the
write-confining sandbox needs a tiny native helper. Until this binary is bundled,
`wrap-command.ts` falls back to running `run_command` unsandboxed (with a warning),
so nothing breaks.

## Contract (what `wrap-command.ts` already calls)

```
atlarix-sandbox.exe --workspace <dir> [--writable <dir>]... -- <command string>
```

- Exit code = the wrapped command's exit code.
- stdout/stderr passed through.

## What the helper must do

1. Create (or reuse) an AppContainer profile:
   `CreateAppContainerProfile(L"atlarix.run-command", ...)` (or `DeriveAppContainerSidFromAppContainerName`).
2. Grant the AppContainer SID **write** ACLs on each `--workspace`/`--writable` path
   (`SetNamedSecurityInfo` / `icacls`-equivalent, `GRANT (OI)(CI)M`). The container's
   own `AppData\Local\Packages\<profile>` and temp are writable by default.
3. Include the **`internetClient`** capability (so network stays on) in the
   `SECURITY_CAPABILITIES` list. Reads of the rest of the volume remain allowed.
4. Launch the command inside the container:
   `CreateProcessW` with `STARTUPINFOEX` carrying
   `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`. Run the command via
   `cmd.exe /c <command>` (or PowerShell).
5. Wait, propagate exit code, clean up.

## Build + bundle

- Suggested: Rust (`windows` crate) or C++ (Win32). Single static exe, no deps.
- Code-sign it in the Windows build (same cert as the app).
- Place it next to `process.resourcesPath` (Electron `extraResource` in `forge.config.ts`),
  matching how `node-pty`/ctags native binaries are bundled and unpacked from asar.
- `wrap-command.ts` resolves it via `process.resourcesPath/atlarix-sandbox.exe`
  (override with the `ATLARIX_SANDBOX_HELPER` env var for local testing).

## Test matrix (mirror the macOS validation)

- Write inside workspace → succeeds.
- Write outside workspace (e.g. `%USERPROFILE%\evil.txt`) → denied.
- `npm install` (network + `%LOCALAPPDATA%` cache writes) → succeeds.
- Helper missing → command runs unsandboxed with a logged warning.
