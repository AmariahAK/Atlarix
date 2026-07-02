# Atlarix Changelog

## [14.8.9] (2026-07-02) — Open-weight harness hardening: task-state, edit fidelity, and a sharper agent

> The first tagged release since 14.8.0 — it carries a run of harness work (14.8.5→14.8.9) focused on
> making open-weight models (DeepSeek, Qwen, Kimi, MiniMax) behave like they know your codebase.
> Headlines: the agent now **tracks its plan as a live ledger and drives it to completion** instead of
> stalling mid-task; **`edit_file` is more robust** (write + self-healing replace, with over-escaped
> content auto-repaired); **cancel is instant** (it kills the sub-agent git work that used to spike CPU);
> harness nudges no longer masquerade as your messages; and the agent's built-in "sight" of a web page
> is **cheaper and no longer cries wolf** about decorative-layer overlaps. tsc + oxlint + knip clean;
> full vitest green (**1525 tests**); verified in a packaged build.

### Added

- **Live task ledger + continue-until-done.** The session plan is re-surfaced compactly every turn and
  the agent keeps exactly one step in-progress, verifying each step before advancing — a Build turn now
  drives the whole plan to completion (bounded), while still stopping for a decision, a manual test, or
  background work. (`src/lib/tasks/plan-completion-gate.ts`, `plan-checklist.ts`, `run-agent-turn.ts`.)
- **Out-of-band `<system-reminder>` framing.** Harness-injected nudges, resumes, and results are now
  tagged as out-of-band so the model never mistakes a harness continuation for a fresh user request.
  (`src/lib/streaming/system-reminder.ts`.)

### Changed

- **`edit_file` collapsed to `write` + `replace`** with an opencode-style self-healing match cascade;
  over-escaped content (literal `\n`) is auto-repaired when unambiguous and hard-blocked otherwise.
  (`src/lib/tools/edit.ts`, `edit-match.ts`, `edit-escape.ts`.)
- **Prompt + tool-guidance refinement.** De-duplicated triplicated mode guidance, moved decisive
  "when to use" steers onto the tool schemas (so `browser_inspect` no longer over-reaches for a
  screenshot when a cheap text report answers "what's on the page"), and trimmed contradictions/stale
  copy. The work-mode picker now shows only the five modes (sub-agents are `task` targets, not modes).
- **Token-efficient visual "sight" is more accurate.** The layout-defect check now excludes decorative/
  positioned layers, so live sites stop reporting false "layout bugs." (`src/lib/browser/visual-lint.ts`.)

### Fixed

- **Cancel is immediate.** Stopping a turn now kills the sub-agent git/worktree children that used to
  keep running and spike CPU; teardown is off the hot path. (`src/lib/tools/spawn-task.ts`,
  `src/lib/agents/subagent-worktree.ts`.)
- **Actionable tool errors everywhere.** Every tool failure now returns a concrete next step; bare
  `{error}` returns are normalized so a failure never masquerades as success. (`src/lib/tools/registry.ts`.)

## [14.8.0] (2026-06-30) — Headless preview testing, rock-steady streaming, smarter stalls

> A reliability + capability pass. Atlarix can now **verify the web app it builds with zero human clicking** — a new headless preview test drives the live app and a completion gate blocks "done" while the app throws runtime errors. On the reliability side: the chat **no longer jumps back** to an earlier spot mid/end-of-stream; reasoning-model **stalls now resume from where they left off** instead of restarting and redoing every tool call; weak/local text-tool models settle cleanly instead of re-running a prior tool call every round; and the redundant rolling session-memory summary is **gone** (model context defers entirely to the full conversation + token-overflow compaction, the way opencode/Claude Code do it). tsc (main + app + tests) + oxlint + knip clean; full vitest green (**1441 tests**); verified in a packaged build.

### Added

