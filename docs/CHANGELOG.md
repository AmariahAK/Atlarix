# Atlarix Changelog

## [14.8.11] (2026-07-04) — Attachment fidelity, edit re-indentation, honest compaction, real context windows, ordered stream UI

> A harness-fidelity release: every issue was an OBSERVED live failure (DeepSeek v4 pro session
> transcripts + a five-sweep code investigation). Attachments now reach the model whole (and
> survive interruptions), a tolerant edit match can no longer corrupt a tab-indented file, the
> compaction tool tells the truth, context windows come from real provider data instead of a
> hardcoded table, and both the main and sub-agent streams render in true chronological order.
> tsc (main + app + tests) + oxlint + knip clean; full vitest green (**1639 tests**).

### Fixed

- **`edit_file` fuzzy matches re-anchor `new_content` to the file's REAL indentation.** Observed
  live: on a tab-indented Go file, a space-indented model input fuzzy-matched correctly but the
  replacement was spliced VERBATIM — writing spaces into a tab file (mixed indentation, shifted
  brace depth; the model had to fall back to `sed`). This gap was faithfully ported from opencode —
  fixed beyond the reference: mapped lines adopt the matched region's actual indents (monotone
  trimmed-text + model-indent agreement), novel lines extrapolate by indent-unit delta, and ANY
  ambiguity falls back to verbatim — never worse than before. First direct unit suite for the
  match cascade. (`src/lib/tools/edit-match.ts`, `edit.ts`.)
- **Interrupted turns no longer erase attachment content for the model.** Paste-attachment ids are
  ALWAYS the deterministic content-hash (a `randomUUID` branch minted fresh ids on every
  rehydration → the model's announced id returned "Attachment not found" after a resume); the
  send-time persist retries once instead of silently leaving a body-less stub row; and editing a
  message now REGENERATES its model-facing content (stubs re-expanded from stored paste bodies)
  for both the live transport and the DB row — previously the DB kept the STALE pre-edit prose,
  which dispatch prefers, silently undoing the edit for the model after a reload.
  (`src/lib/attachment-persistence.ts`, `chat_stream_handlers.ts`, `workspace_session_handlers.ts`.)
- **`compress_context` tells the truth — and actually compacts when the model asks.** The
  model-initiated call was a guaranteed mid-turn no-op ("tokens did not reduce") while the UI
  banner claimed "Context compressed" unconditionally: the usage gate measured messages-only
  tokens against a hardcoded `systemPromptTokens: 6000`, below the 60% threshold it did nothing,
  and the "summary not saved" error fired for prune passes that legitimately persist nothing. Now
  a model call forces past the gate (8K-history sanity floor), the ratio uses the METER's scope
  (history + the stream's real system prompt + input), ONE per-message exact counter feeds every
  user/model-facing number, the banner is success-gated ("Context already compact" on no-op), and
  the not-saved warning fires only for the summarize strategy. (`src/lib/context/compaction.ts`,
  `src/lib/tools/workspace.ts`, `chat_stream_handlers.ts`.)
- **Context windows come from real provider data — the per-model hardcode table is DELETED.**
  Observed: a native-DeepSeek session compacted against `128000` while DeepSeek v4 pro is 1M on
  BOTH the first-party API and OpenRouter — the resolution chain never reached a real source for
  native providers and fell into an identity-derived hint table (`deepseek→128000`,
  `claude→200000`, …). Resolution is now provider-uniform: user override → live OpenRouter catalog
  → provider row → models.dev (new per-model limits lookup + a one-funnel enrichment of EVERY
  provider fetcher) → one logged generic fallback. `getUsableBudget` resolves through the same
  chain (its old sync alias passed a PROVIDER id where a MODEL id was expected → everything got
  128K), and the Settings token-budget override now wins EVERYWHERE, including the compaction
  denominator. (`src/lib/context/resolve-model-context-limit.ts`, `models_dev.ts`,
  `provider_model_fetchers.ts`, `compaction.ts`.)
- **Sub-agent cards read like the main chat — thought → tool → thought, in order.** All of a
  round's reasoning was coalesced into ONE rolling item whose timestamp was pinned to its first
  emit, so the card's correct chronological sort necessarily showed "thoughts on top, tools in the
  middle, edits at the bottom". Reasoning segments now ROTATE at every tool boundary (each span is
  its own item with its own timestamp); the renderer needed zero changes.
  (`src/lib/agents/run-subagent.ts`.)
- **Compaction/background cards render inline at their real position, not pinned to the bottom.**
  IPC-only cards had no representation in the assistant text and were appended as a trailing
  block. A new pure timeline-weave anchors content tool parts to their thread twins by
  (toolName, occurrence) and inserts each IPC card where its timestamp falls between two anchors;
  anything unanchorable keeps the old tail placement, and the same weave drives the streaming AND
  completed renders so they can't diverge. (`src/lib/chat/timeline-weave.ts`,
  `src/components/chat/AssistantMessageBody.tsx`.)
