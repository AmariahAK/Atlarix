# Atlarix Changelog

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