- **Headless `preview_test` tool.** One call runs a scripted, non-interactive navigate→click/fill→waitFor→assert sequence against the live preview and returns a single structured pass/fail. It reuses the offscreen preview `WebContentsView` (so it works in the packaged app, where Playwright is stripped) and is framework-agnostic — it drives the rendered DOM. Build/Debug only. (`src/lib/tools/browser.ts`.)
- **Preview runtime-error completion gate.** A turn can no longer end "done" while the live preview is white-screening or 500ing — error-level console output, failed loads, a dead renderer, and 4xx/5xx network responses block completion. Dev-mode `console.warn`/hydration warnings are filtered out so the gate never traps on benign noise. (`src/lib/agent/preview-verify.ts`, `src/ipc/utils/browser_view_manager.ts`.)

### Changed

- **Idle-stall budget raised 300s → 600s** to give open-weight reasoning models (DeepSeek V4 Pro, Qwen, Kimi, MiniMax) ample headroom for silent mid-stream think-pauses. (`src/ipc/utils/stream_chunk_tags.ts`.)
- **Stall recovery now continues from the partial round instead of restarting it.** Completed steps are captured via the AI SDK `onAbort` hook and replayed, so a genuine stall no longer re-runs every tool call already executed this turn (the old "redoing the whole task" symptom). Unified with the existing truncation-continuation path. (`src/ipc/handlers/chat_stream_handlers.ts`, `src/lib/agent/run-agent-turn.ts`.)
- **Removed the redundant rolling 7-exchange session-memory summary.** It was a lossy, char-truncated second copy of the recent conversation that competed with the full native history and made the model behave as if only ~7 exchanges existed. Model context now defers entirely to the full history + token-overflow compaction. (`src/lib/session-memory.ts` deleted; `ContextAssembler.ts` plumbing cleaned.)

### Fixed

- **The streaming chat no longer jumps back** to an earlier section mid- or end-of-stream. Root cause was dueling scroll controllers (the browser's CSS scroll-anchoring fighting the manual stick-to-bottom); fixed with dynamic `overflow-anchor` (none while following, auto when reading history), a same-frame `ResizeObserver` re-pin, and a scoped end-of-stream fallback that closes the completion reflow-flash. (`src/hooks/useStickToBottom.ts`, `src/components/SimpleInlineChat.tsx`, `src/components/chat/AssistantMessageBody.tsx`.)
- **Weak/local text-tool models settle cleanly under natural termination.** Text-tool detection now runs on each iteration's delta, so a prior round's `<tool_call>` isn't re-detected and re-executed every round (which previously looped until the turn exhausted). (`src/lib/agent/run-agent-turn.ts`.)

## [14.7.0] (2026-06-26) — Wait-state unification: the agent waits, stops, and resumes like a real coding agent

> Planned as 14.6.0, this release grew well past a regression patch, so it ships as **14.7.0** (the 14.6 fixes are folded in here). Two themes. First, the **four held 14.6 regressions** (plus two more found while fixing them) are resolved — the context meter, Atlarix Core's local fallback, Settings permission rules, and the edit-and-resend revert dialog all now behave. Second, and the bulk of the work: how the agent **WAITS** is now a property of the harness, not the prompt — so approvals, background commands, sub-agents, and scheduled checks behave the same way a proper coding agent does, robustly, for **any** model (especially weaker open-weight ones that can't be trusted to "manage" a wait). An approval now blocks the turn mid-loop (the **Stop** button stays, no premature "all done"); detached work **ends the turn cleanly and auto-resumes** when it finishes; the agent can view, cancel, and watch the progress of its own background sub-agents; and finished background results arrive as a real, persisted tool-result. A loop-termination fix keyed on `finishReason` removes a wasted extra round on every tool-using turn (a token win for every model). tsc (main + app + tests) + oxlint clean; full vitest green (**1439 tests**); verified across packaged builds.

### Added

