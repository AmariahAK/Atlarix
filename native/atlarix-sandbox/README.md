# atlarix-sandbox (Windows AppContainer helper)

The write-confining sandbox for agent `run_command` is a command-prefix wrapper
on macOS (`sandbox-exec`) and Linux (`bwrap`). Windows has no such prefix, so this
tiny native helper provides it. `src/lib/sandbox/wrap-command.ts` resolves it from
`process.resourcesPath/atlarix-sandbox.exe` (override with `ATLARIX_SANDBOX_HELPER`)
and invokes the contract:

```
atlarix-sandbox.exe --workspace <dir> [--writable <dir>]... -- <command string>
```

It runs `cmd.exe /c <command>` inside a low-privilege **AppContainer** that can
write only to the workspace/writable paths (+ its own profile temp), read the rest
of the volume, and keep network on (`internetClient` capability). Exit code is the
wrapped command's; sandbox-setup failures exit `87`.

## Build

```sh
cargo build --release            # → target/release/atlarix-sandbox.exe
```

`windows-latest` CI already has Rust + MSVC. The release workflow builds this
before `electron-forge` packages it (bundled via `extraResource` in
`forge.config.ts`, win32-only) and signs it with the same cert as the app.

> First compile happens in CI — this crate is authored on macOS and uses unsafe
> Win32 (the `windows` crate). Budget one iteration for exact API/ACL details.

## Local dev test matrix (mirror the macOS validation)

Set `ATLARIX_SANDBOX_HELPER` to the built exe, then in a workspace:

| Case                                                    | Expected                                  |
| ------------------------------------------------------- | ----------------------------------------- |
| write **inside** workspace (`echo hi > note.txt`)       | succeeds                                  |
| write **outside** (`echo x > %USERPROFILE%\evil.txt`)   | access denied                             |
| `npm install` (network + `%LOCALAPPDATA%` cache)        | succeeds                                  |
| helper missing / `enforce` off                          | command runs unsandboxed + logged warning |
| helper missing / `sandboxRunCommandConfig.enforce=true` | command fails closed                      |
