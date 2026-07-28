# Atlarix TODO

**Current Version:** v14.22.0 (2026-07-28) — `edit_file` no longer writes escapes into your files,
and the harness stops describing a failure as a success. Guidance moved onto the tools that own it
(Build-mode header −28.9%), mode rules cut from four live copies to two, and six prompt/harness
contradictions fixed.
**Last Updated:** 2026-07-28

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

## 🔭 v14.19+ — Mobile emulator toolset

**`mobile_*` tools, mirroring the browser family** — a device `target`, and **a11y-tree-first** so
it stays token-cheap (screenshots a last resort, exactly as in `BROWSER_NOTE`). Gives Atlarix real
end-to-end mobile UI testing.

- **Android — raw `adb`**, no dependency beyond the user's own SDK. `emulator -list-avds` /
  `emulator -avd <name>` to boot; `adb shell input tap|swipe|text|keyevent` to interact;
  **`adb exec-out uiautomator dump`** for the a11y tree with resource-ids and bounds (the direct
  analogue of `browser_inspect`, and what keeps this cheap); `adb exec-out screencap -p`,
  `adb install`, `adb logcat`, deep links via `adb shell am start -a android.intent.action.VIEW -d`.
- **iOS (macOS only) — `xcrun simctl` + `idb`.** simctl covers lifecycle (list/boot/install/launch/
  `io booted screenshot`/openurl) but has **no touch input**; `idb ui tap|swipe|text|describe-all`
  supplies taps and the a11y tree. **Verify idb's maintenance status before committing to it** —
  Appium + WebDriverAgent is the fallback if it has gone stale (heavier: Node server + WDA signing).
- Considered and set aside: Maestro (single binary, both platforms, but less low-level control) and
  Appium as the primary driver (one driver for both, at a much heavier install cost for users).

## ⏳ Open / deferred

### From v14.22.0

- **Packaging registry (one line, deliberately deferred).** `runNpmInstall`
  (`forge.config.ts:20-35`) spawns npm with no `--registry`, in `buildPath` outside the project,
  so a custom global registry wins and `packageAfterPrune` dies with `E401`. Until it lands,
  `npm run package` needs `npm_config_registry=https://registry.npmjs.org/`. Held pending the
  owner's account migration.
- **Report-only audit sweep** (from the identity-surface work): the three `builtin-agents.ts`
  prompts vs `src/skills/subagents/*.md` for overlap; `context_compaction_prompt.ts` against
  opencode's 823-byte equivalent; and the 16 `<system-reminder>` injection sites.
- **`preview_test` is misnamed.** It drives a browser tab, but "preview" refers to the Preview
  pane deleted in v14.15.0 — which is why it reads as a tool that shouldn't exist. A rename
  touches the golden toolset eval, the completion gate's advice string, and persisted sessions,
  so it wants its own change.

### 🔀 `AssistantMessageBody` two-branch duplication (own session)

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

Both are fixed, but the shape guarantees recurrence: any future "render X at the tail" lands in one
branch and silently misses the other, and there's no test that asserts parity.

**Direction:** collapse the two returns into one. The branches differ mainly in how they order
content (woven timeline vs. parts list + tail); the trailing concerns — citation strip, sub-agent
panel, permission approvals, trailing answer — are identical and should be emitted once, after the
branch-specific middle. Failing that, a parity test that renders the same fixture through both
branches and asserts the same trailing elements appear.

### Other

- **Sub-agent results still don't *continue* in the timeline.** The duplicate tail rows are fixed
  (see below), but results still live inside the round-panel cards behind the expand affordance
  rather than resolving inline where they were spawned. Owner chose the minimal fix for now;
  revisiting means weaving settled `subagent` items via `weaveIpcItemsIntoParts` and collapsing the
  panel once all agents settle, so the same agent isn't rendered twice.
- ~~agent-evals flakiness~~ — **FIXED** (see the in-progress section above).

- **Linux authoritative denied-path supervisor — Phase 2 (WRITTEN, compiles, feature-gated OFF; pending dev validation).**
  `native/atlarix-sandbox-linux` gained a ptrace + seccomp(`SECCOMP_RET_TRACE`) supervisor that records
  write syscalls to paths outside the writable roots into a `--deny-report` file — for tools that swallow
  the path. **Feature-gated OFF** (`trace-supervisor`; optional nix/libc/seccompiler deps) + runtime-gated
  (`ATLARIX_SANDBOX_TRACE=1`) + graceful fallback, so the default build is unchanged and the sandbox can
  never break. `cargo check --target {x86_64,aarch64}-unknown-linux-gnu` clean with/without the feature.
  - **REMAINING:** (1) real-Linux dev-hardware runtime validation (does it capture denials, trace forked
    children, propagate exit codes?) — build `--features trace-supervisor` + `ATLARIX_SANDBOX_TRACE=1`;
    (2) production report-file threading (`wrap-command.ts` passes `--deny-report` + the interceptor
    prefers the report over stderr-parse) — land with the validation; (3) flip the feature on in CI once
    green. Windows stays stderr-parse (ETW needs elevation).

## ⏳ TBD / Next (fast-follow 14.14.1)

- **Owner-side verification (from the v14.14.0 web-search work):** (1) billing A/B — confirm OpenRouter
  `usage.cost` includes the ~$0.005 search fee so the wallet debit = `ceil(cost × 1.4)` (else add a proxy
  surcharge in `atlarix-proxy/src/server.ts`); (2) per-Core-model check that DeepSeek/Qwen/Kimi/MiniMax
  reliably emit `openrouter:web_search` — set `webSearch:false` in `core-models.json` for any that don't.


## 🔜 Deferred / next

- **Windows code-signing / cert** — C6 auto-update signing + native-sandbox CI remain open (release-infra,
  no cert). OAuth `state` nonce / PKCE stays **not doing** (attempted v14.12.0, broke sign-in, reverted; the
  flow-in-progress gate stays).
- **Runtime-verify voice mic + DB shutdown-race** on a packaged build (voice confirmed working by owner
  2026-07-14; shutdown-guard committed, not stress-verified).

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

- **DB shutdown race — `TypeError: The database connection is not open`** (Sentry, seen on 14.9.1,
  still present in 14.10.0; **benign** — `handled`, fires only during app quit, no in-session impact,
  worst case one dropped pending write). Cause: the SQLite handle is closed (`db/index.ts:65`
  `sqlite.close()` / `app_handlers.ts:1185` `db.$client.close()`) while `main.ts:1437` `before-quit`'s
  async flush/session chain still has a drizzle query in flight → straggler `.prepare()` throws. Fix
  (target 14.10.1): a `closing`/`isClosed` guard so `db` calls short-circuit once shutdown starts
  (robust vs. `void`-ed late writers), or reorder to `await` the flush chain before `db.$client.close()`.
  ~15-min change + a test; own fresh plan-mode session.
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
- **Dependency deprecation triage (own session).** Scoped, not a blanket "zero warnings" chase
  (@ai-sdk/anthropic MUST stay 2.x w/ ai@5 [[atlarix-ai-sdk-version-trap]]; zod mid-v4; 3 patch-package
  patches; ABI-pinned better-sqlite3/node-pty/keytar). Worklist = `npm outdated` (direct) + `npm audit`
  + own deprecated-API usage + CI action EOLs; leave pinned/transitive with a note.

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
