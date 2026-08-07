# Atlarix TODO

**Current Version:** v14.27.0 (2026-08-05) — your credentials and your workspaces stop
disappearing, and the agent can finally see the automations it should be recommending.
**Last Updated:** 2026-08-07

## 🚧 IN PROGRESS — the Windows sandbox was breaking the toolchain

Found by running the MSIX spike, but **not an MSIX bug** — it has been in every Windows
release since `atlarix-sandbox.exe` started shipping. The helper engaged on every
`run_command` (`Sandboxing run_command (win32); 19 writable roots`, zero fallbacks) and
broke git, bash and PowerShell.

**Root cause: the wrong primitive, not tuning — but not for the reason first written down.**
An earlier version of this entry (and of `WINDOWS_HELPER.md`) blamed file DACLs. The
evidence contradicts that: `"C:\Program Files\Git\bin\git.exe" --version` returned **exit
128** with a `/dev/null` error, i.e. it **executed** — so Program Files was readable and
executable by the container.

The real blocker was AppContainer's **device and object namespace** isolation. `/dev/null`
(→ `\\.\NUL`) failed on all five git invocations; PowerShell could not enumerate drives
(`Cannot find drive 'Microsoft.PowerShell.Core\FileSystem'`); MSYS bash could not create
its shared-memory sections. **It could not be "un-inverted":** a per-path ACL can grant the
file dimension (badly — admin per grant, permanent system mutation, unbounded set), but
there is no ACL and no capability SID for the device map or object namespace. Repairing one
dimension would not have touched the other three.

Low IL works because **it is not a container**: same user token, lower integrity label, so
all four namespaces behave normally and only writes up are refused.

**A second, compounding bug:** the helper hardcoded `cmd.exe /c` while
`getAcceptableShell()` gives unsandboxed runs **Git bash**. So POSIX-shaped commands
(`printf`, `VAR=x cmd`, `mkdir -p`, `echo $0`) failed under the sandbox with cmd syntax
errors that read like denials. A large part of the failing transcript was this, not ACLs.

