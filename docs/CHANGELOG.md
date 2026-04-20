# Atlarix Changelog

## v7.0.2 — Chat strip labels, counsel/deep-think UX, turn artifacts (2026-04-20)

- **Tool / working strip (`ToolIndicator.tsx`, `chatAtoms.ts`, `useStreamChat.ts`, `ipc_client.ts`):** Provider-agnostic labels from stable **`toolId`** (registry name or MCP key): read-only → *Reading your codebase…*, writes → *Modifying the codebase…*, web tools → *Searching the web…*, MCP → *Checking …*, default *Thinking…*. Strip stays visible from **submit through stream end** (not hidden when a tool finishes mid-turn). **`chat:tool:start`** payloads include **`toolId`**; **`chat:stream:phase`** with **`phase: "done"`** is emitted on **`chat:response:end`** / **`chat:response:error`** so lifecycle stays aligned with the renderer.
- **Autonomous / counsel strip:** **Delegation + agent bus** activity can override the strip to *Splitting to autonomous agents…*; **`counsel_start` / `counsel_end`** (via **`chat:stream:phase`** and **`counsel-runner` `onCounselStreamLifecycle`**) show *Consulting the counsel…* during counsel pre-pass (explicit, auto, mid-task, deep-think substitute).
- **Deep think fallback (`reasoning-detector.ts` `hasNativeDeepThinkingSupport`, `chat_stream_handlers.ts`, `chat_only_handlers.ts`):** When **one-shot deep thinking** (`forceThinkingTier`) is on and the **effective model has no native reasoning path** (reasoning provider options + gateway thinking flags), the app **runs Counsel as a silent substitute** for that turn and **skips** native reasoning for the API. New counsel trigger **`deep_think_fallback`** (`counsel-session.ts`). Context assembly adds section **`counselDeepThinkSubstitute`** (`ContextAssembler.ts`).
- **Chat-only counsel:** Ephemeral / no-workspace path mirrors **auto counsel** trigger + lifecycle (same rules as workspace handler); **`thinkingTierEffective`** avoids requesting native reasoning when deep-think counsel substitute applies.
- **Turn artifacts (`completedTurnArtifactsByAssistantMessageIdAtom`, `useStreamChat.ts`, `TurnArtifactsCards.tsx`, `ChatMessage.tsx`):** On stream **end** / **error**, snapshot **Counsel** (trigger, participant previews, synthesis snippet) and **Agentic-Bus** (last lines from **`agentBusRingByChatIdAtom`**) per assistant message; collapsible cards (**collapsed by default**). Activity items carry **`counselTrigger`** from counsel **`trigger`** (`sourceAtoms`, `chat-activity-normalize.ts`).
- **IPC / preload:** Tool start listeners pass optional **`toolId`**; no new preload channel names required for this patch.

## v7.0.1 — Deep research ledger + web relevance (2026-04-17)

- **`deep_research` (`web-tools.ts`):** ResearchLedger + agentic loop: `SubQuestion` / `ResearchFinding` / `DeepResearchResult`, `DEEP_RESEARCH_LIMITS` (semantic stops: max iterations 8, coverage ≥ 0.75, 3 consecutive empty iterations, 3 attempts per sub-Q, 3 search hits per attempt, 2000 chars per excerpt, 10s fetch timeout), `decomposeQuery` for missing `aspects`, `deepResearchQuickSearch` → `WebSearchAggregator.search(..., "general", n)` (equivalent to `web_search` quick path; unchanged in-flight cache / SearxNG chain), `smartReadUrlForDeepResearch` + existing `extractRelevantSection` (4-arg BM25, unchanged implementation), `refineQuery` / `scoreRelevanceForDeepResearch`, `formatResultForModel`, iteration + completion `console.log` lines. Tool return: `text`, `sources` (favicon/snippet map), plus `aspects_used`, `coverage_score`, `iterations`, `completion_reason`, `findings`. Dropped `max_iterations` parameter.
- **Chat-only (`chat_only_handlers.ts`):** Removed `deepResearchQueryNorm` / supplementary `web_search` counter / `MAX_SUPPLEMENTARY_WEB_SEARCH_WITH_DEEP` / broad-overlap skip helpers (`normalizeResearchTopicForGuard`, `extractWebOrDeepQueryFromParams`, `isBroadRestatementOfDeepTopic`); no external cap on `web_search` after `deep_research`.
- **`filterRelevantResults`:** Snippet relevance floor **0.15 → 0.25** (aggregator-ranked results).
- **Deep research “answered” gate:** Token-overlap score threshold for marking a sub-question answered **0.6 → 0.35** (aligns coverage with typical BM25 excerpts).

## v7.0.0 — Atlarix v7 (Project Vanguard) (2026-04-11)

Major architectural release: agent execution, context, snapshots, parallel work, and plan UX are rebuilt on the existing Blueprint foundation.

- **Skills (`src/lib/skills/`):** Mode and specialist behavior driven from versioned skill files; workspace overrides under `.atlarix/skills/`.
- **Task ledger (`task-ledger.ts`, `completion-detector.ts`):** Structured steps, tool attribution, delegation advances, and disk-backed state for workspace plans; survives compaction and long sessions.
- **Plan sync + archive (`plan-sync.ts`):** Living `.atlarix/ATLARIX_PLAN.md`; archives prior markdown under `.atlarix/plans/archive/` before replace.
- **Plan viewer (renderer):** New `chat:plan-update` IPC (`ipc_types.ts`, `preload.ts`, `ipc_client.ts`, `emit_plan_update.ts`); `registerLedgerPlanUiNotifier` / `unregisterLedgerPlanUiNotifier` in `task-ledger.ts`; `TaskLedgerPlanCard.tsx` + `globals.css` plan-card styles; `livePlanUpdateByChatIdAtom` / `planSnapshotByAssistantMessageIdAtom` in `chatAtoms.ts`; `useStreamChat.ts` subscribes and snapshots on stream end; `ChatMessage.tsx` renders the card between `AgentActivityLog` and markdown.
- **Activity Stream:** `plan_created` type (`chat-activity-normalize.ts`, `sourceAtoms.ts`, `AgentActivityLog.tsx`) emitted from `chat_stream_handlers.ts` when a multi-step plan is first seeded for the turn.
- **Parallel agents + counsel + verification:** Unchanged themes from 6.5.x but shipped as the default 7.x story—see README “What changed” for the user-facing summary.
- **Snapshots / diagram:** Prior 6.x snapshot and revert work remains; path sanitization and plan archive directory follow ledger rules (see 6.5.x notes).

