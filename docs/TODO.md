# Atlarix TODO

**Current Version:** v14.23.0 (2026-07-30) — providers come off the hardcode, the plan
gate stops fighting the model, and sub-agent results render like the rest of chat.
**Last Updated:** 2026-07-30

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
  ([`PROMPT_SURFACE_AUDIT_v14.23.0.md`](./PROMPT_SURFACE_AUDIT_v14.23.0.md)); corrected the stale
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
- ~~**Report-only audit sweep**~~ — **DONE in v14.23.0**, written up in
  [`docs/PROMPT_SURFACE_AUDIT_v14.23.0.md`](./PROMPT_SURFACE_AUDIT_v14.23.0.md). One finding worth
  acting on, in its own change: **named sub-agents are under-prompted.**
  `task({subagent_type:"explorer"})` gets `EXPLORER_PROMPT` (338 chars) while the un-named
  `task({description})` gets `skills/subagents/subagent.md` (~1.1 KB) — and the mode prompts steer
  callers to the *named* form. Worst case is `implementer` (108 chars), which never reads the 44
  lines of `subagent-writer.md` explaining that its edits become proposals rather than disk writes.
  The two sources are mutually exclusive (no duplicated context) but their opening paragraphs are
  near-verbatim, so they will drift. Direction: point `BUILTIN_AGENTS[*].systemPrompt` at the same
  skill markdown and keep the constants for the role-specific delta only.
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

- **Sub-agent results still don't *continue* in the timeline** — STILL OPEN after v14.23.0, but the
  painful half is gone: results now RENDER properly (markdown, with a real `task` tool card) instead
  of as a raw envelope slice. What remains is purely placement — they live inside the round-panel
  cards behind the expand affordance rather than resolving inline where they were spawned. Revisiting
  means weaving settled `subagent` items via `weaveIpcItemsIntoParts` and collapsing the panel once
  all agents settle, so the same agent isn't rendered twice. Deferred deliberately: the parity test
  added in v14.23.0 now makes that change safe to attempt, which it wasn't before.
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

- ~~**DB shutdown race — `TypeError: The database connection is not open`**~~ — **ALREADY FIXED**
  (verified v14.23.0, entry was stale). The `closing` guard exists and is wired: `beginDatabaseClosing()`
  / `isDatabaseClosing()` / `DatabaseClosingError` in `db/index.ts:690-736`, the `db` Proxy
  short-circuits on `_dbClosing`, `main.ts:1793` sets it before the `before-quit` chain, and
  `src/__tests__/db-closing-guard.test.ts` covers it.
  - **Adjacent, still open (found while verifying, NOT the same bug):** the `reset-all` handler
    (`app_handlers.ts:1202`) calls `db.$client.close()` and unlinks the file WITHOUT setting the
    closing flag or clearing `_db`, then returns while the app keeps running — so any later DB access
    hits a closed handle and throws the opaque better-sqlite3 error again. Not fixed here because
    `_dbClosing` is one-way: setting it would permanently brick a session that is expected to keep
    working after a reset. Wants a decision on whether reset-all should force a relaunch (then set the
    flag) or re-initialize the DB in place (then clear `_db` and re-run `initializeDatabase`).
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
