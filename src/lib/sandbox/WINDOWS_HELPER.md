# `atlarix-sandbox.exe` — Windows write-confining sandbox helper

> **Status:** rewritten onto **Low Integrity Level** (2026-08-07) after the original
> AppContainer implementation was executed on real hardware for the first time and
> broke the toolchain. Built in the Windows CI job and bundled via `extraResource`
> in `forge.config.ts`. Validated by the `sandbox` probe in
> `src/main/self-test.ts`, which runs in every CI package job.

The macOS (`sandbox-exec`) and Linux (Landlock / `bwrap`) sandboxes are wrappers
handled in `wrap-command.ts`. Windows has no equivalent command prefix, so it needs
a small native helper.

## Policy (identical on all three platforms)

- **WRITE** only to the workspace + granted paths
- **READ and EXECUTE** anything
- **Network stays ON**
- Applies ONLY to agent `run_command`. Interactive PTY tabs are never sandboxed.

---

## Why not AppContainer — read this before "improving" anything here

The first implementation used AppContainer: it created a profile, granted write ACLs
on the writable roots, and added the `internetClient` capability. This document used
to claim:

> ~~"Reads of the rest of the volume remain allowed."~~

**That was false, and it is the entire bug.** In an AppContainer, a file is only
reachable if its DACL carries an ACE for the container SID or for
`ALL APPLICATION PACKAGES`. Windows' own directories ship that ACE; third-party
installs do not.

Observed on Windows 10 the first time the helper actually ran:

| Command | Result |
| --- | --- |
| `where git` | exit 0 — `where.exe` is in System32, which *has* the ACE |
| `"C:\Program Files\Git\bin\bash.exe" -c …` | **`Access is denied`** — no ACE |
| `git --version` | `fatal: could not open '/dev/null'` — container denied the device |
| `powershell.exe -Command …` | could not resolve its own FileSystem provider |

**AppContainer is deny-by-default on reads. This policy is the opposite shape.** It
is the browser/UWP isolation model — Cursor's engineering blog rejected the native
Windows route for exactly this reason, that the available primitives are *"tailored
to browsers and do not support general-purpose developer tools."*

Fixing it by granting the container SID read+execute on `C:\Program Files` and every
PATH directory was rejected: it needs admin **per grant** (`WRITE_DAC`), permanently
mutates system DACLs, and is unbounded — you cannot enumerate the tools the agent
will reach for, so each newly installed tool would need another elevation. Its best
case is "reads are broad", which is Low IL's default for free.

## Why Low Integrity Level

Mandatory Integrity Control has been in Windows since Vista, is present on **every
edition** (including Home), and needs no virtualization, no BIOS setting, no local
accounts, and **no elevation** — which matters because this ships inside an MSIX
Store package. Its default policy is `NO_WRITE_UP`: a Low-IL process may read and
execute higher-integrity objects but cannot write them. That is precisely
"reads broad, writes confined", from the kernel.

The proven fallback if Low IL ever fails is Codex's model (dedicated local users +
restricted tokens + firewall rules), which we declined because it needs a UAC prompt
to create Windows user accounts — poor for a Store app. See `docs/TODO.md`.

## How it works

1. `OpenProcessToken` → `DuplicateTokenEx(TokenPrimary)` →
   `SetTokenInformation(TokenIntegrityLevel)` with the Low SID `S-1-16-4096`.
   Lowering our **own** token needs no privilege — the same construction Chrome uses
   for renderers on standard accounts.
2. Stamp a Low mandatory label on each writable root, so the Low-IL child can write
   there. Built from the SDDL `S:(ML;OICI;NW;;;LW)` — `SetEntriesInAclW` cannot
   produce a `SYSTEM_MANDATORY_LABEL_ACE`, it only emits allow/deny ACEs. Equivalent
   to `icacls <dir> /setintegritylevel (OI)(CI) L`.
3. Point `TEMP`/`TMP` at a directory under `%USERPROFILE%\AppData\LocalLow\Atlarix\`
   (already Low-labelled by Windows) via a hand-built environment block. **A Low-IL
   child cannot write the normal `%TEMP%`**, and a tool that cannot create a temp
   file fails in ways that look nothing like a sandbox denial — that is how git's
   `/dev/null` failure presented.
4. `CreateProcessAsUserW` with the lowered token, running the command through the
   **same shell the unsandboxed path would use** (`--shell`). Without that,
   `getAcceptableShell()` picked Git bash for unsandboxed runs while the helper
   hardcoded `cmd.exe /c`, so POSIX-shaped commands failed under the sandbox with cmd
   syntax errors that looked like denials but were not.

### Contract

```text
atlarix-sandbox.exe --workspace <dir> [--writable <dir>]... [--shell <path>] \
                    [--read-only] -- <command string>
atlarix-sandbox.exe --probe     # exit 0 if the mechanism works on this machine
```

Exit code is the wrapped command's. Setup failure exits **87**
(`ERROR_INVALID_PARAMETER`).

## Two things to know before changing this

**The Low label PERSISTS on the workspace.** It is not reverted after the command:
reverting per-run would race between concurrent commands, and a crash would leave it
behind anyway. The trade, accepted deliberately: **any other Low-IL process running
as that user could write to the workspace** — and Low IL is where sandboxed browser
renderers live. It is a narrow widening of an already user-writable directory, and it
is the cost of using MIC for this.

**`--probe` runs once per session, not per command.** `wrap-command.ts` caches the
verdict and, on failure, reports the sandbox as unavailable so the existing
`enforce`/warn path in `runShellCommand.ts` decides what to do. This is deliberately
a *synthetic* probe before any user command — never a retry after a user command
fails. Retry-on-denial would downgrade to unsandboxed on exactly the commands that
matter, and a crafted command could trigger the downgrade on purpose.

## Testing

`cargo build` succeeding **proves nothing**: the crate is `#![cfg(windows)]`, so on
macOS and Linux it compiles to an empty binary. That is exactly how the AppContainer
version shipped broken — every machine that looked at it reported success, and CI
only ran `cargo build` too.

Two gates now exist:

- `npm run check:sandbox` — `cargo check --target x86_64-pc-windows-msvc` (and the
  Linux triple). Sets `cfg(windows)` for real and type-checks the body; needs no
  cross-linker because `check` never links. Runs in the CI `quality` job.
- The **`sandbox` probe** in `src/main/self-test.ts` — the behavioural gate. Asserts
  write-inside succeeds, write-outside is denied, **read-outside succeeds** (the
  assertion that would have caught the AppContainer bug), a non-system binary execs,
  and `truncate` outside is denied. Runs in every CI package job via
  `scripts/run-packaged-self-test.mjs`.

## WSL workspaces

A workspace under `\\wsl$\…` or `\\wsl.localhost\…` does **not** use this helper. It
is routed into the distro instead (`src/lib/sandbox/wsl.ts`), because the paths and
toolchain there are genuinely Linux. Confinement inside the distro currently uses
`bwrap` when installed, otherwise it runs unconfined with a warning — shipping the
Landlock ELF to Windows builds is tracked in `docs/TODO.md`.