**Rewritten onto Low Integrity Level.** MIC is built in since Vista, on **every edition
incl. Home**, and needs no virtualization, no BIOS setting, no local accounts and **no
elevation** — which matters for an MSIX Store app. `NO_WRITE_UP` *is* "reads broad,
writes confined". Writes are granted back by stamping a Low mandatory label
(`S:(ML;OICI;NW;;;LW)`) on the writable roots, plus a Low-labelled `TEMP` under
`LocalLow` — a Low-IL child cannot write the normal `%TEMP%`, which is how git's
`/dev/null` failure actually presented.
- **The Low label PERSISTS on the workspace.** Accepted trade: any other Low-IL process
  running as that user could write there (that's where sandboxed browser renderers live).
  Reverting per-command would race between concurrent runs and a crash would leave it
  anyway.
- A `--probe` mode runs **once per session**, cached, so an unusable mechanism is detected
  before any user command instead of surfacing as exit 87. Deliberately synthetic — never
  a retry after a user command fails, which would downgrade on exactly the commands that
  matter and could be triggered on purpose.

**How the references do Windows** (researched, so we don't reinvent): Claude Code —
**none**, WSL2 only, native is an open feature request (#46740). Cursor — **none native**,
runs its Linux sandbox in WSL2, and says the available primitives are *"tailored to
browsers and do not support general-purpose developer tools"*. Codex — the only native
one: dedicated local users + restricted tokens + ACLs + firewall rules, needing a UAC
prompt to create Windows accounts. Ours was the only AppContainer, i.e. the browser
primitive Cursor warned about.

**Linux had a real gap too.** `ABI::V2` was pinned, but `LANDLOCK_ACCESS_FS_TRUNCATE`
arrived in **ABI V3** (kernel 6.2), so `truncate -s 0 ~/.ssh/id_rsa` walked straight
through write confinement — `truncate(2)` works by path and needs no writable fd. Raised
to **V4**. Deliberately *not* V5: that adds `IoctlDev` to the handled set, newly denying
device ioctls — speculative hardening with the same "sandbox breaks the toolchain" risk
we were fixing. The helper also hardcoded `/bin/sh`; it now takes `--shell`.

**The systemic cause: nothing ever EXECUTED either helper.** CI only ran `cargo build`,
and both crates are `#![cfg(windows)]` / `#![cfg(target_os = "linux")]`, so on the wrong
host they compile to an **empty binary and report success**. Two gates added:
- `npm run check:sandbox` → `cargo check --target x86_64-pc-windows-msvc` (+ the Linux
  triple). Sets the `cfg` for real and type-checks the body; needs no cross-linker because
  `check` never links. **This works from macOS** and is now in the CI `quality` job.
- A **`sandbox` self-test probe** — the behavioural gate, running in all three package
  jobs. Asserts write-inside OK, write-outside denied, **read-outside OK** (would have
  caught the AppContainer bug on day one), non-system binary execs, truncate-outside
  denied.

**WSL workspaces now route into the distro.** `\\wsl$\…` / `\\wsl.localhost\…` workspaces
are genuinely Linux projects, so `run_command` goes through `wsl.exe -d <distro>` instead
of being confined Windows-side. Plain `C:\…` workspaces are untouched.

**Also cleaned up, all found by the spike:**
- `configureGitEnvironment()` **deleted** — a blocking `execSync("git --version")` at
  module scope on every launch whose only non-logging effect was setting
  `LOCAL_GIT_DIRECTORY` from `resourcesPath/git`, a path `extraResource` never ships and
  `dugite` hasn't needed since v11. It could never fire. `isGitAvailable()` already does a
  cached lazy probe.
- `GIT_NOT_INSTALLED_MESSAGE` is **platform-aware** — it told Windows users to run
  `xcode-select --install`.
- The proxy's **entire script-injection apparatus removed** (~190 lines). It injected
  stacktrace.js, html-to-image and four `dyad-*.js` clients into every proxied HTML
  response, and **nothing in `src/` had listened for any of their message types since the
  preview surface went in v14.15.0**. Two of the libraries were never declared
  dependencies, so it logged ENOENT on every start and put a `console.error` in every
  proxied page. The proxy is now a straight pass-through — which also stops it stripping
  `accept-encoding` to force uncompressed bodies it no longer rewrites. `worker/dyad-*.js`
  deleted; no `dyad`-named files remain outside e2e fixtures.
- WebGPU probe now awaits `requestAdapter()` instead of testing `typeof navigator.gpu`.
  Chromium exposes the API on machines whose GPU can't back it, so we entered the WebGPU
  path anyway and `onnxruntime-web` logged its own `console.error` before our existing
  fallback could catch. Affects the `.exe` too, not just MSIX.

### Open — needs the Windows machine
- [ ] `run_command` must succeed with git under Low IL. **This is the whole point.**
- [ ] `--self-test` → expect **8 probes** including `sandbox`; confirm an **info**-level
      `Sandboxing run_command` line (it was `debug`, so only failure was ever visible).
- [ ] Confirm `CreateProcessAsUserW` succeeds unprivileged. If it returns
      `ERROR_PRIVILEGE_NOT_HELD (1314)` the probe will report the sandbox unusable and
      commands run unconfined — at which point implement Codex's model.

## ✅ ALSO — attachment file types decided by content, not a hardcoded list

Reported as *".ts isn't always allowed on my Mac"*. Two causes.

**macOS reports `.ts` as `video/mp2t`** (MPEG transport stream). `attachmentMimeType` in
`src/ipc/ipc_client.ts` trusted a non-empty `File.type` first, so a TypeScript file was
recorded as **video** — a filename-derived answer that was confidently wrong.

**And `SUPPORTED_TEXT_EXTENSIONS` was a 39-entry hardcoded allowlist** that could never be
complete. It was missing 44 common text types including **`.mjs`/`.cjs`/`.mts`/`.cts`** —
which this repo's own configs use (`vite.main.config.mts`) — plus `.vue`, `.svelte`,
`.scss`, `.ps1`, `.tf`, `.proto`, `.kt`, `.zig`. Files with **no extension at all**
(`Dockerfile`, `Makefile`, `LICENSE`, `CODEOWNERS`) could never match, and fell through
`read_attachment` to `type: "binary"` with raw base64 — unreadable to the model.

Replaced with `src/lib/file-content-type.ts`, modelled on opencode's
`tool/read-filesystem.ts`: **magic bytes** for images, a **NUL byte** for binary, and
**strict UTF-8** for text. `attachment-extensions.ts` is deleted.

**The extension-vs-content split, which is the durable lesson:**

| Question | Right signal |
| --- | --- |
| Can this be read as text? | **content** — sniff it |
| Which extractor handles this (`.docx` vs `.xlsx` vs `.pptx`)? | **extension** — content only says "ZIP" |
| Is this file sensitive? | **filename** — content cannot tell you |

opencode keeps extension lists too, but only for LSP and formatter routing — the middle row.
`SUPPORTED_DOCUMENT_EXTENSIONS` stays for exactly that reason.

- **`{ stream: true }` on the TextDecoder is load-bearing.** An 8 KB sample sometimes cuts a
  multi-byte character in half, and a non-streaming `fatal` decoder throws on the truncated
  tail — which would report any file with non-ASCII content near the boundary as binary.
  There is a regression test, verified by removing the flag and watching it fail.
- **SVG is now text everywhere.** `read_attachment` already did this (*"providers reject
  image/svg+xml as image input"*); only the renderer disagreed and tagged it `image/*`. The
  two now agree, and the special case is gone rather than duplicated.
- Sample is 8 KB (git's threshold), so classifying never means reading a large attachment in
  full. A NUL past the sample is not seen — the same tradeoff git makes, documented in a test.

### Deferred (recorded, not started)
- [ ] **Configurable read-deny patterns, opencode-style** — no built-in list, no defaults;
      the user declares their own (`read: { "<pattern>": "ask" | "allow" | "deny" }`). Chosen
      over Codex's model (which ships defaults for `.env*`, keys, `.aws/credentials`,
      `secrets/**`, overridable in `AGENTS.md`/`config.toml` and enforceable via
      `requirements.toml`) because it keeps `src/lib/tools/glob.ts:221` intact — that line
      already records the deliberate decision that *"in-workspace files (incl. .env) are
      enumerable"*, citing the same references. Purely additive, nothing to reverse.
      **Caveat that dominates the estimate:** the config is the easy half. A deny-read is
      only real if `run_command` cannot `cat` the file. macOS Seatbelt takes
      `(deny file-read* …)` and Linux Landlock takes read rights in the handled set — both
      cheap. **Windows Low IL cannot**: MIC is `NO_WRITE_UP`, so reads up are allowed by
      design. It would need a `NO_READ_UP` label per protected file (persistently mutating
      the user's files) or tool-level checks only, which `run_command` bypasses. Ironically
      the AppContainer we removed *could* deny reads — that is exactly why it broke. Scope as
      tool-level enforcement everywhere + sandbox-level on macOS/Linux + a documented Windows
      gap.
- [ ] **Ship the Landlock ELF to Windows builds** so WSL workspaces get real confinement
      instead of bwrap-if-present. `forge.config.ts:319` only bundles it when
      `process.platform === "linux"`, and cross-building from `windows-latest` needs a
      toolchain that runner lacks — pipe it from the `build-linux` job as a CI artifact.
- [ ] Landlock `ABI::V5` (`IoctlDev`) once there's a compatibility test for device ioctls.
- [ ] `proxy-worker` self-test probe can't run from source: `start_proxy_server.ts:30`
      resolves `__dirname/../../worker`, which is right in the packaged build and wrong
      under vitest. Covered meanwhile by `src/__tests__/proxy-passthrough.test.ts`.

---

## ✅ SHIPPED — Microsoft Store (MSIX) packaging + the Windows brand fix

Spike **passed** on Windows 10: package installs, Google OAuth deep link returns to the
app (validating the manifest's `windows.protocol` declaration), `userData` resolves to the
**same** `%APPDATA%\Atlarix` as the Squirrel build so Store users inherit their profile
(**no migration needed**), sub-agents run, terminal works, Lemon Squeezy reaches checkout,
and the updater correctly logged *"no bundled updater for this install (Microsoft Store)"*.

Goal: list Atlarix on the Microsoft Store so Windows users stop hitting SmartScreen
(Microsoft re-signs with a trusted cert). Everything below is **additive** — the Squirrel
path is untouched, and MSIX is `workflow_dispatch`-only until it is proven on real hardware.
Full procedure in [`docs/MSIX_RUNBOOK.md`](MSIX_RUNBOOK.md).

**The Windows installer and app were shipping the OLD project's logo.** `assets/icon/logo.ico`
was never regenerated during the rebrand, so both the installed app (packager resolves `.ico` on
Windows) and the Squirrel installer carried it. macOS looked right, which is exactly why nobody
caught it. `logo.png` and `logo.iconset/` had drifted too — both a letterboxed, vertically
stretched crop rather than the clean square in the `.icns`.
- `assets/icon/logo.icns` is now the SINGLE source of truth; `scripts/gen-icons.mjs` derives the
  iconset, a square 1024² `logo.png`, the 7-frame `logo.ico`, and the MSIX Store logos from it.
  Hand-editing any output is what let them drift apart in the first place.
- **`MakerSquirrel` was dropping `setupIcon` on every signed build.** It sat in the `else` arm of a
  ternary on `SM_CODE_SIGNING_CERT_SHA1_HASH`, so the branch that ran in CI — i.e. every real
  release — set `signWithParams` and no icon at all. Signing and branding are independent; both
  are now always set.
- **deb/rpm were shipping the generic Electron atom.** Neither maker set `options.icon`, so
  `electron-installer-common` fell back to its own bundled default. Both now get a proper
  multi-resolution hicolor set. (Forge types this as `string`; the runtime branches on shape and
  accepts the object — hence the `@ts-expect-error`, same as `chromiumSandbox`.)

**MSIX packaging.** Not `@electron-forge/maker-appx`: it imports `electron-windows-store` (2023,
undeclared) and its cert path shells out to `makecert.exe`, removed from the SDK years ago.
`scripts/make-msix.mjs` drives `makeappx.exe` directly, which is what gives us exact manifest
authority — needed because the `windows.protocol` declaration is load-bearing.
- **MSIX virtualizes HKCU writes into a package-private hive**, so
  `app.setAsDefaultProtocolClient` cannot register `atlarix://` system-wide. That would have
  broken Supabase OAuth, MCP OAuth, and the Lemon Squeezy `atlarix://pro-return` completion leg.
  The manifest declares the handler instead; full-trust activation arrives as argv, which
  `extractDeepLinkUrl` already handled on both the cold-start and second-instance paths.
- **Squirrel would have run against a read-only install dir.** `chooseUpdaterKind` returned
  `"squirrel"` for any packaged win32 build, and `C:\Program Files\WindowsApps` cannot be written.
  It now returns `"none"` for `process.windowsStore`, checked BEFORE the win32 branch. The
  `"none"` case in `main.ts` also needed an explicit branch — it used to fall through to
  `initAutoUpdater()`, whose internal guard only rejects deb/rpm and mac-outside-`/Applications`,
  so an MSIX install would have sailed past it.
- `appExecutionAlias` puts `atlarix.exe` on PATH. Doubles as a real CLI entry point
  (`atlarix C:\repo` — `openWorkspaceFromCliPath` already existed) and is the only practical way
  to run `--self-test` inside the package, since the installed binary is ACL-restricted.

**Spike probes.** `context`, `child-exec`, and `fs-outside-container` added to `self-test.ts`, so
three of the four spike questions produce a pass/fail table instead of hand observation.
- `child-exec` exists because **`pty-spawn` silently false-passes on Windows**: it writes
  `printf '%s\n' <marker>` into a PowerShell pty, and PowerShell has no `printf`, so the marker
  lands in the *error* text and the probe goes green having executed nothing. `pty-spawn` still
  proves node-pty loads/spawns/streams, so it stays; `child-exec` asserts on the exit code.
- `src/__tests__/self-test-probes.test.ts` is new — the probes are the packaged-build safety net
  and nothing verified the probes themselves.

### Open — needs the Windows 10 test machine
- [ ] Run the spike (runbook §4). **Baseline on Squirrel FIRST** — `atlarix-sandbox.exe` has never
      been validated on real Windows (`WINDOWS_HELPER.md`), so testing it first inside MSIX makes
      any failure unattributable.
- [ ] **Record `userData=` from the `context` probe and diff it against the Squirrel baseline.** If
      the path diverges, a Squirrel user switching to the Store build silently gets a fresh profile
      — no workspaces, chats, or credentials — and needs a one-time migration. Measure before
      building anything.
- [ ] Confirm the manifest protocol declaration works (OAuth sign-in) and that
      `atlarix://pro-return` completes a Lemon Squeezy purchase.

### Open — owner-driven, after the spike passes
- [ ] Store listing: description, screenshots, category, age rating.
- [ ] `runFullTrust` justification (restricted capability, needs Microsoft approval) + the
      Lemon Squeezy IAP note. Both drafted in the runbook §5.
- [ ] Submit; Microsoft strips the test signature and re-signs.
- [ ] **Only after certification passes**, wire MSIX into `release.yml`. Windows-only path bugs
      here have a history of surfacing at tag time.
- [ ] `MakerSquirrel.iconUrl` is still unset, so Add/Remove Programs shows a Squirrel default.
      Needs a publicly-hosted 256px `.ico` (e.g. `https://www.atlarix.dev/logo.ico`) — a one-line
      addition to `atlarix-launchpad/public/`, deliberately not pointed at a URL that 404s.

## ✅ SHIPPED in v14.27.0 — stop losing credentials, stop deleting workspaces, let the agent see automations

**One root cause was silently destroying credentials.** Reported as two symptoms — "I didn't
sign out so why does the app log me out when I close it" and "I keep losing all my api keys" —
and they were the same mistake in two places: **a transient `safeStorage` unavailability was
read as "there is no data", and the emptiness was then written over the real data.**
- `readBlobFromDisk` SKIPPED an existing `supabase-auth.enc` when encryption was momentarily
  unavailable and returned `{}`, indistinguishable from never having signed in. That `{}` was
  then **cached**, which silently defeated the v13.9 hardening: `restoreAuthSessionOnStartup`
  retries `getSession()` after 400 ms for exactly this condition, but the retry re-read a cache
  instead of the disk, so the documented fix could never fire. The next `setItem`/`removeItem`
  persisted `{}` over the file. A session obtained while unavailable was never written at all —
  the literal "close the app and you're signed out".
- Same shape for API keys: `readSettings` DELETED any secret it could not decrypt, and
  `writeSettings` was built on `readSettings`, so any later write of an unrelated setting
  (theme, zoom, model) persisted the stripped object and erased the keys. `writeSettings` no
  longer depends on being able to read: it encrypts what the caller supplied and round-trips
  untouched ciphertext for everything else. The warning that said "re-enter API keys" — advice
  that made the loss permanent — is gone.
- **Verified by reverting**: 4 of 7 session tests and 3 of 5 settings tests fail without the fix.
  Assertions are on the BYTES ON DISK, because a read returning nothing while the keystore is
  busy is acceptable and only the file distinguishes that from loss.

**Signing out no longer deletes your work.** It ran `db.delete(apps).run()` unconditionally
("fresh start"), cascading through chat sessions, MCP servers, daily logs, workflow templates
and automations. The Free cap now gates CREATION — the same way `mcp_handlers` and
`automations/service` already enforced theirs — instead of deleting all but the OLDEST
workspace on sign-in. Three bugs surfaced doing it: the creation check already existed but ran
BEFORE the dedupe lookups (so a Free user at the cap could not re-open their own only
workspace); the duplicate path had no check at all; and the workspace count was memoised with
invalidation only on delete. Cleanup is now an unchecked box in a sign-out dialog.

**The agent can see automations.** `grep -rn "automation"` across every prompt and skill
returned zero hits while the feature had tables, three trigger kinds, a runner, pollers and a
feed. One mode-parameterised `automations` tool in every mode; `list` free, mutations through
the approval gate. **`notifyAgent` is required with no default** (owner's design): it decides
whether a finished run reaches the agent, so `false` means the automation can never cost
tokens however often it fires. Toggleable either way afterwards.

**The agent has no terminal tabs.** The auto-close machinery — four special-case rules and a
6-second timer, to stop a surface being annoying — is gone, along with the `terminal` param and
tab-name addressing. Two real bugs fell out: `background_jobs` read returned NOTHING unless the
Terminal tab happened to be open (the renderer owned the buffer), and `maxLines` capped entries
rather than lines, so asking for 50 returned 900 straight into the context window.

**The agent knows the plan caps** (owner-requested): `1/10` MCP servers and `2/10` automations
per workspace, Free/Pro. It could previously learn a cap only by hitting it, and nothing in the
prompt, the mode bundles or `AGENTS.md` tells it the user's tier — so a refusal read as a broken
workspace. `list_available_mcps` and `automations list` now return
`limits: {tier, used, max, canAddMore, proMax}`, and each tool description carries one clause
naming both tiers AND the behaviour: a cap refusal means remove-one-or-upgrade, not a retry and
not a workspace fault. All four numbers moved to `lib/plan-caps.ts` and every consumer
interpolates — with the caps now appearing in PROMPTS, a literal that drifted from the constant
is the one kind of hardcoding nothing would ever catch. Tests assert against the imported
constants for the same reason.

**Six defects found by USING the packaged build** — the log is readable again now that tests
don't write to it:
- **The model was never told the workspace path.** Log: workspace `…/Github/railway-cli`, agent
  ran against `…/Github/AI/railway-cli` (the parent of a different repo spliced in) and spent a
  turn hunting. `appPath` appeared in no prompt, yet `run_command` takes a `cwd`. Now a
  `workspaceRoot` context section states it, and `resolveWorkingDirectory` names the correct root
  in its error so a wrong guess self-corrects.
- **`@` led with dotfiles** — my own regression from the stable-sort added the day before. Now
  visible before hidden, shallower before deeper.
- **An agent-created automation didn't appear** until the panel was poked: there was a broadcast
  for RUNS and none for definitions. `automations:changed` now fires from the service.
- **On Pro the model was told to "upgrade"** at 10/10. `capRemedy` is tier-aware.
- **A cloud model whose key vanished read "(local)"** while Core answered — the display inferred
  the provider from the model NAME (no `/` → literal "local") instead of using
  `selectedModel.provider`, which was in scope. It kept streaming the whole time, which is how it
  went unnoticed: the app worked and lied about it.
- **Automations UI**: scrollable time picker (cron stays the source of truth), and `pipeline`
  triggers with a free-form `host` resolved through a poller registry that is also the
  validation — an unpollable host is refused rather than saved to never fire.

**Tests stop eating the evidence.** The suite wrote to `~/Library/Logs/Atlarix/main.log` — the
packaged app's own log — and had rotated the real history away inside three minutes, destroying
the diagnostic record of the credential bug while it was being investigated. Same class as the
435 empty `~/.atlarix/projects` directories fixed in v14.25.0, with a worse failure mode: that
one created junk, this one deleted evidence.

## ✅ SHIPPED in v14.26.0 — one engine for every file lookup, one answer per permission question

**File discovery had three engines and a hand-maintained exclusion list.** See the struck
section below for the full account, including the two corrections found while implementing.
Net **+430/-2,220**, and `@`-mention now behaves the same for every user regardless of what
they have installed.

**The permission surface was measured before anything was cut**
(`docs/PERMISSION_SURFACE_AUDIT_v14.26.0.md`). Four duplication hypotheses went in; **all
four were refuted.** `guard.ts` is not a permission mechanism at all (schema validation and
an error trap). The three "ways to say ask/deny" are three different AUTHORITIES — committed
team policy, remembered personal click, executable escape hatch. The danger/system-scope
gates already declare themselves UX in front of the boundary, and answer two different
questions the sandbox cannot answer at all. `isReadOnlyWorkMode` has exactly two references
in the codebase: its definition and one call site. **The layers are distinct; they are not
duplicates.** What the audit did find was one config key that did nothing and one very large
file.

- **`ask` in `.atlarix/permissions.json` is DELETED.** It was compiled, matched, returned as
  a decision — and then logged. A user who wrote `"ask": ["run_command(git push*)"]` got a
  log line and believed they had a gate. Not a hole (it fails toward asking more), but a
  config key that silently does nothing is worse than an absent one. An `ask` key found in a
  file now WARNS at load.
- **`interceptor.ts` 2,128 → 1,919.** Pure helpers extracted (`command-output.ts`,
  `operation-targets.ts`), plan-ledger refresh moved to `lib/tasks/plan-ledger-from-file.ts`,
  and `toCodeProposal` — a PUBLIC method with zero consumers — deleted. Characterization
  tests were written FIRST and immediately found **two real bugs in `formatCommandOutput`**,
  which every non-trivial command result passes through and which had no direct coverage:
  the truncation notice is 105 bytes but only 80 were reserved (so the byte cap never held),
  and the cut landed mid-rune, where Node substitutes a 3-byte U+FFFD — leaving the result
  both corrupted and LARGER than the slice it replaced. Any CJK or emoji output hit it.
- **Workspace hooks are DELETED** (owner: "I do not fundamentally see the value"). The case
  for keeping the `stop` gate and the committable-policy property was put and declined.
  `profile.taskCompleteGate` went with them — hooks was its only producer. The
  `.atlarix/hooks/**` auto-approve refusal STAYS: inert now, but a guard removed because its
  subject went away is how that class of hole reopens, and it was itself one of v14.25.0's
  eight findings.
- **Accessibility statement** at `atlarix.dev/accessibility`, covering both the site and the
  app, claiming **no** conformance level (nothing has been audited) and naming its gaps.

## ✅ ALSO IN v14.26.0 — one path rule, memory that compacts, cross-repo revert

**One spelling for reaching another project.** The four file tools disagreed: `glob`/`grep` took
`../sibling` and absolute, `read_file`/`edit_file` took absolute only and threw on `../`, and `glob`
rejected `..` inside the *pattern* with "Use a path within the project" — false since v14.25.0, and the
one message the model actually hit. Observed cost: it abandoned the tools for `pwd`/`ls`/`find` and then
guessed the wrong parent directory. Now **absolute is canonical, `../` is absorbed**, all four resolve
identically, and the rule is stated once via `shared-fragments.ts` into AGENTS.md, both sub-agent skills
and all three `BUILTIN_AGENTS` prompts — with the WRITE half split out so the read-only explorer is
never told about `edit_file` it cannot call.

**Memory compacts; it is not capped.** Nothing is ever refused for size and nothing is deleted to make
room. Past 25 MB per project, `planMemoryCompaction()` names the largest notes (never `MEMORY.md`) and
asks for a rewrite that is *more accurate about the file or feature it concerns*. A pending write counts
in place of the note it replaces, so a shrinking rewrite reads as progress on that same call.
- The signal is a **flag, not a lesson**: it rides the memory header line already being paid for
  (`[26.0 MB — compact a.md, b.md (see guides/memory)]`). The first version pasted a 147-token paragraph
  into **every turn** until the store shrank — the payload-instead-of-index mistake v14.25.0 existed to
  undo. Measured 147 → 24 tokens/turn (84%); guard tests fail if instruction prose creeps back in.
- The eager `mkdirSync` that created a memory directory for **every workspace path the app ever saw** is
  gone (lazy now). It had put **435 empty `…atlarix-grant-…` directories in the developer's real
  `~/.atlarix/projects/`**, because the test suite builds temp workspaces; `vitest.setup.ts` now points
  memory at a temp dir so no test can reach `~/.atlarix`.

**Cross-repo edits are revertible.** Outside paths were dropped before reaching `captureSnapshot` (one
`git add` at `cwd = workspace` aborts on a path outside its work-tree, which had destroyed the
in-workspace snapshots beside it) — so an approved edit to a granted sibling silently had **no Revert**.
`captureSnapshotAcrossRoots` groups a turn's paths onto the primary workspace plus each granted root and
captures each against its own shadow work-tree; revert/list/exists iterate roots. Ungranted absolute
paths are still dropped. Per-root locks — wrapping the captures in the primary's lock deadlocks on
`captureSnapshot`'s own chain.

**The sandbox says it was there.** See the deleted-supervisor entry below.

**`auth:enforce-workspace-limit` runs once per session.** It DELETES workspaces, and ~24 `useAuth`
consumers each invoked it on one sign-in (five log lines observed). It survived only because
better-sqlite3 is synchronous, so later copies saw the post-delete state and no-op'd — a destructive
operation racing itself. Coalesced + remembered in the handler, cleared on sign-out, failures not
remembered. Fixed in main, not the hook: 24 call sites means re-deriving the invariant at the 25th.

**Session load: measured, and my hypothesis was wrong.** Every stage suspected of the macOS beach ball
totals ~550 ms on the real 44-message / 4.54 MB session (DB read 5 ms, IPC clones 11 ms, display
hydration 31 ms, re-parse 37 ms, shiki 76 ms, token count 345 ms), of which only the token count blocks.
**Root cause still unknown** — instrumentation is in place behind `ATLARIX_DIAG_SESSION_LOAD=1` (main) /
`localStorage["atlarix:diag:session-load"]` (renderer), including a `state → painted` span; it needs one
session-open in the packaged app. Landed anyway because each is a defect on its own merits: the renderer
no longer ships the whole payload BACK to main (ids only; the old channel deleted), the hydration pass
that discarded `threadFromSnapshot`'s sub-agent merge is fixed (data loss, not slowness), the load
yields so the overlay can actually paint, and `workspace-session-title.ts` no longer fetches every
message body to read one field after every turn.

**A session that opens with a paste was never named.** Found in the packaged app and confirmed
against the live DB: two sessions, 10 and 20 messages long, still called "Untitled" while every
other recent one was named. Both opened with a user message that was nothing but
`<atlarix-text-attachment …/>`, which strips to `""`. Two faults had to line up.
`sessions:generate-title` looks PAST an attachment-only user message — right, except when it is
the only one, and the gate `!firstUser || !firstAssistant` then returned "Untitled" with a 289 KB
reply unread and its own `generateSimpleChatName` last resort unreachable behind the early return.
Meanwhile the renderer called `markTitleGenerated` BEFORE generating, so one starved turn closed
the door for the session's life. Now: bail only when BOTH sides are empty, and mark it done only
when a title lands, bounded at three attempts so an unnameable session stops asking.

**`background_jobs` searched the user's shells.** `listTerminalInstances` returns every instance
including `owner:"user"`, and the finished-job fallback matched labels by SUBSTRING — and user
tabs are labelled by their last command. So `job:"pnpm check"` could return the buffer of a shell
the user was typing in, and the error named those shells (`Open terminals: ["Agent"]`). The test
missed it because it re-implemented the three-step match by hand and both copies searched
everything. LESSON: a test that mirrors the logic it tests validates the bug. The resolution is
one exported `findAgentBuffer`; the test calls it. Also: it now falls back to the shared
foreground buffer rather than refusing output it holds, and speaks `list`'s vocabulary (retained
COMMANDS) instead of naming a terminal UI the agent no longer has.

**Three Windows path bugs, caught by the tag build and nothing before it.** The v14.26.0 batch was
folded into this release rather than tagged, and installers only build on `v*` — so its file-tool
rewrite reached a Windows runner for the first time at the v14.27.0 tag, and failed three tests.
All three were real product defects, all silent:
- `parseGrepOutput` split ripgrep lines on `:`, so a drive letter became the filename and
  `parseInt` returned NaN — **every match discarded, on every search**, reported as "No matches".
  ripgrep always gets an absolute search root, so this was total on Windows.
- `absorbPatternDirectoryPrefix` rebuilt an absolute prefix as `path.sep + join(path.sep)`, right
  on POSIX (where splitting drops an empty leading segment) and wrong on Windows:
  `C:\proj\x` → `\C:\proj\x`, so **every absolute `glob` pattern** returned a tool error.
- glob's bare-`*` filter tested `!f.includes("/")`, so on Windows it matched nothing and
  `glob("*")` returned **the whole recursive tree** instead of one directory.

**LESSON — the platform has to be a parameter, not the runner.** `path.isAbsolute("C:\\x")` is
FALSE on macOS and Linux, so the broken branches were unreachable from any developer machine and
from every CI job except the Windows one. The existing tests were correct and did catch all three
— they simply had nowhere to run until a tag. Both new test files
(`glob-absolute-pattern-windows`, `grep-windows-drive-letter`) take Windows-shaped strings or an
injected `path.win32` directly, so they run everywhere. Do this for any new path handling.

**Verification without a tag:** `gh workflow run "Atlarix CI" --ref main` runs `build-windows`
(its `if` accepts `workflow_dispatch`) while `publish-release` and `announce-release` stay skipped
— they require a tag ref. Two dispatch runs took this from 3 failures to 2 to green.

**The release workflow truncated its own notes at 80 lines.** This section is 92, so the last two
paragraphs would have vanished from the published GitHub release with nothing to mark the cut.
Raised to 400 (a runaway guard; the CHANGELOG section boundary is the real limit). Discord stays a
40-line teaser but now always carries the full-notes link, not only when the extract came back
empty. CHECK THIS BEFORE EVERY TAG: `scripts/ci/extract-changelog.sh <version> 400 | wc -l`
against what the workflow passes.

## ✅ SHIPPED in v14.25.0 — honest context accounting, skills on demand, one grant list

**The meter counted the wrong thing.** `token_count_handlers` scored each message's display
prose and never `modelContent`, where the native tool history lives — so it undercounted by
every file body, grep hit and command output, which in a coding session is most of the context.
Two of its five rows were hardcoded `0`. Seven attributed rows now PARTITION the total (tool
buckets carved OUT of history, never added on top), pushed live from `onStepFinish` because
mid-turn the results exist only in main. Traps found: the delta cache froze the newest row (its
`modelContent` lands at finalize, so the id never moves); `activeSkill (truncated)` compared
trimmed against untrimmed text and fired on EVERY turn; `ContextAssembler`'s budget is
`Infinity`, so its trimReport is always empty and the "pruned" panel was dead.

**Skills → index** (`src/lib/skills/skill-index.ts`). Bodies were pasted every turn AND clipped
(`cap()` mid-file, skill 11 gone, names list cut at 10). Cost now scales with the NUMBER of
skills. GOTCHA: the frontmatter parser took only JSON-quoted arrays, so `compatibleModes: [Debug]`
fell through to scalar and silently meant EVERY mode.

**One grant list, both lanes.** Commands read `sandbox_path` DB rows; edits read an in-memory Set
nothing ever seeded — so a folder granted to a command was still refused to `edit_file`, which
threw AFTER the user approved the diff. Unified, re-read per write so a revoke bites immediately,
with Add-folder + revoke UI in Settings → Workflow.

**`cd` grants nothing.** A regex pulled `^cd <abs>` out of the MODEL's own command string and
added it to writable roots, unsandboxed. Checked against Claude Code, opencode, Codex and Cursor
— none infer scope from text the model wrote. Removed; the sandbox is now widened rather than
disabled for outside-path commands (installers still bypass, since their writes can't be
enumerated).

**Eight defects nobody was looking for:** `.atlarix/hooks/` blanket auto-approve (live in every
prior version — the agent could write a file handed to `/bin/sh -c` every tool call, no card);
eleven dead renderer IPC listeners (preload forwards only the payload; the bridge type now makes
the mistake a compile error); one outside path aborting the whole `git add` and discarding
in-workspace snapshots; extension rules matching outside the workspace; agent memory un-writable
then silently auto-approved; the prompt calling Debug mode "Fix"; grep silently matching nothing
for `../`; and a launch that rendered signed-out for seconds before flipping.

- Mid-task compaction CONFIRMED at 90% of the REAL context window, non-fatal on summarizer
  failure. Threshold extracted to `src/lib/context/mid-loop-threshold.ts` — one source, and
  testable without dragging in the summarizer/provider/keychain chain.
- Deleted: `providers/base-provider.ts` (dead StackSense port), `installed-skills.ts`, the
  orphaned `skills:get-active-for-session` IPC, the unreachable repo-skill `priority` branch.
- Tests: 297 files / 2405 green; tsc (app, main, tests) + oxlint clean; packaged self-test 4/4.
- ~~**Still open:** `useAuth` fan-out — "Enforcing workspace limit" fires 5× on sign-in.~~ —
  **MOOT in v14.27.0.** The fan-out is unchanged (~22 consumers still each run their own session
  check), but the thing they were all invoking is gone: `auth:enforce-workspace-limit` DELETED
  workspaces, which is why a self-racing burst mattered. The cap gates creation now, so there is
  no destructive operation to serialise. What remains is ordinary duplicate reads.

## ✅ SHIPPED in v14.24.0 — the clone dialog actually clones

A VCL reviewer (fresh Linux VM, 2026-07-31) pasted a public GitHub URL into **Clone
repo**, named the workspace, and the **Clone button was disabled with no explanation**.
They read it as "GitHub sign-in required", declined, and abandoned the rest of the
onboarding review. `canCloneUrl` required `targetParentDir`, which started `null` with no
default and could ONLY be set by completing a native directory picker — and
`chooseFolder` swallowed both cancel and failure, so a picker that never opens left the
user with a dead button and no error.

- **A destination is always the user's explicit choice — and always reachable.** The
  "Save to" field is now a typeable path input next to the picker, moved BELOW the
  URL/name fields so it sits directly above the button it gates. Nothing is prefilled and
  nothing is remembered between clones (owner's call: never guess a location). Typed
  paths are validated in main via the new `workspace:validate-parent-dir` (tilde
  expansion, absolute, existing-or-creatable, `W_OK`), since the renderer has no `path`.
  A picker that *fails* now toasts; a picker the user *cancels* stays silent.
- **The disabled button states its reason** ("Paste a repository URL to continue" /
  "Choose where to save this repository to continue"). The GitHub tab had such a hint;
  the URL tab — the default tab — had none, which is the whole bug.
- **GitHub tab is select-then-clone.** Clicking a repo used to clone immediately, so the
  destination had to live above the tabs; rows were disabled with no destination. Now it
  selects, and the tab carries the same destination + Clone button as the URL tab.
- **Any git host.** One shared parser (`src/shared/git_remote_url.ts`) replaces the two
  GitHub-only regexes, so GitLab/Bitbucket/self-hosted URLs clone instead of being
  refused as "Invalid GitHub URL". **Hard transport allowlist** (https/http/ssh/git):
  `ext::` is rejected outright — `ext::sh -c "…"` is arbitrary command execution through
  git's remote helper — along with `file://` and any argument starting with `-`.
- **SSH URLs are no longer rewritten to HTTPS.** `git@host:owner/repo.git` reaches git
  verbatim so the user's agent/keys authenticate it (`GIT_SSH_COMMAND=ssh -o
  BatchMode=yes`, `GIT_TERMINAL_PROMPT=0` so nothing blocks on a prompt). With no git
  binary, SSH fails with an explicit message — isomorphic-git speaks HTTPS only.
- **Real errors, redacted.** The clone path returned a fixed "Failed to clone repository.
  Please check the URL and try again." for every failure. It now maps auth / DNS /
  not-found / missing-git and otherwise shows git's own last lines. **All of it passes
  through `redactGitUrlCredentials`, including the `logger.error`** — the authenticated
  clone URL embeds the OAuth token and git echoes URLs in stderr, so surfacing stderr
  without redaction would have leaked tokens into toasts and log files.
- **The GitHub pre-check is a courtesy, not a gate.** It turned ANY `fetch` failure into
  "Repository not found or you do not have access to it." Now only a definitive 404/403
  stops the clone; offline/proxy/rate-limit falls through and lets git report the truth.
- **Real progress.** New `execStreaming` (spawn-based, same never-reject/exit-127
  contract as `exec`) parses `git clone --progress` stderr; `gitClone` gained
  `onProgress`, mapped into a 15–85 band. Verified live: 14 events, 7% → 100%. Before,
  a clone sat at 15% until it finished and looked hung.
- **Correct DB rows.** `githubOrg`/`githubRepo` are only set for github.com hosts — they
  mean "linked to GitHub" and build the push URL, so a GitLab clone with them set would
  have pushed to github.com. `githubBranch` comes from `gitCurrentBranch` instead of a
  hardcoded `"main"`.
- Tests: `clone-url-parse` (19), `clone-error-surface` (8), `clone-destination-validation`
  (7), `renderer/clone-dialog` (8). Full suite 250 files / 2211 tests green; tsc (app,
  main, tests) and oxlint clean.
- **Deleted:** `e2e-tests/github-import.spec.ts` drove an "Import App" modal with Local
  Folder / Your GitHub Repos / GitHub URL tabs — a UI that no longer exists anywhere in
  `src`. Dyad-era, already stale before this work.
- **Still open:** no e2e spec reaches the welcome launcher at all (`po.setUp()` navigates
  the older settings/apps shell), so the clone dialog is covered by jsdom renderer tests
  rather than Playwright. Worth a harness path for the launcher if welcome-screen
  regressions ever recur.

## ✅ SHIPPED in v14.23.0 — providers off the hardcode, a plan gate that stops fighting

### Third batch — Stop actually stops, and Revert survives it

Reported live (deepseek-v4-pro, caddy repo): the user pressed Stop mid-task because the
agent was running the wrong command. The agent kept going, re-read the file it had just
edited, concluded **the user** had made the fix, and pushed to git. Revert was unavailable
for that turn. Three separate causes:

- **Stop did not stop.** `chat:cancel`'s `response:end` carried no cancellation marker, and
  the renderer auto-wakes a FRESH turn whenever a background command or sub-agent has a
  pending result — which is the normal state right after a stop, since cancel kills only
  FOREGROUND commands. There are TWO wake sites (the `response:end` race-closer and the
  background job/task listener); both now honour a `userCancelled` end plus a
  `userStoppedChatsRef` latch, released only when the user sends a real message. Owner's
  call: background work still finishes quietly — nothing is killed and nothing is dropped.
  Results stay pending and drain into the next turn via
  `takePendingBackgroundCommandResults`, which is wake-independent.
- **Revert vanished on exactly the turn you stopped.** The pre-write bytes were on disk
  (the interceptor captures at write time), but `snapshotTurnId` was only sent on the clean
  finalize path, and `RevertTurnAction` renders nothing without it. `chat:cancel` now
  reports it via a new `streamTurnIdByChatId` map, and the renderer's store of that id was
  hoisted out of the `rawFromRef` (thinking-snapshot) branch it had no reason to depend on.
- **The harness told the model the user had made the fix.** `edit.ts` said "The file likely
  changed since you read it" on ANY near-miss, including when this turn was the thing that
  changed it — which is how the model read its own edit as the user's. Same class as the
  v14.22.0 notice work.
  - **First attempt, discarded:** a `turn-write-log` that tracked authorship so the error
    could say "YOU edited this". Wrong question, and it was **inert in production** — the
    funnel only ever injected `_scopeChatId` for the two attachment tools, so the check
    never fired. Tests passed because they supplied the id themselves.
  - **Shipped instead:** the near-miss message no longer theorises about WHY the content
    differs. It says `old_content` doesn't match and shows the candidate. No tracking at all.
  - **Plus a read-before-OVERWRITE gate** (`lib/tools/file-read-log.ts`), scoped
    deliberately to `operation:"write"` over an EXISTING file. Not to `replace`: a replace
    already carries a content-addressed freshness check (`old_content` must match, so a
    stale view errors instead of corrupting), and gating it would add a read per file to the
    path Build mode explicitly tells the agent to prefer — for a hazard already handled. An
    overwrite has no such guard and silently discards the whole file. Creating a new file is
    exempt. Hashes what the READ RETURNED, not disk, so writer sub-agents (which read their
    proposal overlay) aren't reported stale; `recordEditProposal` refreshes the record so a
    sub-agent's own second edit isn't blocked. `ATLARIX`-free, no env flag — it is cheap
    enough not to need one.
  - Considered and rejected: gating `replace` too. Six tests moved on that version, one of
    them the SWE-bench smoke test — a signal that it changed benchmark behaviour for a class
    of failure that already fails safe.
- **Confirmed, now pinned by a test:** sub-agent edits ARE revertible. `proposals accept`
  returns an `edit_file` permission envelope rather than writing, so it travels the same
  interceptor executor that snapshots `preview.path`. A test asserts the envelope shape and
  that accept leaves disk untouched — if accept ever grows a direct write, sub-agent changes
  would silently stop being revertible.

### Fourth batch — found by using the packaged build

- **Raw plan JSON leaked into the reply.** `","progress":"0/14 steps done` rendered as chat
  text. Every stripper in `answer-display.ts` needs a COMPLETE object, and the `}`-anchored
  tail strip needs its closing brace, so a truncated echo matched nothing — and `progress`
  wasn't a known result key until this release added it, so a new field became a new leak.
  New `stripTruncatedToolResultTail`, keyed to the plan tool's own field names and requiring a
  leading comma (a bare `"key":` test would eat prose containing a colon).
  - **Also fixed, pre-existing and worse:** three JSON-shaped strippers ran OUTSIDE
    `mapOutsideFences`, so a legitimate ```json fence containing `message`/`planId`/`progress`
    had its body deleted. Surfaced by a test asserting such a fence survives — the file's own
    comment says this class of corruption "split a code block's body out of its box" and had
    supposedly been fixed once already. All JSON-shaped strippers are now inside the guard.
- **No hardcoded protected-path list any more** (`file-permission-scope.ts`). It named
  `package.json`, lockfiles, `.env*`, `.pem`/`.key`/`.cert`/`.p12`, `.github/workflows/**` —
  and `drizzle.config.ts`, `src/db/schema.ts`, `drizzle/**`, i.e. **Atlarix's own layout**
  hardcoded into every user's workspace ([[atlarix-no-hardcoding-telios]]). Any match forced a
  prompt on every edit AND set `canAlwaysAllow{File,Directory,Extension}: false`, so
  `.github/workflows/*.yml` was a dead end by construction — the reported bug.
  - It also contradicted this codebase's own position for READS
    (`security/env-secret-paths.ts`: "We do NOT block files by name … like opencode /
    Claude Code, the agent reads files inside the workspace freely"). The write side is now
    consistent.
  - Nothing traded away: the approval queue + inline diff still gates every write, containment
    and symlink escapes still refused, shell credential reads still hit the danger gate, and
    stored `always_deny` rows are still enforced. Projects wanting a path to always ask use
    `.atlarix/permissions.json` — configurable, not a constant.
  - The list had **zero test coverage** (removing it broke nothing), so
    `src/__tests__/file-permission-scope.test.ts` now covers it: 28 cases asserting every
    formerly-protected path can be always-allowed AND that stored decisions still apply.
  - Dead "Protected path — only Allow once or Deny" notice removed from
    `InlinePermissionApprovals`.
- **Secret handling: no change needed.** `AGENTS.md` "## Secret handling" already says to use a
  user-pasted key and then remind them to rotate it, not to persist secrets to tracked files,
  and never to echo a value. Guidance was already correct; only the *gate* was wrong.
- **The sub-agent panel no longer collapses mid-stream.** `allSettled` flips when the last
  sub-agent finishes — usually mid-turn — and the body (up to `min-h-[14rem]`) unmounted then,
  dropping document height and jumping content below under the auto-scroll. That was the
  reported "scratchy" rendering, and it was introduced earlier in this same release. Collapse
  is now gated on `!isStreaming`: same end state, no mid-stream reflow. Summaries stay.

### Second batch (same version)

- **Project instructions and memory are POINTED AT, not injected.** `.atlarix/atlarix.md` was
  being pasted into the system prompt **twice per turn** — once by `loadAtlarixMdSection` and
  again by `buildInstructionsFromLayers` in `system_prompt.ts` — and `memory.md` had both a
  pointer AND a full-body injection. Both bodies also went through `capInject`, a **silent**
  3000-char clamp, so a longer instructions file had its tail dropped and those rules never
  applied. `capInject` is deleted; the instructions pointer names the file, its size and its
  **section headings** (so a weak model can tell whether the rules apply) and says to
  `read_file` it before changing code. `global` + `project` layers are excluded from the base
  prompt concatenation (`POINTED_AT_LAYER_KEYS`).
- **New per-note agent memory** (`src/lib/agent-memory.ts`): `MEMORY.md` index + one note per
  fact under `~/.atlarix/projects/<slug>/memory/` — outside the repo, per-developer, never
  committed. Only the index reaches the prompt, so cost scales with the NUMBER of notes, not
  their size (measured: 20 notes × 2 KB → <1 KB of index). Isolation is structural — the slug
  is the workspace path plus a hash, because slugification alone collapses `/a/b-c` and
  `/a/b/c` onto one directory. `.atlarix/memory.md` migrates in on first sight
  (non-destructive, idempotent). Convention taught on demand via `skills/guides/memory.md`.
  `ATLARIX_MEMORY=off` removes the section entirely and **the headless runner sets it**, so
  benchmark runs carry no memory surface and one task's notes can't influence a later one.
- **Core wallet: a zero cost with real tokens now charges the reserve and warns loudly.**
  `computeCostUsd` returns `0` (not `null`) when a tier's pricing block exists but resolves to
  zero, so the `!= null` check never caught it and the generation was billed **0c, silently**.
  This is the reported "GLM isn't removing credits" symptom. Note the reserve is priced from
  the SAME catalog, so it reserves 0 too — the fallback lifts to `MIN_START_BALANCE_CENTS`.
  (`atlarix-proxy`, +4 tests.)
- **The account appears on first paint.** `restoreAuthSessionOnStartup` gained an
  `onStoredSession` callback that fires the moment the stored session is read, so the UI no
  longer waits on the refresh's 400 ms retry + `[0,1000,3000]` backoff + three round-trips
  (the new test suite shows the callback firing while the same run spends 4009 ms refreshing).
  Every v13.9 resilience property preserved.
- **`reset-all` re-opens the database** (`reinitializeDatabaseAfterReset`). It closed the handle,
  unlinked the file and returned while the app kept running, so every later query threw
  better-sqlite3's opaque "connection is not open". Also removes the `-wal`/`-shm` siblings,
  which SQLite could otherwise replay into the fresh file and resurrect deleted rows.
- **The sub-agent panel collapses once every agent settles**, with the cards one click away
  (and never re-collapsing under someone reading it). Chosen over the old TODO's
  weave-inline direction — reports are LLM-to-LLM output that shouldn't grow more prominent.
- **Tools page stops advertising things that don't exist:** "all four Core models / Core 1–4 /
  Core 3-4" (the lineup is config-driven and only some slots are mapped — the live list now
  renders from `useAtlarixCoreCatalog()`), approvals "queue in the right panel" (they moved
  inline in v14.15.0), plus "section-scoped Blueprint" (tool removed 2026-06) and "team
  features" (Team tier killed in the pricing reframe) in the page header.
- **Notifications: nothing to do** — turn-complete (`permissions/handlers.ts:342`) and
  automation results (`automations/notify.ts`) both already ship. Both deliberately suppress the
  OS notification while the app is FOCUSED, and both are gated on `notificationSound.enabled`,
  so turning the sound off also kills notifications. Open question, not a bug: whether that
  single switch should be split.


- **Provider dispatch keys on models.dev's `npm` field.** New
  `ipc/shared/provider-sdk-factories.ts` (5 factories over the bundled SDKs) replaces 11 identical
  `createOpenAICompatible({name, baseURL, apiKey})` switch cases; `get_model_client.ts` goes 24 cases
  → 13 (−101 lines) and every catalog provider is now connectable without an app release.
  `CLOUD_PROVIDERS` is no longer the registry — it's a presentation + **pin** overlay
  (curated name / key-console link / free-tier / gateway prefix, plus deliberate `apiBaseUrl` /
  `npm` pins).
  - **Pins that matter:** `minimax` stays OpenAI-compatible at `/v1` (the catalog moved it to
    `@ai-sdk/anthropic` at `/anthropic/v1` — a WIRE-FORMAT change, and MiniMax-M3 is the benchmarked
    model); `deepseek` keeps `/v1` (catalog omits it); `google` prefers
    `GOOGLE_GENERATIVE_AI_API_KEY` over the catalog's `env[0]`; `vertex` has no catalog row at all.
  - `envVarName` became an ordered **list** (`envVarNames`) — models.dev publishes several per
    provider and the old `env?.[0]` picked the one Google's SDK does not read.
  - Deleted the closed 21-entry provider tuple in `schemas.ts`. Its one consumer now filters the live
    provider list, which also fixes "no provider configured" for a user whose only key belonged to a
    catalog-only provider. `PROVIDERS_WITH_TOKEN_BUDGET` (19-entry allowlist) is likewise derived.
  - Guarded by `src/__tests__/provider-dispatch-pins.test.ts` (40 assertions) — provider dispatch
    fails SILENTLY, so the resolved URL + SDK for every formerly-hardcoded id is pinned to what
    shipped.

- **The plan gate no longer forces redo on work the model cannot do.**
  `plan-completion-gate.ts` counted any step that wasn't `done` as remaining, so a step needing the
  USER held the turn open and was re-nudged up to 6 consecutive / 12 per turn. New `external` step
  state (marker `@`, no migration — step state lives in the markdown): the gate now fires on
  `todo`/`in_progress` ONLY. `blocked` also releases the turn but does **not** license a success
  claim; `external` does, and requires a `reason` appended inline as `— needs you: …` (idempotent,
  stripped when the step moves off `external`) so it survives reload and shows in the card, the
  ledger and the panel. Guidance rides the `plan` tool description only — no new mode-header lines.
  - **Also fixed:** `markAllChecklistStepsDone` — the end-of-turn safety net — flipped `blocked`
    steps to `done` on any Build turn that wrote a file, converting "I'm stuck on this" into "done".
    Pre-dated `external`; it now closes actionable steps only.

- **Sub-agent results render as markdown.** All four sites (`SubAgentCard`, `SubAgentRunCard`,
  `HandoffResultCard`, and the expand panel) used raw `whitespace-pre-wrap`, so a markdown report
  arrived as one unstyled blob. `buildToolExpandView` had **no `task` branch at all** — the report
  fell through ~15 tool families to a ~300-char slice of the raw envelope. Added a `task` branch and
  a `markdown?: boolean` on the existing `text` view kind (fixes every text-shaped tool, not just
  `task`). Envelope unwrap extracted to renderer-safe `lib/chat/subagent-summary.ts`.

- **`AssistantMessageBody`'s two branches share one trailing component.** The five trailing concerns
  are emitted once by `MessageTrailing` instead of twice. This closed two MORE instances of the
  documented bug class: `postStreamSubagentItems` was interleaved-only, and the legacy branch built
  its trailing answer WITHOUT `citationSources` so inline `[^n]` markers never resolved there.
  `assistant-message-trailing-parity.test.tsx` renders one fixture through all three branch
  configurations and was verified to go RED when the legacy trailing is removed.

- **`preview_test` → `browser_test`.** It drives a browser tab; "preview" referred to the pane
  deleted in v14.15.0. The registry gained an `aliases` mechanism (separate map, so `getAll()` keeps
  listing each tool once) — the old name still resolves for persisted sessions and is advertised
  nowhere. Added the missing activity labels, which were hitting the "Runned <tool>" conjugation
  fallback.

- **Docs:** report-only prompt-surface audit
  (report deleted in v14.26.0, having been acted on); corrected the stale
  AI-SDK constraint in the dependency-triage entry (repo is on `ai@6` + v3 providers, not
  `anthropic@2.x` + `ai@5`); marked the DB shutdown-race entry fixed (it already was) and recorded
  the adjacent `reset-all` gap found while verifying it.

## ✅ SHIPPED in v14.22.0 — edits that don't corrupt files, and a harness that tells the truth

- **`edit_file` escape symmetry.** Whatever normalization located the match is now applied to the
  replacement, so an escape-normalized match no longer writes literal `\"` into a Go raw string.
- **Notices name the matching strategy** instead of always claiming indent/EOL tolerance —
  `match.strategy` was returned and discarded, and the wrong explanation cost ~25 turns of
  misdirected debugging.
- **A fuzzy match no longer auto-executes.** A guessed edit reaches the human diff.
- **Path aliases absorbed in the guard** (`file_path`/`filePath`/`filename`/`file`), and the prompt
  clause that fought the training prior is deleted.
- **Plan JSON no longer leaks into replies**; `plan` gained a real card (title, status, progress,
  checklist).
- **Prompt restructure.** Guidance relocated onto tools (browser, git policy, web research), mode
  rules cut from four live copies to two, six prompt/harness contradictions fixed, mode labels
  derived from the registry. Build-mode header −28.9% with no rule removed.
- **Fixes:** paste-only first message now yields a session title; a restored workspace folder
  recovers without an app restart; a finished background job stops asking to be re-checked;
  `run_command` no longer says "Successfully executed" beside a non-zero exit;
  `BrowserWindow.getFocusedWindow` stubbed (a real headless gap).
- **New standing guard:** no mode's prompt may name a tool that mode cannot call — it caught three
  of the six contradictions above.

## ~~🔜 NEXT SESSION — Agent-visible automations~~ — **SHIPPED v14.27.0**

Built to the owner-approved shape, with two decisions taken during the work: **all modes** may
create/update/delete (the approval gate is the control, so a read-only mode listing and
recommending is the point), and **`notifyAgent` is required with no default** — the owner's
design, and better than this entry's original "default to surfacing runs on request plus
per-automation opt-in for push", because a default makes the spend decision silently on behalf
of whoever set the automation up.

Everything this entry said to PRESERVE was preserved: nothing is killed, there is no lifetime
cap, wake-ups stay re-armable, `MIN_POLL_INTERVAL_MINUTES` is untouched, and there is no
`allow_stalled` for automations.

## ⏳ Open / deferred

### From v14.22.0

- **Packaging registry (one line, deliberately deferred).** `runNpmInstall`
  (`forge.config.ts:20-35`) spawns npm with no `--registry`, in `buildPath` outside the project,
  so a custom global registry wins and `packageAfterPrune` dies with `E401`. Until it lands,
  `npm run package` needs `npm_config_registry=https://registry.npmjs.org/`. Held pending the
  owner's account migration.
- ~~**Report-only audit sweep**~~ — **DONE in v14.23.0**; the report was acted on and deleted in
  v14.26.0.
  - ~~"Named sub-agents are under-prompted"~~ — **STALE, corrected 2026-08-05.** The entry cited
    `EXPLORER_PROMPT` at 338 chars and `implementer` at 108. Measured today they are **909 / 819 / 864**
    (explorer / architect / implementer), and `IMPLEMENTER_PROMPT` now explains the proposal mechanism
    in full — the specific gap the audit named ("never reads the 44 lines of `subagent-writer.md`
    explaining that its edits become proposals") no longer exists.
  - What the entry was *right* about is drift risk from two near-verbatim sources, and that is now
    handled structurally: `shared-fragments.ts` holds the text that must read identically, and all
    three `BUILTIN_AGENTS` prompts plus both sub-agent skills render from it
    (`{{REUSE_FIRST_LADDER}}`, `{{OUTSIDE_WORKSPACE_PATHS}}`, `{{OUTSIDE_WORKSPACE_WRITES}}`), with
    tests asserting each fragment reaches every consumer that should have it — and only those.
  (Compaction prompt: 2,298 B vs opencode's 823 B — measured, no change recommended, see the doc.
  `<system-reminder>` sites: **22**, not 16.)
- ~~**`preview_test` is misnamed.**~~ — **DONE in v14.23.0**: renamed to `browser_test`. The registry
  gained an `aliases` mechanism (separate map from `tools`, so `getAll()` still lists each tool once)
  so the old name resolves for persisted sessions while being advertised nowhere — per the v14.22.0
  rule, absorb the alias, don't prompt against it. Covered by
  `src/__tests__/tool-name-aliases.test.ts`.

### ~~🔀 `AssistantMessageBody` two-branch duplication~~ — RESOLVED v14.23.0

`AssistantMessageBody.tsx` returns from two structurally parallel branches — interleaved
(`useInterleavedTimeline = contentDrivenThread || isStructured`) and legacy — and features get wired
into one but not the other. **Two bugs from this class shipped in a single batch:**

- The web-search **citation strip** was mounted only in the legacy branch, so it never rendered for
  the turns that actually had citations (every search emits a tool tag → interleaved branch).
- The **sub-agent round panel** was the mirror image: rendered only in the interleaved branch, so a
  round on a plain-prose message rendered nowhere. Worse, `excludeSubagentRound` — driven by
  `inlineSubagentRound`, which `resolveLiveSubagentRound` makes non-null post-stream by reading the
  COMPLETED thread — pulled the round out of the tail too, closing the one indirect route the legacy
  branch had (via `StreamThreadItemView`'s `case "subagent_round"`). Git history confirms the legacy
  branch NEVER had its own panel render; it was an omission from the split, not a regression.

**RESOLVED in v14.23.0.** The five trailing concerns are emitted once by a shared `MessageTrailing`
component rendered after each branch's middle. Collapsing them surfaced **two more** instances of
the same class, both now fixed: `postStreamSubagentItems` rendered only in the interleaved branch,
and the legacy branch built its trailing answer WITHOUT `citationSources`, so inline `[^n]` markers
never resolved on that path.

The sub-agent round **panel** deliberately stays per-branch — its position is genuinely different
(woven mid-timeline vs. after the parts), so sharing it would move it. That residual risk is covered
by `src/__tests__/renderer/assistant-message-trailing-parity.test.tsx`, which renders one fixture
through all three branch configurations (legacy, `isStructured`, `contentDrivenThread`) and asserts
the trailing elements appear exactly once in each. It was verified to fail — on the legacy branch
only, for the right reason — when the shared trailing is removed.

### Other

- **Sub-agent results still don't *continue* in the timeline** — STILL OPEN, and deliberately not
  attempted in the 2026-08-05 batch. The painful half is gone: results RENDER properly (markdown, with
  a real `task` tool card) instead of as a raw envelope slice. What remains is purely placement — they
  live inside the round-panel cards behind the expand affordance rather than resolving inline where
  they were spawned. Direction unchanged: weave settled `subagent` items via `weaveIpcItemsIntoParts`
  (`WEAVABLE_KINDS` currently excludes `subagent_round` — "panels/rounds always stay tail") and
  collapse the panel once all agents settle, so the same agent isn't rendered twice.
  - **Why it was skipped:** its entire value is visual placement, and it sits in the most
    reflow-sensitive code in the renderer — `AssistantMessageBody`'s sticky-agents / seam-offset /
    synthesized-round interaction, which has already produced one "scratchy rendering" regression from
    the panel unmounting mid-stream (fixed in v14.23.0 by gating collapse on `!isStreaming`). The
    v14.23.0 parity test guards trailing-element *duplication*; nothing guards "does it look right".
    Land it in a session that starts with the packaged app open, so each step is seen rather than
    inferred.
- ~~agent-evals flakiness~~ — **FIXED** (see the in-progress section above).

- ~~**Linux authoritative denied-path supervisor (Phase 2)**~~ — **DELETED 2026-08-05, not shipped.**
  The ptrace + seccomp(`SECCOMP_RET_TRACE`) supervisor was 258 of the crate's 429 lines, feature-gated
  off, never consumed (`--deny-report` appeared nowhere in `src/`), and **never compiled by CI**
  (`release.yml` builds default features only) — so the highest-risk-per-line code in the repo was the
  only code no automated process type-checked. It also improved DIAGNOSTICS, not security: Landlock was
  and remains the boundary.
  - Owner's call after weighing it: a kernel oracle would have made the message more precise on **one**
    OS, so it was dropped in favour of making the message **exist on all three**. macOS has no clean
    route at all (custom `sandbox-exec` profiles do not log denials; Endpoint Security needs an
    Apple-granted entitlement; `DYLD_INSERT_LIBRARIES` is stripped for the platform binaries we invoke)
    and Windows needs elevation or a signed driver — so per-OS parity was never reachable anyway.
  - **Shipped instead:** `src/lib/sandbox/sandbox-failure-context.ts`. When a sandboxed command fails and
    no path can be scraped, the model is told the sandbox was applied, whether it was read-only, the
    writable roots and the cwd — **facts only, no diagnosis.** An intermediate version tried to classify
    failures (permission-signal regexes, a vendor blocklist, a tool→cache-path table) and was deleted for
    guessing: the command's output is already in the error, and the model reads it better than a regex.
  - Git history keeps the supervisor if a real report ever shows tools swallowing paths — at which point
    we will know *which* tools, and the scraper may just need another pattern.

## 🔍 Hardcoding sweep (2026-08-05) — findings

Audit of every uppercase constant list in `src/lib` + `src/ipc` after two hardcoded lists were
deleted this batch. **The test that matters is what happens when the list is INCOMPLETE.**

**Fixed:**
- **4 of 26 live tools had no activity label** (`compress_context`, `list_attachments`,
  `read_attachment`, `schedule_wakeup`) and fell through to the generic `Running <tool>…`
  template — the documented "Runned &lt;tool&gt;" trap. Labels added, and
  `tool-activity-labels-coverage.test.ts` now fails with the offending tool's name so the
  requirement lives in the suite instead of a note. Expand views were already fine (`text`).

### ~~🎯 delete the file-discovery exclusion apparatus~~ — **SHIPPED v14.26.0**

Done as specified, with one correction found while implementing. The TODO's plan said
`--iglob "*q*"` was "an exact equivalent" of the composer's `.toLowerCase().includes(q)`
filter. **It is not** — a ripgrep glob with no `/` matches the BASENAME only. Measured on
this repo for query `chat`: **60 hits vs 209**, with `src/components/chat/Composer.tsx` in
the second set and not the first. Shipping it would have silently stopped `@`-mention
finding anything under a matching DIRECTORY. Enumeration is 15-20 ms here, so ripgrep
enumerates and Node filters — substring semantics byte-identical, truncation still fixed,
payload still just the matches.

Also found by the new tests, not by reading: **ripgrep's parallel walkers do not emit a
stable order**, so two runs on an unchanged tree come back shuffled. Invisible while the
list was built once and cached 5 minutes; with a query per keystroke it reshuffled the `@`
menu mid-type. The list is sorted and a test pins it.

`workspace-discovery.ts`, `file_utils.ts` (all three exports), `context_paths_utils.ts` and
the dead `workspaceDiscoveryHints` / `fileDiscoveryWarnings` fields went too. Net
**+430/-2,220**.

**Checked and CORRECT as-is — do not "fix" these.** None needs work next session; the
distinguishing test in every case is *what happens when the list is incomplete*:
- **`defaultWritablePaths`** (`lib/sandbox/wrap-command.ts`) — a curated ~18-entry home-cache
  list beside a dynamic env-var half. It is a *write* allowlist: an incomplete entry fails
  CLOSED (a denial the escalation flow then offers to grant). Making it dynamic — probing
  `$HOME` for dot-dirs — would WIDEN the sandbox. Curated is the correct posture.
- **`DANGEROUS_PATTERNS`** / **`SYSTEM_SCOPE_PATTERNS`** — UX gates, not boundaries.
  system-scope says so outright: "best-effort — the sandbox catches anything not listed here."
- **`DENIAL_PATTERNS`** — extracts a path from tool prose (a positive capability); a miss now
  degrades into `sandbox-failure-context.ts` rather than into silence.
- **Browser error capture** (`lib/browser/error-hook.ts`) — filters on the browser's own
  console `level` and HTTP status ≥ 400, never on curated message strings. Already derived.
- **`file-permission-scope.ts`** — the v14.23.0 protected-path deletion has NOT crept back; what
  remains is a set of Atlarix's own operation names, which we control.
- **`models_dev.ts` / provider dispatch** — de-hardcoded in v14.23.0; only the documented
  deliberate pins remain.
- Browser `KEY_ALIASES` / `MODIFIER_TOKENS` — a closed set from the DOM spec, not an ecosystem
  that grows.
- ~~`ALWAYS_EXCLUDE`'s non-CDK entries (`node_modules`, `dist`, `target`, `vendor`, `.venv`…)~~
  — **withdrawn.** First written up as a defensible "common build-output names" list. The
  measurement above supersedes that: `.gitignore` already excludes all of them, so the whole
  list goes with the fallback strategies. Only `.git` survives, and only because `--hidden`
  makes ripgrep list it.

## 🔜 Blocked on the owner — NOT active work

Kept for the record; none of these can be picked up in a coding session.

- **Windows code-signing / cert** — C6 auto-update signing + native-sandbox CI (release-infra, no cert).
  OAuth `state` nonce / PKCE stays **not doing** (attempted v14.12.0, broke sign-in, reverted; the
  flow-in-progress gate stays).
- **Billing A/B (owner-side):** confirm OpenRouter `usage.cost` includes the ~$0.005 search fee so the
  wallet debit = `ceil(cost × 1.4)`; else add a proxy surcharge in `atlarix-proxy/src/server.ts`.
- **Runtime-verify voice mic + DB shutdown-race** on a packaged build (voice confirmed working by owner
  2026-07-14; shutdown-guard committed, not stress-verified).
- ~~**Per-Core-model web-search check**~~ — **DELETED 2026-08-05.** There is no web-search API to
  verify against, so the entry described work that cannot exist.
- ~~**Mobile emulator toolset**~~ — **WITHDRAWN 2026-08-05 (owner).** The `mobile_*` family would
  have been ~6 tools of standing description cost wrapping binaries the agent can already drive:
  `adb` and `xcrun simctl` are CLIs, and `run_command` calls them today. The "hand this step to the
  user" rung the section implied already exists as `plan.ts`'s `external` state with its required
  `— needs you: …` reason. Nothing to build; the capability is present.
- **Dependency deprecation triage** is its own release; see its section below and treat it as
  roadmap, not queue.

## 🔎 Recorded in v14.26.0 — not scheduled

- **The Dyad-era hosted-engine subsystem is orthogonal to the current architecture, and it is an
  OWNER decision whether it is still a product.** Traced while unthreading the always-empty `files`
  array: `get_model_client.ts:170-221` branches to `createAtlarixEngine` at
  `https://engine.atlarix.dev/v1` whenever `settings.enableAtlarixPro` is set — and that toggle is
  still live user-facing UI at `ProviderSettingsPage.tsx:414`. Hanging off it:
  `llm_engine_provider.ts`, lazy edits, smart-files context, deep context, and the git-history half
  of `versioned_codebase_context.ts` (which is why that file was KEPT — its second loop does real
  work, reading paths named in past assistant turns back out of git at the commit they recorded).
  None of this relates to Core-as-prepaid-wallet-through-the-proxy. Not a coding-session call.
- **`selectedComponents` still flows renderer → IPC → `ChatStreamParams` and is read by nothing on
  the main side.** Same Dyad-era shape; unpicking it crosses into the renderer and belongs with the
  decision above.
- ~~**The unit vitest projects had no explicit `testTimeout`**~~ — **FIXED 2026-08-05.** They
  inherited vitest's 5,000 ms default while the slowest real `node` test (`subagent-proposals`)
  runs 2,592 ms idle. Two full-suite runs sharing the machine with a `tsc --noEmit` produced 4
  and then 8 "Test timed out in 5000ms" failures across `spawn-task`, `subagent-*`,
  `cancel-preserves-revert`, `stop-and-revert-integrity` and `active-skill-truncation` — all of
  which pass in isolation. `node` and `renderer` now set 30 s explicitly
  (`UNIT_TEST_TIMEOUT_MS`); `agent-evals` keeps its own 90 s. **Verified by reproducing the
  failure condition:** the same suite run against two concurrent `tsc` processes now passes
  309/310 with zero 5,000 ms timeouts.

## 🔐 Security follow-ups (from `docs/SECURITY_REVIEW_v14.8.12.md`, owner-triaged)

Fixed by v14.8.13: compound-command danger gate, exfil taxonomy, deep-link auth-CSRF +
pro-return confirmation, MCP consent gate, `.atlarix` authority-file approval, MCP
description wrapping + OAuth-URL validation, the **universal write-confining sandbox**
(Win AppContainer + Linux Landlock bundled), and the **system-scope approval gate** (which
also closed M1 — cwd `allowedRoots` widening is now gated on interactive approval).
**Deferred (tracked):**

- **C6 — auto-update signature verification (Windows/Linux).** Highest blast radius, but
  release-infra (code-signing certs + `app-update.yml` for NsisUpdater; out-of-band
  signature for AppImage), not app code. Owner chose NOT to gate the public release on it.
  (Windows helper sign step is already wired — set the cert secret to enable.)
- **Native sandbox validation in CI.** The Windows/Linux helpers can't compile on macOS; they
  build (non-blocking) in the first Windows/Linux CI job — watch those `cargo build` steps and
  budget one small fix-up iteration if the Linux `landlock` 0.4 API drifted.
- **Unattended read-only allowlist-flip** (positive allowlist for Automation runs) — the
  denylist taxonomy is done; the flip needs per-automation design to not break legit builds/tests.
- **Round-tripped auth `state` nonce** — needs confirming the Supabase redirect-URL
  allowlist permits a query param (current gate = flow-must-be-in-progress).
- Sandbox **read**-confinement, model-context **secret redaction**, **egress** gating, and the
  remaining Medium items (env-var key inheritance, secret-basename list, cross-workspace file
  scope, plaintext-keychain fallback).

## Open follow-ups

- ~~**DB shutdown race — `TypeError: The database connection is not open`**~~ — **ALREADY FIXED**
  (verified v14.23.0, entry was stale). The `closing` guard exists and is wired: `beginDatabaseClosing()`
  / `isDatabaseClosing()` / `DatabaseClosingError` in `db/index.ts:690-736`, the `db` Proxy
  short-circuits on `_dbClosing`, `main.ts:1793` sets it before the `before-quit` chain, and
  `src/__tests__/db-closing-guard.test.ts` covers it.
  - ~~**Adjacent: `reset-all` leaves a closed DB handle**~~ — **ALSO ALREADY FIXED; this entry was
    stale.** It shipped in v14.23.0 as `reinitializeDatabaseAfterReset()` (`db/index.ts:706`), called
    from `app_handlers.ts:1219`, which is exactly the "re-initialize in place" option the entry was
    asking for a decision on. Struck 2026-08-05.
- **DONE in v14.8.12:** approval-wait audit (MCP auth waits now indefinite + Stop-cancellable),
  Shift+Tab global, attachment vision cold-cache, notification sound. **B4 (bg-command "done" while
  running)** resolved as model behavior — the harness DOES re-inject the exit result via auto-wake
  (`recordBackgroundCommandResult`); mitigated by the new prompt lines (ground-claims / finish-the-turn).
- **CONSIDER (evaluated → CLOSED): `browser-use`.** Not adopted — Python/Playwright (bad Electron fit),
  it's its own agent loop, and its one good idea (stable element refs) Atlarix already has via
  `browser_inspect` snapshot `ref`s. No capability gap. [[atlarix-preview-webcontentsview]]
- Small / carried: `.gitignore`-render profiler (v14.8.10 §3.4); Atlarix GitHub account for contributor
  credit (owner action; code done); user-message multimodal parts for HISTORICAL turns (current/edited
  turns embed since v14.8.11; history round-trips via read_attachment).
- **Dependency deprecation triage (own session).** Scoped, not a blanket "zero warnings" chase.
  Constraints: the AI SDK stack must stay on MATCHING majors — currently **`ai@6` + v3-spec
  providers** (`@ai-sdk/anthropic@3.x`, openai 3.x, openai-compatible 2.x), since v13.3
  [[atlarix-ai-sdk-version-trap]]. *(This line previously said anthropic must stay 2.x with `ai@5`,
  which described the pre-v13.3 state and inverted the actual constraint.)* Also: zod mid-v4;
  3 patch-package patches; ABI-pinned better-sqlite3/node-pty/keytar. Worklist = `npm outdated`
  (direct) + `npm audit` + own deprecated-API usage + CI action EOLs; leave pinned/transitive with
  a note.

## 🔭 Long-term / far-off (not soon)

- **Collaborative agent (the "team + @atlarix" direction).** NOT a Slack/Discord clone — real-time
  chat + calls is a money pit and teams already have those. Two pieces instead: (a) **`@atlarix`
  bots inside the tools teams already use** — Slack / Discord / GitHub issues — extending the existing
  `@atlarix review` GitHub bot: mention it, it picks up the task, works in a real Atlarix workspace,
  and posts the PR/result back (near-zero switching cost, big reach; how Devin / Copilot-in-Slack win).
  (b) A **shared, observable agent session** — a "war room" where several teammates watch one Atlarix
  run live, drop steering comments, approve actions, and hand off — tied to the Workforce tier. The
  chat shell is not the differentiator; the shared *agent* session is. Far-off; capture, don't build yet.

> Open work + the current release only. **Full shipped-version history lives in
> [`docs/CHANGELOG.md`](./CHANGELOG.md)** (and `docs/CHANGELOG_PREVIOUS.md`).