## v6.5.0 — Project Vanguard (2026-04-09)

- **Living plan (`plan-sync.ts`):** Workspace **`.atlarix/ATLARIX_PLAN.md`** stays aligned with the **task ledger**—status, steps with `[ ]` / `[~]` / `[x]` / `[!]`, notes placeholder, and a **## Completion** file list when the run finishes cleanly. Updates run from ledger create/replace, tool recording, delegation advances, and stream completion (never throws).
- **Plan archive:** Replacing steps from a parsed plan **or** approving a write to the plan file **archives** the previous markdown under **`.atlarix/plan-archive/`** before overwrite (permission interceptor + `setLedgerSteps`).
- **`parsePlanToSteps`:** Supports checkbox lines (`1. [ ] …`, `[~]`, `[!]`, `[x]`); **completed `[x]` lines are skipped** when seeding the ledger; plain numbered lines still work.
- **Auto memory:** Settings add **`autoMemory.writeToFile`** (default **true**); when false, **`.atlarix/ATLARIX.md`** is not written. Per-turn **tool names** are tracked for auto-memory bullets (cleared after each turn’s auto-memory pass).
- **Counsel IPC:** **`counsel:start`** / **`counsel:cancel`** invoke handlers; main emits **`counsel:participant-update`** and **`counsel:complete`** (also mirrored on **`chat:activity`**). `runCounselPipeline` accepts **`abortSignal`** for cooperative cancel. Preload whitelist + **`IpcClient`** helpers + **`ipc_types`** payloads.
- **Provider-agnostic task flow:** Audited continuation, completion, build verification, compaction, and parallel delegation paths—**no Compass-only gates** on ledger continuation or autonomous verification; Compass-specific code remains usage, limits, and telemetry.
- **Build verification:** Confirmed **pattern 2** after task-complete: parallel **reviewer + debugger** at **`depth: 1`**, **`recordOnParentLedger: false`** (parent `turnId` omitted inside `runDelegation` to avoid ledger races).
- **Migrations:** Journal through **0040** and **`migration_seed_verification`** cases verified for counsel, hooks, custom commands, compaction/synthetic columns, and snapshot/revert fields (no new SQL in this release).

## v6.2.2 — Tier-aware Compass context + pre-dispatch budgeting (2026-04-09)

- **Dynamic tier limits (`tier-context-limits.ts`):** Fetches per-model `context_length` from OpenRouter’s public `GET /api/v1/models`, applies a safety factor, caches results **24h** (keyed by the three model id strings). Warmed at app startup from Compass env model ids. Unknown ids or fetch failures use conservative fallbacks without throwing.
- **Pre-dispatch budgeting (`tier_context_budget.ts`, `context_budget_routing.ts`):** For **Balanced** and **Thinking** only (Fast unchanged): before `streamText`, if estimated tokens exceed the tier limit, compress **older** conversation (beyond last three exchanges) using the same summarization path as context compaction (**no** DB write), then progressively trim the ContextAssembler injection blob in the system prompt. Resolves tier from Compass synthetic names or Auto `autoModelIds`; BYOK OpenRouter overrides the active tier’s limit lookup id.
- **OpenRouter safety gate:** Single `needsOpenRouterContextSafety` — OpenRouter **context-compression** plugin and **last-7-exchanges** cap apply to **Compass** and **BYOK `openrouter`** when tier is **balanced** or **thinking** (disabled for **fast**). Replaces Compass-only checks in [`chat_stream_handlers.ts`](../src/ipc/handlers/chat_stream_handlers.ts).
- **Compaction helper:** `summarizeMessagesWithCompactionPrompt` in [`context-compaction.ts`](../src/lib/context-compaction.ts) — shared LLM path for budget summaries; `runCompaction` reuses it for the generate step.

## v6.2.1 — Autonomous session polish + Thinking UI + snapshot hash path (2026-04-08)