- **Editing a sent message keeps its attachment chips.** The edit box bound the RAW content, so
  terminal/paste attachments appeared as literal `<atlarix-…>` XML wording. Stub tags are now
  stripped from the editable prose, rendered as read-only preview chips above the textarea (all
  attachment kinds), and re-spliced on save. (`src/lib/chat/edit-attachment-tags.ts`,
  `src/components/SimpleMessage.tsx`.)

### Improved

- **`read_attachment` pages the FULL extraction — attachments are never truncated away.** The
  per-extractor 200K-char total caps (PDF/CSV/xlsx/pptx/odt/rtf) are gone: extractors return full
  text, the tool pages it read_file-style (1-based `offset`/`limit`, 2000-line/200KB pages), every
  result states the totals and the EXACT next call, extraction is cached on the attachment record
  so paging never re-parses, and the tool is exempt from the generic truncation envelope. The
  inline send-time preview now uses the ONE shared extension list (a `.py`/`.go` upload finally
  gets a preview) with an honest "preview only" footer. `rawBase64` payload bloat (megabytes of
  base64 JSON-stringified at the model) is dropped from all results.
- **Attached images are actually VISIBLE to vision models.** They previously reached the model as
  JSON-stringified — and truncation-corrupted — base64 TEXT. The read_attachment image branch now
  returns the screenshot shape, and the media adapter gates on RESULT SHAPE instead of a
  browser-tool name allowlist (`extractScreenshotMedia` → `extractImageMedia`) — so attached
  images ride the exact pipeline screenshots ride: native media part on vision models, honest
  placeholder on non-vision models, truncation-exempt. SVG returns as XML text (providers reject
  `image/svg+xml` as image input); batch reads point at a single-id call per image.
- **Preflight TTFT gaps are attributable.** Spans record offsets and the `preflight-breakdown`
  line names every ≥50ms inter-span gap (`gap-after-<name>`/`pre-first-span`) — live sessions
  showed up to 60% of preflight time unaccounted; the S18 reorder pass now knows exactly where to
  look. Attachment ingest I/O (temp-file writes + PDF pre-extract) is wrapped.

### Removed

- **Every dead legacy positive-id chat branch.** All live chats are negative-id stream-transport
  chats (renderer, headless CLI, evals); `isEphemeralWorkspace` was a tautology. The flag is now a
  loud invariant, and the unreachable half is gone: the legacy auto-summarize block, `canDb`
  compaction guards, `runCompaction` + its ledger deferral, the compress-context DB branch, and
  the `turnId`/`setMessages` ternaries. Two dead-by-flag features (never ran in production) were
  deleted outright: auto-memory-after-stream (+ module, settings toggle, tool-use tracking) and
  the post-turn self-correction husk.

## [14.8.10] (2026-07-03) — Reliable background work, one permission gate, lighter UI, sharper reasoning

> A harness-refinement release surfaced from a live installed-app session. The agent now **actually
> receives background results** (and stops polling), force/dangerous commands flow through **one
> allow/deny gate** instead of an unsatisfiable dead-end, the UI is **lighter under load**, reasoning
> **scales to each model automatically**, and long-running jobs can be **watched** — by the model and
> by you. tsc (main + app + tests) + oxlint + knip clean; full vitest green (**1576 tests**).

### Fixed