- **Wait is a harness property, not a prompt (open-weight robustness).** Tool approvals now **block the turn mid-loop** (the await lives inside the tool's `execute`): the composer keeps showing **Stop**, the model can't emit a premature "no further action needed", approve continues the same turn, deny continues, and Stop cancels cleanly. No model has to "manage" the wait. (`src/ipc/handlers/permissions/interceptor.ts`, `chat_stream_handlers.ts`.)
- **Durable `waiting` status.** A parked/question turn persists as `waiting` (a TS-only enum value, no migration) rather than `interrupted`, so closing and reopening a session mid-wait shows a calm waiting/question affordance instead of the amber "interrupted/retry" error. (`src/db/schema.ts`, `workspace_session_handlers.ts`, `SimpleMessage.tsx`.)
- **The agent can manage its own background sub-agents.** `task({ list: true })` lists running sub-agents (ids, labels, elapsed, live progress tail), and `task({ task_id, cancel: true })` **hard-cancels** one — aborting its model stream so it stops spending tokens. Sub-agents also expose a live partial-output tail on status checks, matching background commands. (`src/lib/tools/spawn-task.ts`, `run-subagent.ts`.)
- **`schedule_wakeup` self-wake.** The agent can ask the harness to re-engage it after a delay (clamped 60–3600s) to re-check external state nothing else can notify it about. Fully opt-in: if it's never used, completion/stall auto-wakes still fire — behavior is identical. (`src/lib/tools/schedule-wakeup.ts`, `src/lib/agent/scheduled-wakeups.ts`.)
- **Atlarix Core local auto-fallback (dev-gated).** A dev-only Core key path lets a local packaged build exercise the Core fallback that previously only worked from CI secrets — release builds are byte-identical (the provider is a no-op when `app.isPackaged`). (`src/ipc/utils/dev_core_env.ts`, `compass_constants.ts`.)

### Changed

- **The agentic loop terminates on `finishReason`, not a native-message proxy.** With execute-based tools the SDK runs the whole multi-step inside one round and finishes `"stop"` when the model is done — but the old check treated any round that touched a tool as "keep going", so every tool-using turn ran a needless extra round (and a turn with only detached background work looped for the entire job). Keying termination on `finishReason` removes the wasted round and **parks detached work** so the turn ends and auto-resumes — a token saving for every model. (`src/lib/agent/run-agent-turn.ts`.)
- **Finished background results arrive as a real, persisted tool-result.** On an auto-wake, finished background-command / sub-agent results are delivered by a forced internal `collect_results` tool call that rides the existing native-history channel (persisted on the assistant message, survives reopen) instead of a transient prompt injection — a channel weaker models reliably consume. (`src/lib/agent/collect-results.ts`, `chat_stream_handlers.ts`.)
- **Longer async timeouts + advisory thresholds.** Background sub-agent wall-clock cap 5m → **10m**; the still-running "stalled" advisory threshold 2m → **3m** and its scan cadence 30s → 60s — so slow networks and large repos aren't misread as stuck. (`spawn-task.ts`, `background-commands.ts`.)
- **Background tasks fold into one card.** The running-jobs indicator collapses into a single "N background tasks running" card with a scrollable popover (each task with send-to-chat + cancel), instead of an overflowing row of chips. The approval chip reads "Waiting for your approval" when a permission card is pending. (`BackgroundJobsIndicator.tsx`, `InlineStreamStatus.tsx`.)

### Fixed

- **Context meter now drops after compaction, and reopened sessions slice correctly.** The compaction marker is now reliably persisted (the session id is threaded through instead of silently swallowed), and the footer/pill share one source of truth — so the meter reflects the real post-compress size immediately and a reopened session loads the compacted history. (`src/lib/tools/workspace.ts`, `compaction.ts`, `ChatInputControls.tsx`.)
- **Settings permission rules now actually apply.** Rules were written under one `apps` row and enforced under another when a workspace folder had duplicate rows (deleted + recreated path). An idempotent merge collapses duplicate `apps` rows onto the oldest canonical row, and writes/enforcement both resolve to it. (`src/ipc/utils/canonical-app.ts`, `src/db/index.ts`.)
- **Edit-and-resend revert dialog returns after relaunch.** The "Re-run from this message? Keep / Revert files" dialog's snapshot map is now rehydrated on the universal session-load path, so it appears after a relaunch (not just within the same session). (`src/lib/chat/revert-snapshot-rehydrate.ts`, `SimpleInlineChat.tsx`.)
- **No more re-answering an already-answered question on auto-wake.** A background/scheduled wake no longer re-feeds the user's last message as a fresh prompt (which made the model re-answer it every cycle) — it now reacts to the new event and continues. (`src/lib/chat/stream-transport.ts`.)
- **Decrypt-aware provider-key check.** A stored API key that fails to decrypt no longer counts as "usable" (which had blocked the Core fallback in the "could not decrypt secrets" state). (`src/main/db-secrets.ts`, `get_model_client.ts`.)

## [14.5.0] (2026-06-22) — Streaming reliability, full history, honest "Reconnecting", model-facing context meter

> The v14.5.0 release. A focused reliability + fidelity pass on the **chat stream and the conversation surface**: turns no longer double-fire or silently die, transient mid-turn stalls auto-retry instead of killing the turn, the "Reconnecting…" indicator is now reserved for genuine reconnects (provider-agnostic), the full conversation renders without a cap or destructive prune, the context meter reflects the real model-facing dispatched size, and long file reads happen in-band. Plus sub-agent panel ordering on native FC, user-only agent-error popups, edit-and-resend optional file revert, a read-only Review mode that produces a change list, agent terminal-tab routing, and a headless CI workflow. tsc (main + app + tests) + oxlint clean; full vitest green (1343 tests) — the 2 former benchmark smoke tests (`headless-runner.test.ts`, `swebench-smoke.test.ts`) are now **fixed** (stale `write_file` tool name → `edit_file` `operation:"write"`; `powerSaveBlocker` added to the electron test mock).

### Added

- **Stall auto-retry (per-round AbortController).** A transient mid-turn stall (provider hiccup, dropped chunk) now retries the in-flight round on a fresh `AbortController` and `chat:stream:reset-partial` signal instead of killing the whole turn. The watchdog separates a slow **first byte** (180s grace — reasoning/thinking models) from **idle silence** after streaming has begun (45s), so slow-to-think turns are never mistaken for drops. (`src/ipc/utils/stream_chunk_tags.ts` `processStreamChunks` watchdog, `firstByteTimeoutMs`/`stallTimeoutMs`, `onStreamStall`/`onStreamActivityPulse`; `run-agent-turn.ts` round retry.)
- **Edit-and-resend optional file revert.** Editing an earlier message and resending now offers (behind a confirm dialog) to revert the file changes made by the discarded turns — replaying their shadow-git snapshots newest→oldest so a re-run starts from the correct on-disk state. (`snapshot-manager.ts`, `revert:snapshot`, edit-and-resend range revert.)
- **Headless CI.** `.github/workflows/headless.yml` builds and publishes the `headless-bench` prerelease tarball (the Electron-free CLI used by the benchmark harness), kept as a prerelease so it never hijacks `/releases/latest`.

### Changed

- **"Reconnecting…" only on genuine reconnects (any provider).** The indicator is driven solely by the backend's real retry signal (`reconnectingByChatIdAtom`, set on `chat:stream:reset-partial`, cleared on the next chunk/pulse/turn end) — never from passive silence. Slow thinking, a long-running command, or a sub-agent delegating reads "still working", not "Reconnecting". Provider-agnostic by construction. (`InlineStreamStatus.tsx`, `chatAtoms.ts`.)
- **Single-flight turn guard.** At most one turn (and one set of writes) runs per chat at a time: a new turn supersede-awaits the previous one, and the renderer gates on a dispatch-id so a stale stream can't paint over a live one. (`chat_stream_handlers.ts`, `useStreamChat.ts`.)
- **Smooth streaming render (no virtualization).** The conversation renders all messages with a memoized `AtlarixMarkdownSegment`, Shiki highlighting deferred while a segment is still streaming, `React.memo` message rows, and `overflow-anchor` so new tokens don't bounce the scroll position or re-highlight the whole thread on every chunk. (Chat-list virtualization was prototyped and **reverted** — net state renders all rows.)
- **Full conversation history.** Removed the 7-exchange render cap, lifted `SESSION_LOAD_MESSAGE_LIMIT`, and removed the destructive 200-message prune — the whole conversation loads and renders with no silent history loss (parity with Claude Code / opencode / Cursor / Codex). (`session_constants.ts`, session load path.)
- **Model-facing context meter.** The context usage meter now shows the real **dispatched** size sent to the model (post-compaction `dispatchEstimate`), so it actually drops back down after a summarize and matches what's on the wire — not the raw un-compacted transcript length. (`compaction.ts`, `tier_context_budget.ts`, `chat:context-report`, `useContextReport`.)
- **In-band file reads.** Dropped the disk-spill tool-output envelope (`maybeTruncateToDisk`); `read_file` self-paginates with stateless offset paging on the source path (opencode/claude-code parity), plus a read-aware repetition nudge so the model pages forward instead of re-reading. (`src/lib/tools/read-file.ts`, interceptor.)
- **Review mode is read-only.** Review produces a **change list** (what to change and why) and never attempts edits or source-mutating commands. (`src/skills/modes/review.md`, mode policy.)

### Fixed

- **Sub-agent panel ordering on native function-calling** — the content-seam split that interleaved sub-agent cards out of order under native FC. (`stream-thread.ts`, `InlineStreamStatus.tsx`.)
- **Agent-error popups are user-only.** Agent command failures no longer raise a toast (the error is in the tool card); popups are reserved for user-initiated actions, and the toast body is scrollable. (`useStreamChat.ts` error routing.)
- **Background-job auto-wake end-of-turn race** — a job finishing exactly as the turn ended could drop its wake; the wake now lands before the turn closes. (`background-commands.ts`, `run-agent-turn.ts`.)
- **Agent terminal-tab routing** — agent command output now reaches the right-panel Terminal tab via a multi-subscriber `onTerminalOutput` and an ASK-mode forwarder, instead of being swallowed. (`TerminalPanel.tsx`, `interceptor.ts`, `ipc_client.ts`.)

## [14.0.0] (2026-06-21) — Live preview control, session recordings, true background jobs, and mode-policy command safety

> The v14.0.0 release. A major pass on the agent's **execution surface**: the agent can now drive and verify the *running app* (not just the in-app browser), record what it did as a scrubbable reel, push long-running commands to the background and wake itself when they finish, and run everyday commands freely while code/history changes wait for the right work mode. Plus a provider-agnostic `web_search` fix, capability-based vision, readable tool cards, and a packaging auto-resign hook. tsc (main + app + tests) + oxlint clean; full vitest green (1326 unit/eval tests) except 2 pre-existing benchmark smoke tests (`headless-runner.test.ts`, `swebench-smoke.test.ts`) that fail only in the local sandbox on an incomplete `electron` mock — unaffected by this release.

### Added

- **`target:"preview"` — the agent drives the LIVE app.** `browser_navigate` / `browser_inspect` / `browser_interact` now accept `target:"preview"` to act on the running dev server the user sees (open routes, `mode:"snapshot"` to list refs, click/fill, `mode:"console"` to read runtime errors), in addition to the default `target:"browser"` (in-app browser). The preview is a real `WebContentsView` (not an iframe), so it captures navigation, console, and page errors natively. (`src/lib/tools/browser.ts` target routing, `src/ipc/utils/browser_view_manager.ts` preview surface + `capturePaintable` + `broadcastToRenderer`, `CodePreviewPanel`.)
- **Inline preview artifact in chat.** When the agent exercises the preview, it surfaces as an inline chat artifact (alongside markmap/echarts cards) rather than living only in the right-panel preview tab. (`useStreamChat.ts` `preview:dev-url`, `VisualArtifactCard`.)
- **Session recordings (scrubbable reels).** The agent's browser/preview activity is captured off-screen as an incremental frame manifest and rendered as a scrubbable player card with a pin-on-interaction scrubber (no longer stuck on the last frame). (`src/ipc/utils/browser-reel.ts` `capturePaintable` + live emit, `media_handlers.ts` `getMediaPath`, `src/components/chat/SessionRecordingCard.tsx`.)
- **`background_jobs` tool + true background lifecycle.** `background_jobs({operation:"list"|"output"|"cancel", job_id})` lists, reads, and cancels detached commands; `run_command({background:true})` returns a `job_id` and runs detached. **Any command still running after ~15s auto-moves to the background** (a timer-based promotion — no hardcoded command names) and keeps serving; the turn can end while it runs. (`src/lib/agent/background-commands.ts` registry + `killAllBackgroundJobs`, `src/lib/tools/background-jobs.ts`, `src/ipc/handlers/background_handlers.ts`, `src/components/chat/BackgroundJobsIndicator.tsx`, `main.ts` quit cleanup.)
- **Auto-wake when idle.** When a backgrounded job finishes, the agent is automatically re-engaged (no polling) via `continueAfterQuestions` + `prepareStep` injection. Atlarix can also background its *own* commands and check back on them periodically until told otherwise.
- **Generic localhost-URL → preview.** Any backgrounded process that prints a `localhost` URL auto-loads the preview (`preview:dev-url`) — generic, not dev-server-name matched.
- **Local-build auto-resign.** `forge.config.ts` gains a `postPackage` hook that ad-hoc re-signs + clears quarantine (`codesign --force --deep --sign -`, `xattr -cr`) on macOS local builds (skipped under CI), fixing the Gatekeeper "Code Signature Invalid" SIGKILL after `packageAfterPrune` strips files.
- **Launchpad help pages.** `/docs/*` help routes (e.g. AI rate-limit troubleshooting) on atlarix.dev.

### Changed

- **Preview: iframe → `WebContentsView`.** Native navigation/console/error capture flows into the Errors tab and back to the agent (`browser_inspect target:"preview" mode:"console"`); empty/black frames when the preview tab isn't focused are fixed via off-screen `capturePaintable`.
- **Terminal output streams inline** with a live activity pulse instead of false "Reconnecting…" — sequential foreground commands reuse one Agent tab; only background processes get their own tab.
- **Capability-based vision gate.** `detectVisionCapability` replaces the hardcoded 3-provider allowlist — any BYOK model advertising vision can receive screenshots. (Provider-agnostic, per the no-hardcoding rule.)
- **Command persistence + safety overhaul.** Removed the 10s/120s kill-timeouts and the fake "Dev server started successfully" (root cause of dev servers dying after 10s). Command safety is now layered: **work-mode policy** (Explore/Plan/Review refuse source-mutating commands in the prompt; Build/Debug allow them) + a compound-aware `isMutatingCommand` backstop (`src/lib/command-mutation.ts`, parses `&&`/`;`/`|` segments) + the dangerous-commands gate + `.atlarix/permissions.json` rules — researched against Cursor/Antigravity/Codex/Claude Code/opencode, no large hardcoded classifier. Retired `src/lib/terminal-command-class.ts`.
- **Readable, arg-aware tool cards.** Tool activity labels render real arguments with icons (not emojis); `src/lib/tool-activity-labels.ts`.
- **AGENTS / mode prompts realigned** to the real tool surface (background jobs, preview, command policy); error-recovery hints updated. (`AGENTS_MODE_BASE.md`, `AGENTS_COMPACT.md`, `src/skills/modes/*.md`, `mode-prompt-bundle.ts`.)
- **Rate-limit error card drops the upgrade button** — links to troubleshooting (atlarix.dev/docs) only.

### Fixed

- **Provider-agnostic `web_search` dedup** — the xAI/Grok `Duplicate tool names: web_search` crash. Native provider tools are reconciled against Atlarix's own tools via `reservedNativeToolNames` across *all* providers, not an xAI/OpenRouter special case.
- **`browser_interact` fill reliability** — a self-correcting error plus a schema that emphasizes `value` is required, fixing native-FC models (e.g. Grok via OpenRouter) that omitted the fill value.
- **Empty preview frames** when the preview tab isn't focused (off-screen capture).
- **Dev servers dying after ~10s / fake "running in background"** — removed in the persistence overhaul above.