- **Autonomous Build / agent mesh:** Auto-approve permissioned tools in autonomous and workspace chat paths; in-memory session op log and agent-activity capture; agent bus lifecycle (`task_assign`, `task_result`, `blocker`, `correction`); `message_agent` + `waitForBusReply`; turn-scoped orchestrator wired from the Build stream; correction suffix on delegated tool results; `AutonomousReviewPanel` with `autonomous:session-complete`, `autonomous:revert-op`, and `autonomous:accept-all` IPC; selective `revertSnapshotFiles` under `.atlarix/snapshots/<turnId>/`. Key areas: [`chat_stream_handlers.ts`](../src/ipc/handlers/chat_stream_handlers.ts), [`agent-bus.ts`](../src/lib/agents/agent-bus.ts), [`orchestrator.ts`](../src/lib/agents/orchestrator.ts), [`agent-tools.ts`](../src/lib/tools/agent-tools.ts), [`snapshot-manager.ts`](../src/lib/snapshot/snapshot-manager.ts), [`AutonomousReviewPanel.tsx`](../src/components/chat/AutonomousReviewPanel.tsx).
- **Thinking card + activity stream:** Parse `think` and `redacted_thinking` tag pairs (provider reasoning) in [`AtlarixMarkdownParser.tsx`](../src/components/chat/AtlarixMarkdownParser.tsx); wire `chat:activity` into [`activityStreamItemsAtom`](../src/atoms/sourceAtoms.ts) / [`agentBusRingByChatIdAtom`](../src/atoms/sourceAtoms.ts) from [`useStreamChat.ts`](../src/hooks/useStreamChat.ts); [`ThinkingSection.tsx`](../src/components/chat/ThinkingSection.tsx) — compact multi-agent tool summary and last bus lines; `chatId` on activity payloads in [`chat_stream_handlers.ts`](../src/ipc/handlers/chat_stream_handlers.ts) where needed for routing.
- **Snapshot metadata layout:** Canonical `snapshot_hashes.json` lives under **`.atlarix/snapshots/`** (see [`staleness.ts`](../src/lib/snapshot/staleness.ts)); read path migrates legacy `.atlarix/snapshot_hashes.json`; successful write removes the legacy file.

## v6.2.0 — Unified workspace snapshots + non-destructive revert (2026-04-08)

- **SQLite migration `0035_unified_snapshots_revert`:** `diagram_versions.chat_turn_id`, `diagrams.last_snapshot_hashes`, `messages.is_reverted`; `migration_seed_verification` case; `npm run db:bundle-sql`.
- **Removed internal diagram git:** Deleted `DiagramGitTracker`, `git_change_tracker`, and `simple-git`. Staleness uses `.atlarix/snapshot_hashes.json` + `last_snapshot_hashes` vs live workspace MD5 map.
- **`.atlarix/snapshots/<turnId>/`:** Permission queue captures pre-write file state before approved writes; manifests tie diagram + files for revert.
- **`chat:revert-to-message`:** Restores files + diagram via snapshot manager; sets `messages.is_reverted` instead of deleting messages; removed `diagram:history-from-git` IPC.
- **Diagram history:** SQL `diagram:history` filters out `trigger = auto_sync` noise; version cap (20) via `insertDiagramVersionWithCap`.
- **Blueprint canvas performance:** `BlueprintEdge` uses one SVG `animateMotion` dot per edge (no stacked particles, filters, or extra CSS keyframes on moving dots); `prefers-reduced-motion` disables motion; `onlyRenderVisibleElements` on Blueprint React Flow views.

## v6.1.16 — Diagram stability + Compass context safety (2026-04-08)

- **/diagram Sentry noise:** Normalize `onunhandledrejection` cases where the rejection reason is an `Event` (e.g. script load errors) so telemetry captures actionable details instead of `Error: [object Event]`.
- **Blueprint canvas layout:** Replace grid/ELK with a deterministic **file-tree** layout (top→bottom) based on `room.parentId`/`room.path`.
- **Diagram history restore:** Restoring a previous diagram version refreshes the diagram + history panel immediately.
- **Compass/OpenRouter context safety:** Enable OpenRouter **context compression** as a fallback near the context limit, and hard-cap history to the **last 7 exchanges** when needed.
- **Long-running commands UX:** Terminal-like output now streams into the persistent tool indicator with capped buffers (Errors / Progress / Raw) and throttled UI updates to keep the app responsive.
- **Dev stability polish:** Fix a diagram-panel refresh loop that could spam diagram history updates; ignore `userData/` in Vite dev watch to prevent reload storms; use avatar previews instead of GitHub OpenGraph images to avoid 429 rate limits during template browsing.
- **DevTools noise:** In development, DevTools only auto-opens when `OPEN_DEVTOOLS=1` to avoid noisy Chromium protocol console errors.

## v6.1.15 — Safety: Compass network noise, SQL guards, prompt hygiene, profanity filter (2026-04-07)