- **The repetition guard guides instead of killing the turn — and its false trigger is gone.**
  Observed live: a turn was force-finished mid-task after 3 consecutive edits to the SAME file with
  *different* content — the permission-path recorder keyed `edit_file` by `{path}` only, so
  legitimate sequential work read as a byte-identical doom loop. Fixed (full-args keying, single
  record site at the execute-wrapper top), and the guard is now STAGED: 3 identical calls → the
  call is answered with a corrective tool result instead of executing ("re-read the file / change
  approach"); 6 → stronger steer + an invitation to stop on the model's own terms; only the 9th
  fires the tools-off force-finish backstop. Repeated status-text gets the same treatment (correct
  first, abort on a second full run). (`src/lib/streaming/agentic-loop-repetition.ts`,
  `src/ipc/handlers/chat_stream_handlers.ts`, `src/lib/agent/run-agent-turn.ts`.)
- **grep no longer looks "stale" after the agent's own edits.** Matching was always live ripgrep,
  but the FTS5/BM25 layer that reranks hits (and suggests symbols on zero hits) was never updated
  mid-session — the watcher only registered when the Blueprint panel was opened, and the index only
  rebuilt on a git-HEAD change — so a just-written file ranked WORST and could drop below the
  result cap. Now: the write path upserts each written file into the index (fire-and-forget), the
  reranker treats unindexed files neutrally (they keep their ripgrep rank), and the watcher
  registers on workspace bind for every agent session. (`src/ipc/handlers/permissions/interceptor.ts`,
  `src/lib/blueprint/{grep-blueprint-reranker,blueprint-file-watcher}.ts`.)
- **Inline chat no longer freezes after an error + model-switch continue.** A dying stream's late
  `chat:response:error`/`end` (e.g. after 429s) crossed a queued continue on the same chat and wiped
  the live turn's streaming state — the UI froze while tools kept running in the terminal panel.
  Every lifecycle event now carries the leg's `streamId`, the `chat:stream` invoke returns it, and
  the renderer drops events from superseded legs (plus owner-checked registry cleanup main-side).
  (`src/ipc/handlers/chat_stream_handlers.ts`, `src/ipc/ipc_client.ts`.)
- **edit_file self-heals across typographic punctuation.** Observed live: a curly-quoted markdown
  file + a model emitting straight-ASCII `old_content` looped on "Content to replace not found."
  New `unicode-punctuation` layer in the replace cascade (curly quotes/guillemets → `"`,
  em/en-dash → `-`, ellipsis → `...`, NBSP → space, both sides normalized, original typography
  preserved in the file). (`src/lib/tools/edit-match.ts`.)
- **The sidebar "new window" button opens a fresh window with the workspace chooser** instead of
  cloning the current workspace into a new window (new `window:open-blank` IPC; the old
  per-workspace path remains for CLI/second-instance use). (`src/main/workspace_window_ipc.ts`,
  `src/components/AppList.tsx`.)
- **Model-driven commits now carry the Atlarix co-author trailer.** The commit guidance instructs
  every model to end commit messages with `Co-authored-by: atlarix-agent <agent@atlarix.dev>`
  (harness-made commits already did). (`src/lib/tools/mode-prompt-bundle.ts`.)
- **End-of-turn timeline no longer regroups old tool cards under the final message.** The inline
  timeline rebuild is now a persistence fallback only — it never overwrites an already-attached
  timeline and scopes activity to the current turn. Sub-agent guidance also now steers long
  delegations of ANY kind (read-only or writer) to `background:true` + park/auto-wake instead of
  holding the turn open. (`src/hooks/useStreamChat.ts`, `src/lib/tools/spawn-task.ts`.)
- **Headless tarball rebuilds automatically on every `v*` release tag** — the headless-bench
  prerelease can no longer silently go stale (was a manual runbook step).
  (`.github/workflows/headless.yml`.)
- **Plan progress updates are now weak-model-proof.** Observed live (DeepSeek): `update_step` by
  numeric index hit "Step not found… retry with a valid step_index" twice — index bookkeeping
  drifts, and the bare error demanded a `plan(read)` round-trip only strong models think to do;
  a weaker model stops marking steps, which then feeds the continue-until-done gate. Aligned with
  Claude Code TodoWrite / Codex update_plan: **full-plan rewrite (`operation:'write'` with updated
  `[x]`/`[~]` marks) is now the canonical progress update** (no addressing → cannot miss);
  `update_step` is a convenience that prefers `step_text`, its not-found error now carries the
  current checklist inline plus both recovery routes (one-shot self-correction), and when index +
  text disagree the text wins (a drifted index can no longer silently mark the WRONG step).
  Guidance re-steered everywhere it mentioned `step_index`. (`src/lib/tools/plan.ts`,
  `src/lib/tasks/plan-checklist.ts`, `src/lib/tools/mode-prompt-bundle.ts`.)
- **Dead Blueprint UI surface removed.** The June get_blueprint removal left the renderer-facing
  plumbing behind with zero callers: 13 `blueprint:*` invoke channels + 3 event subscriptions in
  `ipc_client`, 17 preload allowlist entries, the entire `registerBlueprintHandlers` (430 lines,
  incl. `setBlueprintForWorkspace`/`invalidateBlueprintCache`), and 3 UI-only libs
  (aiSimplifier, project-selector, reference-manager). The substrate is untouched —
  `getBlueprintForWorkspace` + FTS5/ctags/ast-grep still power grep rerank, zero-hit suggestions,
  and blast-radius, and its freshness now comes from the write-path upsert + session-bind watcher
  (see the grep-staleness fix). (`src/ipc/handlers/blueprint_handlers.ts` 931→406 lines,
  `src/ipc/ipc_client.ts`, `src/preload.ts`, `src/ipc/ipc_host.ts`.)
- **Tool-result JSON fragments no longer leak into chat text.** A model echoing part of a plan tool
  result (`","message":"Plan created."}`) slipped past the display sanitizer, which required a
  leading `{`. Orphan result *tails* keyed by known result fields are now stripped; real prose
  mentioning "message" is untouched. (`src/lib/chat/answer-display.ts`.)
- **The continue-until-done gate no longer restarts finished work or hijacks Plan mode.** Observed
  live (Qwen): the v14.8.9 plan-completeness nudge fired on a *freshly presented plan* in Plan mode
  (whose steps are pending by construction — the model read "continue, do NOT end the turn" as
  "proceed without the user" and started implementing), and on completion-wakes it re-listed steps the
  model never marked done, driving it to **re-run already-finished background tasks**. Fixes: the gate
  no longer attaches in Plan mode (the plan IS the deliverable); the nudge now says *mark
  already-completed steps done — never redo work that already succeeded*; and a hard per-turn total
  (12) bounds nudges even when productive rounds keep resetting the consecutive 6-cap (observed: 3+
  full cycles in one turn). Background/sub-agent result bodies got the same completion-aware framing
  ("if this completes the request, report and end your turn — never re-run finished work").
  (`src/lib/tasks/plan-completion-gate.ts`, `src/lib/agent/run-agent-turn.ts`,
  `src/ipc/handlers/chat_stream_handlers.ts`, `src/lib/agent/background-commands.ts`,
  `src/lib/agents/subagent-results.ts`.)
- **Background/sub-agent results are delivered reliably — no more polling.** A take-once ordering bug
  drained the pending-results buffer during context assembly before the wake-turn decided how to
  deliver them, so the un-skippable `collect_results` path silently never fired and results rode a weak
  channel weak models ignore. The wake decision is now computed up front (single-consumer invariant),
  and `background_jobs` no longer claims "delivered automatically" when it wasn't — it shows the real
  finished output. (`src/ipc/handlers/chat_stream_handlers.ts`, `src/lib/agent/{background-commands,collect-results}.ts`, `src/lib/tools/background-jobs.ts`.)

### Changed

- **One permission gate — the "dangerous command" hard floor is gone.** Force-push / `reset --hard`
  / `rm -rf` no longer hit a throw that demanded a confirmation the autonomous UI never showed (an
  unsatisfiable loop). Every command now flows through the existing ask / allow-once / **always-allow**
  / deny gate; "dangerous" is an amber badge, keyed per danger pattern so an "allow git" can never
  silently permit `git push --force`, and a dangerous command is never auto-run until you allow it once
  (revocable in Settings). (`src/lib/dangerous-commands.ts`, `src/ipc/handlers/command_permission_handlers.ts`, `permissions/{interceptor,handlers}.ts`, `InlinePermissionApprovals.tsx`, `WorkspaceTerminalPermissions.tsx`.)
- **Reasoning scales to each model automatically.** Effort is now capability-derived from the model's
  catalog channel: budget-capable models run base **high** / Deep-thinking **max** (token budget scaled
  to the model's own max, reserving output so it never truncates); effort-only models (OpenAI) run
  **medium** / **high**. No per-model hardcoding. (`src/ipc/utils/thinking_utils.ts`, `src/lib/routing/reasoning-detector.ts`.)
- **Lighter UI under load.** The blueprint file-watcher is now ignore-filtered (node_modules/build
  churn no longer drives reindex), and per-chat jotai selectors stop every message/tab re-rendering on
  each stream tick. (`src/lib/blueprint/blueprint-file-watcher.ts`, `src/atoms/chatAtoms.ts` + consumers.)

### Added

- **`wake_on` monitor for long-running jobs.** `run_command({ wake_on: "compiled successfully" })` (or
  `background_jobs({operation:"watch"})`) wakes the agent the moment a still-running job's output
  matches — the 3-min idle ping and completion-wake remain as backstops. Prompt guidance also steers
  the model to background a blocking watcher (e.g. `gh run watch`) for external state instead of
  polling. (`src/lib/agent/background-commands.ts`, `src/lib/tools/{shell,background-jobs,schedule-wakeup}.ts`.)
- **Background-job live view.** The running-tasks popover now expands each job to show its live output
  tail with a stalled/matched badge, alongside cancel and send-to-chat — so you can watch a background
  command and then discuss it. (`src/components/chat/BackgroundJobsIndicator.tsx`.)

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