- **Compass (`compass_usage.ts`, `network-failure.ts`, `ipc_types.ts`, `useCompassUsage.ts`):** Transient Supabase failures (`fetch failed`, `ECONNRESET`, etc.) return **`reason: "network_error"`** with **`Sentry.captureMessage`** at **warning** instead of **`captureException`**. UI treats offline reachability as transient (not “sign out” / migration copy).
- **SQL execution (`sql-exec-guards.ts`, `supabase_management_client.ts`):** Before **`executeSupabaseSql`** → **`runQuery`**, SQL is normalized (NUL strip, max length), checked for disallowed patterns (e.g. `INTO OUTFILE`), and **single-statement** only (no `;` outside strings except an optional trailing `;`). **`assertSafeReadOnlySql`** / **`assertSafeMutatingSql`** exported for future read-only vs mutating callers.
- **Prompt hygiene (`prompt-hygiene.ts`, `chat-prompt-gate.ts`):** At **`chat:stream`** and chat-only IPC entry — NFC normalize, NUL strip, max length (**200k** chars). Documented as **not** a substitute for execution-boundary checks.
- **Profanity (`bad-words`, `profanity-filter.ts`):** User turns matching the list are rejected with **`SAFETY_FILTER_BLOCKED_MESSAGE`** (`texts.ts`). Assistant text is **`sanitizeAssistantOutput`** after stream (skips **\`\`\` fenced** regions) before DB / ephemeral persistence and before **`processFullResponseActions`**. List-based only — not full moderation.
- **Developer experience:** Added **`tsconfig.main.json`** (extends `tsconfig.app.json`) for `tsc -p tsconfig.main.json`. **`ts:main`** / **`ts:workers`** invoke **`node node_modules/typescript/lib/tsc.js`** instead of **`npx tsc`** to avoid spurious npm config warnings. macOS window controls: **`setWindowButtonPosition`** replaces removed **`setTrafficLightPosition`** typings (Electron 38).

## v6.1.14 — Groq external auto-router classifier, balanced baseline, tier floors (2026-04-07)

- **Groq classifier (`src/lib/routing/groq-classifier.ts`):** Main-process-only `classifyPromptWithGroq()` calls `https://api.groq.com/openai/v1/chat/completions` with JSON-only tier + confidence output. Credentials: `GROQ_CLASSIFIER_API_KEY` and `GROQ_CLASSIFIER_MODEL` (embedded via [`vite.main.config.mts`](../vite.main.config.mts) `MAIN_KEYS`, same pattern as Compass keys). `max_tokens: 30`, `temperature: 0`, **2s** timeout; returns `null` on any failure or if key/model missing. **429** rate limits: `electron-log` message `"Groq classifier rate limited, using fallback"` then `null` (no user toast).
- **Auto router (`src/lib/routing/auto-router.ts`):** Removed heuristic Stage-1 + conditional Stage-2 JSON classifier. New chain: (1) Groq if confidence ≥ **0.65**; else (2) user’s **fast** model with one-word prompt, **1500ms** timeout; else (3) tier **`balanced`** (never default to fast). Then **`applyCeiling`** (unchanged), new **`applyTierFloor`**: autonomous **main** and guided **main** in **plan / build / debug** work modes enforce minimum **balanced**; agents/subagents unchanged. Tier → synthetic `RoutingCategory` for `recommendedAgent` / UI. **`runAutoRouter`** removed; **`runAutoRouterAsync`** returns **`classifierMeta`** `{ tier, confidence, source }`.
- **IPC / Activity Stream (`chat_stream_handlers.ts`, `routing_handlers.ts`):** `routing:preview` uses `runAutoRouterAsync`. When Auto routing runs, emits **`classifier_routing`** activity: `Classifier → [tier] ([pct]%) via [groq|fast-model|fallback]` (percentage omitted when confidence unknown), then existing `routing_decision` line.
- **UI (`sourceAtoms.ts`, `ThoughtsPanel.tsx`):** `ActivityStreamItem` type **`classifier_routing`**; Thoughts panel treats it like routing (Main / right).
- **CI (`.github/workflows/release.yml`):** `GROQ_CLASSIFIER_API_KEY`, `GROQ_CLASSIFIER_MODEL` in workflow `env` for packaged builds.
- **Env (`.env.example`):** Documents Groq classifier variables.

## v6.1.13 — Linux OAuth fallback, theme toggle, contrast fixes, auto-updater in-app UI (2026-04-05)

- **Linux OAuth timeout fallback (`src/lib/auth/supabase-client.ts`):** After `shell.openExternal` succeeds, a 60-second `setTimeout` starts. If the `atlarix://auth/callback` deep link has not fired by then, `dialog.showMessageBox` surfaces the OAuth URL with a **Copy Link** button and (on Linux) the `xdg-mime` registration commands in the detail text. The timer is cleared via `cancelPendingOAuthTimeout()` the moment the callback arrives in `main.ts`.
- **Linux deep-link hint in sidebar (`src/components/app-sidebar.tsx`):** On sign-in failure, Linux users see a dismissable amber notice with the two `xdg-mime` / `update-desktop-database` commands. Platform detected via `IpcClient.getSystemPlatform()`.
- **Theme toggle (`src/pages/settings.tsx`):** `useTheme` + `<Select>` with System / Light / Dark options added to Settings → General after the analytics toggle. Persists via `localStorage.theme` (already handled by `ThemeContext`).
- **Contrast fix — hero glow (`src/pages/atlarix-home.tsx`):** Glow div behind the "Atlarix" gradient heading changed from `to-[#F59E0B]` → `to-[#059669]`, eliminating amber-on-amber background that failed WCAG AA for large text.
- **Contrast fix — panel toggle button (`src/app/layout.tsx`):** Expand/collapse button moved from `top-2 right-2` → `top-3 right-3` to clear the `rounded-lg overflow-hidden` parent's corner clip.
- **Auto-updater in-app UI:** `dialog.showMessageBox` removed from the `update-downloaded` handler in `initAutoUpdater()`. Main process now sends `update:downloading` (on `update-available`) and `update:downloaded` IPC events to the renderer. New `UpdateBanner` component (`src/components/UpdateBanner.tsx`) renders a subtle download strip and a dismissable "Restart Now / Remind me later" banner. "Remind me later" calls `update:defer` IPC → writes `userData/atlarix-pending-update.json`; on next cold start `onReady()` detects the flag, deletes it, and calls `autoUpdater.quitAndInstall()` after the next `update-downloaded` event.
- **AppImage target (`forge.config.ts`, `package.json`):** `@reforged/maker-appimage` added; produces `.AppImage` alongside `.deb` / `.rpm` on Linux builds, enabling `electron-updater`'s native AppImage auto-update.
- **CI — Node 24 migration (`.github/workflows/release.yml`):** `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` env var; `softprops/action-gh-release@v1` → `@v2`; `appimagetool` extraction step added for build-linux; `latest-mac.yml` (arm64 leg only) and `latest-linux.yml` (AppImage SHA-512 + size) generated and uploaded as release assets for `electron-updater` feed.
- **Launchpad hero placeholder (`atlarix-launchpad/src/components/Hero.tsx`):** Chat input placeholder updated to a concrete SaaS-dashboard example prompt.

## v6.1.12 — Mermaid normalize (diagram page + AI output) (2026-04-04)

- **Mermaid:** New [`normalizeDiagramMermaid.ts`](../src/lib/normalizeDiagramMermaid.ts) — strip code fences, standalone `mermaid` lines, `mermaid graph` prefix, normalize `Style` → `style`, scrub corrupted `#hex` tokens on `style` / `linkStyle` / `classDef` lines (Unicode NFKC + zero-width strip). Used by [`sanitizeMermaid`](../src/lib/sanitizeMermaid.ts) for all parse/render paths.
- **Persistence:** [`diagram_handlers.ts`](../src/ipc/handlers/diagram_handlers.ts) and [`DiagramManager.ts`](../src/lib/DiagramManager.ts) save diagrams via **`normalizeDiagramAiOutput`** so DB content is parse-ready (fixes “No diagram type detected” when the model prefixes `mermaid` or omits strict ``` fences).
- **Diagrams page:** [`diagram.tsx`](../src/pages/diagram.tsx) — **`key={selectedDiagram.id}`** on [`MermaidRenderer`](../src/components/MermaidRenderer.tsx) so switching diagrams remounts cleanly; renderer **retries** up to ~12 animation frames if the container ref is not ready (first paint on `/diagram`).
- **Blueprint:** [`mermaid_to_blueprint.ts`](../src/lib/blueprint/mermaid_to_blueprint.ts) uses **`prepareMermaidForParse`** when inferring graph structure.
- **Tests:** [`normalizeDiagramMermaid.test.ts`](../src/lib/normalizeDiagramMermaid.test.ts) (Vitest).

## v6.1.1 — Diagram git ignore, blueprint ELK first paint, dev-server preview (2026-04-04)

- **Diagram git:** [`diagram_git_tracker.ts`](../src/lib/diagram/diagram_git_tracker.ts) — skip `userData` and `.cursor` when mirroring the workspace into the internal diagram repo so `git add` no longer fails with “paths are ignored by .gitignore” when the project contains a `userData` tree.
- **Blueprint:** [`BlueprintCanvas.tsx`](../src/components/preview_panel/BlueprintCanvas.tsx) — ELK layout dedupes only **after** IPC succeeds (`elkCompletedForKeyRef`), clears on structure reset and manual Re-layout, fixing Strict Mode / failed first attempt leaving nodes stacked at `(0,0)`.
- **Preview:** [`PreviewIframe.tsx`](../src/components/preview_panel/PreviewIframe.tsx) — iframe uses **`appUrl ?? devServerUrl`** so managed Next/Vite dev servers show in Preview without dyad proxy `runApp` URL.

---

## v6.1.0 — Main `raw-sql` transform, pivot + prompts migrations (2026-04-02)

- **Build / SQLite:** [`vite.main.config.mts`](../vite.main.config.mts) — **`raw-sql`** plugin uses **`transform`** on `*.sql` (with **`enforce: "pre"`**), emits `export default` string modules. **`assetsInclude` for `.sql` removed** so Vite does not treat SQL as static assets (avoids empty or non-inlined bundles where the transform `id` never matched `?raw`). [`bundled.generated.ts`](../src/db/migrations/bundled.generated.ts) unchanged in workflow: `npm run db:bundle-sql` after journal/SQL edits.
- **Drizzle:** New migration [`0032_pivot_tables.sql`](../drizzle/0032_pivot_tables.sql) — `pivot_nodes`, `pivot_edges`, `pivot_containers`, `pivot_beacons`, `blueprint_snapshots` (journal idx 32; `0033_rename_type_columns` is idx 33). New migration [`0034_prompts_new_schema.sql`](../drizzle/0034_prompts_new_schema.sql) — prompts table migrates to `type`, `workspace_id`, drops legacy `title`/`description` shape. [`migration_seed_verification.ts`](../src/db/migration_seed_verification.ts) updated for `0032` and `0034`.

---

## v6.0.3 — Main Vite `?raw` SQL for embedded migrations (2026-04-02)

- **Build / SQLite:** Superseded by **v6.1.0** (`transform`-based `raw-sql`). v6.0.3 briefly used `assetsInclude` + `load()` with `?raw` path checks.

---

## v6.0.2 — Workforce workspace UI, FallbackModel doGenerate (2026-04-02)

- **Workforce / workspaces:** [`AppList.tsx`](../src/components/AppList.tsx) `canAddWorkspace` now respects `status.canCreateWorkspace` and treats **Workforce** like Pro for the add/import affordance (previously only `plan === 'pro'` was unlimited; Workforce users were incorrectly limited to one workspace in the UI).
- **Diagrams / Auto:** [`FallbackModel`](../src/ipc/utils/fallback_ai_model.ts) implements `doGenerate` by delegating to the current chain model inside the existing `retry` helper, matching `doStream` semantics. Fixes AI diagram generation when Auto wraps models in `createFallback` (`generateText` → `doGenerate`).

---

## v6.0.1 — Reasoning stream closure, thinking-tag hygiene, agent docs (2026-04-02)

- **Streaming (`processStreamChunks`):** Treat `reasoning-end` like other non-reasoning parts so an open stream thinking wrapper is closed; after the stream iterator, flush the matching closing tag if still inside a reasoning block and run a final `processResponseChunkUpdate` + `cleanFullResponse`.
- **Tags / dedupe:** `removeThinkingTags` moved to [`src/ipc/utils/thinking_tags.ts`](../src/ipc/utils/thinking_tags.ts) (strip long- and short-form thinking wrappers). [`cleanFullResponse.ts`](../src/ipc/utils/cleanFullResponse.ts) `deduplicateContent` finds the earliest recognized thinking closing tag after duplicated model output.
- **Tokens:** `getMaxTokensWithFloor` in [`token_utils.ts`](../src/ipc/utils/token_utils.ts) (8192 floor when catalog omits `maxOutputTokens`); main `streamText` uses it for `maxOutputTokens`.
- **Prompt bundle:** `AGENTS.md`, `AGENTS_COMPACT.md` — identity, modes, Compass, delegation, Workforce session scope, 6.0.x version line.

---

## v6.0.0 — Workforce session scope, autonomous agents, UX hardening, Thoughts & routing (2026-04-02)

- **Workforce — Change 1 / 2:** Removed stored “base of origin” / default group-repo-workspace pre-selection for Workforce services; selections are **in-memory per chat** (`workforce-chat-session`, IPC `workforce:session:*`, `WorkforceSessionPromptDialog`). First tool use can prompt for scope; **New Chat** clears session. `buildWorkforceWorkspaceContextBlock` and stream handlers append **Connected workspace contexts (this session only)** to the Workforce prompt block. Token Vault OAuth unchanged.
- **Workforce — gate:** `ToolRegistry` / `runToolExecuteWithWorkforceSessionGate` block Workforce tools until session scope is set where required (`// Fix: Workforce-Change-N` trace comments in touched files).
- **Autonomous — Change 3:** Nested autonomous sub-agents auto-execute permissioned tools (no user queue); `logger.info('[Autonomous] Tool executed without user approval: …')`. Guided delegation permission flow unchanged. Delegation summaries append autonomous tool footers where applicable.
- **Onboarding — Change 4:** Extra steps for chat continuity, right panel resize, autonomous expectations, and session-only Workforce context (`onboarding.ts`, home/settings UI).
- **Tester findings (pre-6.0 pass):** Fullscreen IPC + `data-fullscreen` / layout CSS; pinned New Chat + workforce session clear; code route `file`/`tab` params; Ask/Plan prompts and tool gating (`write_file` Plan-only paths, blueprint tool Ask rules); streaming `chat:stream:phase`, `chat:tool:start/end`, human labels; `models.dev` 30s timeout + Sentry + `models-dev:status` IPC; Compass strip in header + inline milestone banner; `RightPanel` resize grip.
- **UI:** `ThoughtsPanel` from `activityStreamItemsAtom` (guided/autonomous); `ActivityDisplay` wiring; removed legacy `ActivityStream` / `GuidedPipeline` / `AutonomousGraph`; `AppLoadingScreen` + `atlarix-home` loading use `AtlarixAnimation`; canvas `setTransform` reset before `scale`.
- **Auto router:** `runAutoRouterAsync` + optional Stage-2 `classifyAutoRouteWithFastLLM` via `getFastModelForCurrentProvider` in `chat_stream_handlers.ts`; `RoutingDecision.recommendedAgent`; `routing_decision` activity label may include `delegate: …`.
- **Blueprint:** `BlueprintCanvas` overlay controls moved outside ReactFlow `<Panel>` to fix misaligned hit targets on **Re-layout** / **Add container** (and related overlays).
- **Hygiene:** Fixed invalid escaped quotes in `classifyAutoRouteWithFastLLM` (esbuild parse error).

---

## v5.2.3 — Linux launch, OAuth, and local-model reliability (2026-04-01)

- **Linux packaging:** Disabled Chromium sandboxing for packaged Linux builds in `forge.config.ts` and added `x-scheme-handler/atlarix` registration parity for both `.deb` and `.rpm` makers to reduce launch failures and improve deep-link install behavior.
- **OAuth / deep links:** Tightened Linux deep-link handling in `src/main.ts` so `atlarix://auth/callback` can be processed reliably both when an existing app instance receives the callback and when the app is cold-started from the protocol URL.
- **PATH / local models:** Centralized PATH refresh into `src/lib/resolve-path.ts`, reused it from startup and `reload-env-path`, and now show non-blocking warnings when Ollama or LM Studio are unreachable instead of relying on console-only failure paths.

---

## v5.2.2 — Rename reserved `type` columns in SQLite graph tables (2026-04-01)

- **SQLite / PIVOT:** Added migration `0033_rename_type_columns.sql` to rename `pivot_nodes.type` -> `node_type`, `pivot_edges.type` -> `edge_type`, and `diagrams.type` -> `diagram_type`. This fixes production crashes in packaged builds when SQLite prepares queries against those graph/diagram tables (`no such column: "type"` on `/diagram` -> `/tools` flows).
- **Drizzle ORM:** Updated `src/db/schema.ts` and the affected persistence/query code to use `nodeType`, `edgeType`, and `diagramType`, while keeping renderer IPC responses normalized to `diagram.type` for UI compatibility.

---

## v5.2.1 — Supabase OAuth browser-open fallback (2026-03-31)

- **Auth:** `src/lib/auth/supabase-client.ts` now wraps `shell.openExternal()` for Supabase OAuth in a nested `try/catch`, logs success/failure explicitly, and on **Linux** shows a fallback dialog with the OAuth URL plus **Copy Link** when the browser cannot be opened automatically. This avoids silent sign-in failure while leaving the existing `atlarix://auth/callback` deep-link handling unchanged.

---

## v5.2.0 — Embedded SQLite migrations (2026-03-31)

- **SQLite:** Replaced filesystem `drizzle/` + Drizzle `migrate()` with **embedded SQL** in the main bundle (Vite `?raw`, [`src/db/migrations/bundled.generated.ts`](../src/db/migrations/bundled.generated.ts) generated by `npm run db:bundle-sql` / `postdb:generate`). New ledger **`__atlarix_migrations`**; legacy **`__drizzle_migrations`** rows are **bridged** by SHA-256 hash map. **Unknown hashes:** `logger.error` + **Sentry** + thrown `UnknownDrizzleMigrationHashError` (no silent swallow); DB wipe retry is **skipped** for that error. Packaged apps no longer need `drizzle` in Forge `extraResource`; `drizzle/` is excluded from the asar via [`forge.config.ts`](../forge.config.ts) ignore (SQL still lives in repo for Drizzle Kit).
- **Drizzle ORM:** Unchanged for schema types and queries (`schema.ts` untouched).

---

## v5.1.5 — Move ensure* safety nets after migrate() (2026-03-31)

- **Fix:** Moved all `ensure*` table-bootstrap calls (mcp_servers, blueprints, pivot tables, etc.) to run **after** `migrate()` instead of before. On a fresh DB (e.g. after auto-recovery deletes the corrupt one), `ensure*` would create tables like `mcp_servers`, then `migrate()` would fail with `CREATE TABLE mcp_servers` (no `IF NOT EXISTS` in migration SQL). Now `migrate()` runs first on a clean slate, and `ensure*` only fills gaps for legacy DBs afterward.

---

## v5.1.4 — SQLite auto-recovery on bad local DB (2026-03-31)

- **SQLite:** After `migrate()`, the app verifies core tables (`apps`, `chats`, `messages`, `language_model_providers`, `language_models`, `prompts`) and, when bundled migrations are available, that `__drizzle_migrations` exists with at least one row. If validation fails, it closes the DB, deletes `sqlite.db` plus `-wal`/`-shm`, and retries initialization **once** (only when a `drizzle/` folder is found on disk—no infinite wipe if migrations are missing). Fixes partial “bootstrap-only” DBs (e.g. ensure* tables without `chats`). The renderer stays on the existing loading gate until init succeeds.
- **Hygiene:** Removed temporary debug ingest `fetch` calls from `src/db/index.ts`.

---

## v5.1.3 — Packaged app: Drizzle migrations path (2026-03-30)

- **Production:** `drizzle/` is bundled via Electron Forge `extraResource` (unpacked under `Resources/drizzle`) so SQLite migrations are always on a real filesystem path.
- **Runtime:** `resolveDrizzleMigrationsCandidateFolders()` tries `process.cwd()`, `process.resourcesPath`, `app.getAppPath()`, then `__dirname`-relative paths; logs each candidate’s existence and the folder used. Fixes packaged builds where `migrate()` never ran (`no such table: chats`, `language_model_providers`, etc.) while `npm start` worked.

---

## v5.1.2 — Verified Drizzle journal seed + maintainer docs (2026-03-30)

- **SQLite:** `seedDrizzleMigrationsIfNeeded` now inserts `__drizzle_migrations` rows only while each journal migration’s effects are detectable in the DB; `migrate()` applies genuinely pending SQL. Prevents “empty journal + partial schema” installs from skipping migrations and breaking features (`chats`, MCP, etc.). Verifiers live in [`src/db/migration_seed_verification.ts`](../src/db/migration_seed_verification.ts).
- **Docs:** README Development Setup documents the requirement to update `migration_seed_verification.ts` whenever `_journal.json` gains a migration.

---

## v5.1.1 — SQLite MCP tables bootstrap (2026-03-30)

- **SQLite:** `ensureMcpBaseTablesIfNeeded()` creates `mcp_servers` and `mcp_tool_consents` when missing (migration 0012 baseline). Fixes `mcp:list-servers` → `no such table: mcp_servers` when `__drizzle_migrations` was seeded so Drizzle skipped applying migration 0012.

---

## v5.1.0 – Compass, usage limits, onboarding (2026-03-29)

- **Compass:** Managed cloud provider (OpenRouter-backed, single build-time key). Default model **Compass Fast**; Pro/Workforce unlock Balanced and Thinking. OpenRouter removed from user-facing settings and model labels.
- **Supabase:** `compass_tokens` + `get_compass_usage_state` / `record_compass_usage` for monthly token accounting (30-day reset). See `docs/compass-limits.md`.
- **Settings:** Collapsible model-provider grid with search and pagination (Compass pinned on page 1); Compass card shows tier copy and usage bar.
- **Chat:** Usage strip + exhausted state with upgrade / Settings CTAs; milestone toasts at ~50% / 25% / 10% remaining; usage refetches after Compass turns.
- **Onboarding:** Three post-login product steps (Compass → BYOK in Settings); diagram/workspace funnel steps removed from the default tour.
- **CI:** `COMPASS_*` secrets in `release.yml` and `vite.main.config.mts` `MAIN_KEYS` (main process only).

## v5.0.0 – Blueprint context & memory (2026-03-26)

- **Tiered Blueprint prompt injection (Sections 1, 3, 4):** Blueprint context is now routed through `blueprintPromptTiers.ts` with explicit Ask / Plan / Build / Debug tiers. Settings and the chat Config dropdown can force a tier per session, and Auto mode falls back to heuristics based on work mode and prompt.
- **Project memory & snapshots (Section 2):** New `project_snapshots` and `project_memory` tables (migration `0031_project_memory.sql`) plus `ensureProjectMemoryTablesIfNeeded` in `db/index.ts`. Snapshots track blueprint + plan state across sessions; tools (`get_project_history`, `set_project_memory`, `revert_to_snapshot`) expose this to the AI with an approval-gated `revert_project_snapshot` action.
- **`.atlarixignore` end‑to‑end:** Gitignore-style patterns are respected in RTE parsing, Blueprint cache loading, and prompt assembly. A default `.atlarixignore` is created on first parse; `get_atlarixignore` / `update_atlarixignore` tools and the Blueprint panel editor keep AI context bounded to relevant files.
- **Work modes + Auto routing:** Ask / Plan / Build / Debug / Review work modes now bind cleanly to Blueprint tiers and model routing. Auto decides between Fast / Balanced / Thinking based on mode/role, while manual mode selection and overrides still work as before.
- **MCP server tier gating:** MCP free-tier limits now respect the authenticated subscription (via `SubscriptionManager.isPro()` and `useAuth().status.plan`) instead of raw credit budget, so Pro/Workforce users can add multiple MCP servers without seeing the “Free tier is limited to 1 MCP server” banner.
- **Auto model configuration UX:** Auto mode lets you pick one provider and up to three models (Fast / Balanced / Thinking). The Config dropdown seeds tiers from provider favorites, supports 1–3 configured tiers, and uses an ordered fallback chain when a model fails.

---

For detailed historical notes (v1.x–v4.x) and implementation phases, see [`docs/previous-versions.md`](previous-versions.md) and the v5.0 tables in [`docs/TODO.md`](TODO.md).

## Atlarix product summary (for model and blueprint accuracy)

- **PIVOT:** From Code to Canvas, Canvas to Code. **Containers** and **Beacons** are the main diagram concepts. The **Blueprint** is the living diagram (RTE + RAG). **RTE** (Round-Trip Engineering): parsers (TypeScript, Python) extract structure; single and **combined blueprints**; diagram types: architecture, dependencies, flows. **RAG:** queryBlueprint, getCodeForNodes; file watcher for incremental updates.
- **Modes:** **Ask** = read-only (code search, web search, read_file, list_files, get_diagram, git_status; no terminal, no code gen/modification). **Build** = full tools (run_command, write_file, delete_file, etc.). Permission flow: user approves before execution.
- **Agents:** Research, Architect, Builder, Reviewer. Delegation: **Guided** (flat) or **Autonomous** (nested, depth limit). Model tiers: **Fast** / **Balanced** / **Thinking** (e.g. OpenRouter favorites); Auto routes by mode/role.
- **Workspace:** `.atlarix/memory.md`, `.atlarix/spec.md`; project instructions; token budget per provider; context bar + auto-summarize.

---

## v4.3.0 — UX and workflow update (2026-03-23)

### Added

- **Batch workforce permissions:** New `request_workspace_permissions(services[])` flow opens one unified Token Auth panel for multi-service access.
- **Ollama recommender panel:** Hardware-aware model recommendations with one-click pull and quick model selection in provider settings.

### Changed

- **Workforce Ask/Build behavior:** Ask mode is strictly read-only for Workforce tools; write/trigger actions are Build-only with approval.
- **Ask-mode planning:** ATLARIX plan-writing tools are available in Ask mode with approval, while code changes remain Build-only.
- **Release docs and metadata:** README/TODO/changelog/version metadata aligned to the 4.3 release.

### Fixed

- **Session persistence:** Secure auth session restore and refresh on startup, plus explicit logout secret clearing.
- **Subscription UX:** Correct active vs cancelled-within-period vs expired messaging and entitlement timing.
- **Token Auth lifecycle:** New chat clears prior Token Auth sessions and exposes connected-service indicators in chat UI.

---

## v4.2.0 — Bug fixes and security (2026-03-18)

### Improvements

- **Easier onboarding**: Sign-in and “Skip” buttons are now fully visible and no longer hidden under the window controls, so you can get started without any hassle.
- **More secure and stable**: The app now uses a simpler, more secure sign-in flow and has removed legacy backend pieces for a more reliable experience.
- **Under the hood**: Updated integrations and stability improvements across the app for better compatibility.

---

## v4.0.0 — Workforce (2026-03-16)

### Added

- **Workforce tier** ($79/mo): Up to 5 seats; extra seats $10/mo. Teams, Token Vault, Workspace Context, and all Workforce extensions.
- **Auth0 Token Vault**: Secure agent authentication; step-up for high-stakes actions; fallback to stored credentials when vault unavailable.
- **Workspace Context** (Workforce only): Injected block after system prompt with open PRs, failing pipelines, assigned tickets, unread mentions, Sentry errors, today's meetings from connected extensions.
- **Teams**: Create team, invite members, manage seats; shared .atlarix (team-memory.md, Blueprint) via Git; effective tier = max(own plan, team plan).
- **Workforce extensions**: Slack, Google Chat, Jira, Linear, Sentry, Notion, Google Calendar, GitLab CI, Bitbucket Pipelines — connect via Token Vault.
- **Progressive Tool Reveal**: Tool manifest (one line per tool) in system prompt; full schemas loaded on first use; core tools always loaded.
- **New AI tools**: get_slack_mentions, get_slack_channel, post_to_slack; get_assigned_tickets, update_ticket_status, create_ticket, get_sprint_status; get_sentry_errors, get_sentry_error_detail; get_today_schedule; trigger_pipeline, cancel_pipeline. Read-only in Ask mode; write/trigger with approval in Build.
- **GitLab CI & Bitbucket Pipelines**: CIPlatform implementations using Token Vault; list runs, jobs, logs, stream.
- **Conversation rollback** *(superseded in v6.2.0 by unified snapshots):* Earlier releases restored file state from a snapshot tied to a chat turn. **Current behavior (v6.2.0+):** restore files and diagram from `.atlarix/snapshots/`; the full transcript stays visible with `is_reverted` markers — messages are not deleted. **Hash metadata (v6.2.1+):** `snapshot_hashes.json` is stored under `.atlarix/snapshots/` with one-time migration from the legacy root `.atlarix/snapshot_hashes.json`.

### Changed

- **DB Studio** moved from Pro to Workforce; existing Pro subscribers grandfathered (has_db_studio_legacy).
- **Pricing**: Three tiers — Free ($0), Pro ($19/mo), Workforce ($79/mo).
- **Build mode tools**: Manifest includes all tools; progressive reveal filters full schemas to loaded + core.

### Technical

- Drizzle migrations: teams, team_members, users.team_id, users.effective_tier, users.has_db_studio_legacy; workforce_connected_services; tool_session_loads.
- Supabase migrations and RLS for teams.
- LemonSqueezy webhook extended for Workforce and teams (idempotent).
