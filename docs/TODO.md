# Atlarix TODO

**Current Version:** v8.2.0
**Last Updated:** 2026-05-11

---

## Shipped in v8.2.0

- **oxc packaging:** Platform `@oxc-parser/binding-*` restored after Forge prune (`forge.config.ts`).
- **Parser worker pool:** `parser_worker.js`, `parser-pool.ts`, shutdown on quit.
- **WASM RTE:** `wasm-extract.ts` for Python/Go/Rust; wired in language parsers; grammars in `extraResources`.
- **CI:** `npm test` + `bench-parsers.ts` before release builds.

See [CHANGELOG.md](CHANGELOG.md) `[8.2.0]`.

---

## Shipped in v8.1.0 — Pass 6

| Area | Status | Notes |
|------|--------|-------|
| Blueprint restoration (lazy) | **Done** | Schema + IPC + `get_blueprint` + canvas gate + `search` structural; pivot TS stubs |
| Unified `search` | **Done** | Replaces `search_code` / `find_relevant_files` in registration; manifests + mode consistency test |
| Streaming + list virtualization | **Done** | Throttled `setMessagesById`, `MessagesList` virtualizer, post-stream trim |
| Right panel / dev server UX | **Done** | No auto-open for diagram/blueprint streams; `DevServerProvider` no auto-start / no auto panel |
| Tool merges (Pass 6 set) | **Done** | `get_diagram`, `check_environment`, `get_file_outline`+stats, `run_tests`+path, `git_status`+session, `live_preview`+`port_only`, `get_project_history`+`revert_to`, `request_tools` text |
| Diagram references | **Done** | `get_diagram` `role`; `diagramReferencesAtom` + chips in `DiagramPanel`; diagrams page chat-driven |
| PDF worker | **Done** | `attachment-tools` `workerSrc ''` |
| Pass 7 carryovers | **Done** | MCP on-demand, skills tools, `<mode_system>` / `modeAllowlist`, `edit_file` / `memory` / `diagnose_issue` consolidation (see CHANGELOG Pass 7 section for detail) |

See [CHANGELOG.md](CHANGELOG.md) Pass 6 + Pass 7 entries for `[8.1.0]`.

---

## Shipped in v8.1.0 — Pass 7 (intermediate branch; partially superseded)

| Area | Status | Notes |
|------|--------|-------|
| Blueprint subsystem removal | **Superseded by Pass 6** | Pass 6 restored Blueprint; ignore this row for current behavior |
| Tool consolidation (~60 → ~28) | **Partial** | Pass 6 adds `search` naming and tool merges listed above; `edit_file` / `memory` / etc. remain |
| MCP scoping rework | **Done** | `list_available_mcps` + `mcp_call`; workspace MCPs no longer force-merged |
| Skills via ToolRegistry | **Done** | `get_active_skills` + `list_installed_skills`; removed `if(false)` injection block |
| `<mode_system>` prompt block | **Done** | `system_prompt.ts` + `chat_only_handlers.ts`; smoke test in `mode_system_consistency.test.ts` |
| Migration 0043 | **Superseded** | Pass 6 reverted drop migration where applicable; follow bundled SQL in repo |
| Dependency audit | **Partial** | `@xyflow/react` + `elkjs` restored for Blueprint UI; tree-sitter packages may remain absent (stubs) |
| Tool count log | **Done** | `initializeTools()` logs sorted registered tool list at startup |

See [CHANGELOG.md](CHANGELOG.md) `[8.1.0]`.

---

## Shipped in v8.0.3

| Area | Status | Notes |
|------|--------|-------|
| OpenRouter BYOK | **Done** | Provider + model fetch + `get_model_client`; Compass unchanged; settings migration (openrouter→compass) removed |
| Packaging (tiktoken / pdfjs / prune install) | **Done** | `vite.main.config.mts` externals; `forge.config.ts` ignore + `packageAfterPrune` npm roots |
| Package build heap | **Done** | `cross-env NODE_OPTIONS=--max-old-space-size=8192` on package/make/publish |
| Quit lifecycle logs | **Done** | `main.ts` `[lifecycle]` memory on `before-quit` / `will-quit` |

See [CHANGELOG.md](CHANGELOG.md) `[8.0.3]`.

---

## Shipped in v8.0.1

| Area | Status | Notes |
|------|--------|-------|
| Tool contract / availability honesty | **Done** | Agent prompt layer aligned so registered tools are not reported as missing |
| Model-triggered compaction | **Done** | `compress_context` tool; pre-dispatch stepped summarize path gated (PASS2 markers in `chat_stream_handlers.ts`, `chat_only_handlers.ts`) |
| Streaming terminal / `chat:response:end` | **Done** | Idempotent end events across stream paths |
| Macro tools | **Done** | `get_workspace_overview`, `read_attachment_summary` |
| BYOK error classification + banners | **Done** | `classifyProviderError` + actionable UI |
| Skills Marketplace | **Done** | Registry IPC, DB migration `installed_skills`, Settings UI, Pro/Workforce gating |
| Pre-dispatch context cleanup (PASS5) | **Done** | Blueprint/skills/Supabase/diagram prefix/workforce analysis/project memory gated or disabled; session memory char cap |
| Explore subagent | **Done** | `delegate_to_agent` explore path; read-only tool set |
| OpenRouter app headers | **Done** | `X-Title`, `HTTP-Referer` on SDK + fetches (`get_model_client`, `openrouter_api`, `tier-context-limits`, `openrouter-provider`) |
| Tool spinner reconciliation | **Done** | `AtlarixMarkdownParser` stream-end handling |
| Debug instrumentation removal | **Done** | `debugLog` / `hypothesisId` removed from chat stream |

See [CHANGELOG.md](CHANGELOG.md) `[8.0.1]`.

---

## Open / follow-ups (codebase markers)

| Area | Status | Notes |
|------|--------|--------|
| Env secret paths in more readers | **Open** | Extend `isEnvSecretPath` to `view_symbol`, `get_file_outline`, `find_files`, `search_code`, renderer `file:read-content` IPC (see v7.0.4 table below) |
| `main.ts` | **Open** | `TODO: Phase 4.5` — Neon/Supabase OAuth integrations removed; follow-up cleanup |
| `cleanup_jobs.ts` | **Open** | `TODO:` integrate real summarization model for cleanup jobs |
| `github_handlers.ts` | **Open** | `TODO:` fetch config securely (env / secrets) |
| `SliceExtractorAgent.ts` | **Open** | `TODO:` TensorFlow semantic scoring |
| `UpgradePrompt.tsx` | **Open** | `TODO:` checkout with pre-filled email |
| `home.tsx` | **Open** | `TODO:` template browser |
| `ModelSelector.tsx` | **Open** | `TODO:` live lists from OpenRouter / Ollama / LM Studio APIs |
| `TelemetryBanner.tsx` | **Open** | `TODO:` banner state + Accept / Reject / Later |
| `MainLayout.tsx` | **Open** | `TODO:` AI backend wiring |
| `CapacitorControls.tsx` | **Open** | `TODO:` help link |
| `supabase_context.ts` | **Open** | `TODO:` edge functions + secrets in context |

**Note:** `PASS2` / `PASS5` comments in [`chat_stream_handlers.ts`](../src/ipc/handlers/chat_stream_handlers.ts) document intentional gating from the v8.0.1 context pass — not pending tasks.

---

## Shipped in v7.1.2

| Area | Status | Notes |
|------|--------|-------|
| Counsel live thinking | **Done** | `counsel_thinking` activity type; `streamText` + `fullStream` iteration; reasoning deltas emitted every 1.5s as "Analyzing: [snippet]" |
| Delegation visibility | **Done** | `onToolIndicator` listener in `useStreamChat`; `tool_use` activity items for tool start/end in ThoughtsPanel |
| Tool completion for empty results | **Done** | "✓ Done" shown automatically for all tool completions via activity stream |
| Tool output cache at execution time | **Done** | `ToolOutputCache` integrated into `ToolRegistry.execute()`; outputs >10KB cached to disk with 7-day retention |
| File/image attachments (non-workspace) | **Done** | Attachment support extended to chat-only mode in `chat_only_handlers.ts`; vision capability check for image processing |
| PTY support | **Done** | `src/lib/pty-utils.ts` with `@lydell/node-pty`; interactive shell in Build/Debug; graceful fallback to pipes on failure |
| Blueprint file watcher | **Done** | Uses Node.js `fs.watch` with 500ms debounce; incremental cache updates |

See [CHANGELOG.md](CHANGELOG.md) v7.1.2.

---

## Shipped in v7.1.1

| Area | Status | Notes |
|------|--------|--------|
| No-workspace CTA after first user message | **Done** | `ChatInputControls`: hide `NoWorkspaceBanner` when thread has a user turn (`chatMessagesByIdAtom` + `chatId` / `selectedChatId`); `HomeChatInput` / `SimpleChatInput` pass `chatId` |

See [CHANGELOG.md](CHANGELOG.md) v7.1.1.

---

## Shipped in v7.1.0

| Area | Status | Notes |
|------|--------|--------|
| DelegationMonitor + `delegation_abort` | **Done** | Sliding-window cyclic/runaway delegate detection; corrective bus signals; wired next to loop-break in autonomous stream |
| Bus `modelId` / `responseMs` | **Done** | Optional fields on messages + IPC + Thinking / ring UI |
| Counsel completion-driven + 7 min cap | **Done** | `COUNSEL_TIMEOUT_MS`, `allSettled`, duplicate timeout races removed; partial counts on timeout activity |
| Mermaid prompt rules + friendly error UI | **Done** | Shared CRITICAL rules module; renderer retry + user-facing copy |
| OAuth step labels + LoadingBar | **Done** | `useAuth` + sign-in / `SignInScreen` |
| Workspace onboarding CTA | **Done** | `NoWorkspaceBanner` + `ChatInputControls` open-folder flow |
| Diagram panel Generate UX / TSC / logs | **Done** | Empty-state ordering, all modes diagram AI, tsconfig skip, log noise reduction |

See [CHANGELOG.md](CHANGELOG.md) v7.1.0.

---

## Shipped in v7.0.4

| Area | Status | Notes |
|------|--------|--------|
| Chat Config dropdown viewport / clipping | **Done** | `ChatConfigDropdown`: `side="bottom"` + `avoidCollisions={false}` (always below trigger, away from prompt); Radix available-height clamp + inner scroll; remove `max-h-[70vh]` and manual side flip; `collisionPadding` 12 |
| `read_file` + codebase: block / omit `.env*` secret paths | **Done** | `src/lib/security/env-secret-paths.ts`; `file-tools.ts` `read_file`; `codebase.ts` `shouldReadFileContents*` |
| Follow-up: extend env denylist to other file readers | **Open** | `view_symbol`, `get_file_outline`, `find_files`, `search_code`, renderer `file:read-content` IPC — same `isEnvSecretPath` pattern |

See [CHANGELOG.md](CHANGELOG.md) v7.0.4.

---

## Shipped in v7.0.5

| Area | Status | Notes |
|------|--------|--------|
| Auto-update (macOS ZIP feed) | **Done** | Release now publishes a notarized/stapled `.zip` of the `.app`; `latest-mac.yml` points to ZIP first (required by `electron-updater`) |
| Linux updates for all installs | **Done** | AppImage: silent auto-update stays on. `.deb`/`.rpm`: show native notification with one-click download link to the latest release |

See [CHANGELOG.md](CHANGELOG.md) v7.0.5.

---

## Shipped in v7.0.3

| Area | Status | Notes |
|------|--------|--------|
| OAuth: open in system browser + timeout fallback | **Done** | `shell.openExternal`, 60s “Sign-in not completing?” dialog; Linux copy-link fallback; cancel timeout on deep-link callback |
| Dark mode button/toggle affordance | **Done** | Dark tokens + outline/ghost button surfaces + switch borders so controls read as clickable |
| Sign-in free tier copy aligned to pricing | **Done** | One workspace; starter included usage; BYOK/local models; no credit card |

See [CHANGELOG.md](CHANGELOG.md) v7.0.3.

---

## Shipped in v7.0.2

| Area | Status | Notes |
|------|--------|--------|
| Tool strip labels + lifecycle | **Done** | `ToolIndicator` / `toolId` / stream `done` phase; submit→stream-end visibility |
| Autonomous + counsel strip overrides | **Done** | Activity + `counsel_start`/`counsel_end` stream phases |
| Deep think → Counsel fallback | **Done** | `hasNativeDeepThinkingSupport`, `deep_think_fallback`, chat-only parity |
| Turn artifact cards | **Done** | `completedTurnArtifactsByAssistantMessageIdAtom`, `TurnArtifactsCards` |

See [CHANGELOG.md](CHANGELOG.md) v7.0.2.

---

## Shipped in v7.0.1

| Area | Status | Notes |
|------|--------|--------|
| `deep_research` ResearchLedger loop | **Done** | `web-tools.ts`: agentic iterations, coverage / empty / max stops; internal aggregator search + fetch + BM25 extract; model-facing `formatResultForModel`; logging |
| Chat-only deep + `web_search` gate removed | **Done** | `chat_only_handlers.ts`: no supplementary cap / overlap skip |
| Web search snippet filter | **Done** | `filterRelevantResults` threshold 0.25 |
| Deep research answered threshold | **Done** | Relevance score > 0.35 → `answered` |

See [CHANGELOG.md](CHANGELOG.md) v7.0.1.

---

## Shipped in v7.0.0

Includes everything previously tracked as **Project Vanguard / v6.5.0**, now released as **Atlarix v7**:

| Area | Status | Notes |
|------|--------|--------|
| Living plan + `plan-sync` | **Done** | Ledger-driven `ATLARIX_PLAN.md`, archive under `.atlarix/plans/archive/` |
| `parsePlanToSteps` checkboxes | **Done** | `[ ]` / `[~]` / `[!]` / `[x]`; skip `[x]` for seeding |
| Auto memory `writeToFile` + turn tools | **Done** | Schema, settings, per-turn tool list for bullets |
| Counsel IPC + `abortSignal` | **Done** | `counsel:start` / `cancel`, discrete events, preload + client |
| Build verification ledger safety | **Done** | `depth: 1`, `recordOnParentLedger: false` verified |
| Migration / journal audit | **Done** | Through 0040 + seed verification |
| Plan viewer UI + `chat:plan-update` | **Done** | Task ledger card in chat; `plan_created` activity row |

See [CHANGELOG.md](CHANGELOG.md) v7.0.0.

---

## Next / follow-ups

- [ ] **Python LSP support** (v7.2.0)
- [ ] **PTY default on** (v7.2.0, after stability testing)
- [ ] **Windows code signing** (when revenue covers it) — EV/OV Authenticode for SmartScreen-friendly builds
- [ ] **AgentSonar:** Pure JS or WASM SDK when upstream ships it — until then HTTP sidecar remains optional/dev
- [ ] **Counsel:** Richer **partial-timeout UI** (surface incomplete roster inline beyond activity payload)
- [ ] Blast radius analysis using Blueprint edges before agent acts
- [ ] Skills marketplace — community skill files from atlarix.dev
- [ ] Additional tree-sitter languages: Go, Rust, Java, C#
- [ ] Mobile companion (iOS/Android) for reviewing and approving agent changes remotely

---

## Ongoing

- Telemetry and Sentry hygiene for diagram / stream edge cases.
- Documentation alignment with each tagged release (README + launchpad + in-app copy).
- Provider catalog and African-provider integration roadmap (see public messaging on [atlarix.dev](https://atlarix.dev)).

---

## Done: v6.2.2 — Tier-aware Compass context + pre-dispatch budgeting

| Area | Status | Notes |
|------|--------|--------|
| OpenRouter tier limits + cache | **Done** | `tier-context-limits.ts`; warm on startup; keyed cache |
| Pre-dispatch budget + routing helpers | **Done** | `tier_context_budget.ts`, `context_budget_routing.ts`; Fast skipped |
| OpenRouter safety for BYOK + tier gate | **Done** | `needsOpenRouterContextSafety`; balanced/thinking only |
| Compaction summarize reuse | **Done** | `summarizeMessagesWithCompactionPrompt` |

See [CHANGELOG.md](CHANGELOG.md) v6.2.2.

---

## Done: v6.2.1 — Autonomous session polish + Thinking UI + snapshot hash path

| Area | Status | Notes |
|------|--------|--------|
| Autonomous bus / review / IPC | **Done** | Session-complete, revert-op, accept-all; review panel; snapshot revert per turn |
| Thinking / activity | **Done** | `think` / `redacted_thinking` in markdown parser; activity + bus ring wired with `chatId` |
| `snapshot_hashes.json` migration | **Done** | Canonical path under `.atlarix/snapshots/`; legacy root file migrated then removed |

See [CHANGELOG.md](CHANGELOG.md) v6.2.1.

---

## Done: v6.2.0 — Unified snapshots + non-destructive revert

| Area | Status | Notes |
|------|--------|--------|
| Migration 0035 + seed verification | **Done** | `chat_turn_id`, `last_snapshot_hashes`, `is_reverted` |
| Remove DiagramGitTracker / simple-git | **Done** | Staleness + `.atlarix/snapshot_hashes.json` |
| Permission capture + `revertSnapshot` | **Done** | `chat:revert-to-message` repurposed |

See [CHANGELOG.md](CHANGELOG.md) v6.2.0.

---

## Done: v6.1.16 — Diagram stability + Compass context safety

| Area | Status | Notes |
|------|--------|--------|
| /diagram Sentry noise fix | **Done** | Normalize `onunhandledrejection` Event reasons; capture actionable details |
| Blueprint file-tree layout | **Done** | Replace grid/ELK with top→bottom file-tree layout |
| Diagram restore refresh | **Done** | Restore version triggers diagram + history refresh |
| Compass context safety | **Done** | OpenRouter context compression fallback; last-7 exchanges safety cap |

See [CHANGELOG.md](CHANGELOG.md) v6.1.16.

---

## Done: v6.1.15 — Safety: Compass network, SQL guards, prompt hygiene, profanity filter

| Area | Status | Notes |
|------|--------|--------|
| Compass transient network | **Done** | `network_error` + quieter Sentry; `useCompassUsage` copy |
| SQL exec guards | **Done** | `sql-exec-guards.ts`; `executeSupabaseSql` before `runQuery` |
| Prompt hygiene + profanity | **Done** | IPC gate; `bad-words` input reject + output sanitize |
| DX / tooling | **Done** | `tsconfig.main.json`; `node …/tsc.js` for `ts:main` / `ts:workers`; `setWindowButtonPosition` |

See [CHANGELOG.md](CHANGELOG.md) v6.1.15.

---

## Done: v6.1.14 — Groq external auto-router classifier, balanced baseline, tier floors

| Area | Status | Notes |
|------|--------|--------|
| Groq tier classifier (`groq-classifier.ts`) | **Done** | `GROQ_CLASSIFIER_API_KEY` + `GROQ_CLASSIFIER_MODEL`; 2s timeout; 429 → log + fallback |
| Auto router fallback chain | **Done** | Groq (≥0.65) → fast model one-word (1.5s) → balanced; `applyTierFloor` after ceiling |
| Activity Stream classifier line | **Done** | `classifier_routing` + ThoughtsPanel |
| CI / Vite MAIN_KEYS | **Done** | `release.yml`, `vite.main.config.mts` |

See [CHANGELOG.md](CHANGELOG.md) v6.1.14.

---

## Done: v6.1.13 — Linux OAuth fallback, theme toggle, contrast fixes, auto-updater in-app UI

| Area | Status | Notes |
|------|--------|--------|
| Linux OAuth timeout fallback | **Done** | 60s `setTimeout` in `supabase-client.ts`; `cancelPendingOAuthTimeout()` in `main.ts` deep-link handler |
| Linux deep-link hint in sidebar | **Done** | `app-sidebar.tsx` — platform detection + dismissable `xdg-mime` notice on sign-in failure |
| Theme toggle | **Done** | Settings → General; `ThemeContext` persistence |
| Contrast / hero / panel | **Done** | `atlarix-home.tsx` glow; `layout.tsx` panel button position |
| Auto-updater in-app UI | **Done** | `UpdateBanner`; `update:defer` / cold-start install path |
| AppImage + CI Node 24 | **Done** | `forge.config.ts`, `release.yml`, feed assets |

See [CHANGELOG.md](CHANGELOG.md) v6.1.13.

---

## Done: v6.1.12 — Mermaid normalization, diagram page render

- See [CHANGELOG.md](CHANGELOG.md) v6.1.12.

## Done: v6.1.1 — Diagram git, blueprint layout, preview URL

| Area | Status | Notes |
|------|--------|--------|
| DiagramGitTracker | **Done** | Ignore `userData`, `.cursor` in workspace walk |
| Blueprint ELK | **Done** | Complete ref + reset / Re-layout clears |
| Live preview | **Done** | `devServerUrlAtom` fallback in `PreviewIframe` |

See [CHANGELOG.md](CHANGELOG.md) v6.1.1.

---

## Done: v6.1.0 — SQL inlining, pivot + prompts migrations

| Area | Status | Notes |
|------|--------|--------|
| Vite main `.sql` | **Done** | `vite.main.config.mts` — `raw-sql` `transform` + `enforce: "pre"` (no `assetsInclude`) |
| Drizzle | **Done** | `0032_pivot_tables`, `0034_prompts_new_schema`; journal + `migration_seed_verification` + `db:bundle-sql` |

See [CHANGELOG.md](CHANGELOG.md) v6.1.0.

---

## Done: v6.0.3 — Main bundle SQL ?raw

| Area | Status | Notes |
|------|--------|--------|
| Vite main `*.sql?raw` | **Done** | Superseded by v6.1.0 transform-based `raw-sql` |

See [CHANGELOG.md](CHANGELOG.md) v6.0.3.

---

## Done: v6.0.2 — Workforce UI + diagram Auto

| Area | Status | Notes |
|------|--------|--------|
| Workforce add-workspace UI | **Done** | `AppList.tsx` — `canCreateWorkspace` + Pro/Workforce |
| FallbackModel `doGenerate` | **Done** | `fallback_ai_model.ts` — `generateText` / diagram AI with Auto chain |

See [CHANGELOG.md](CHANGELOG.md) v6.0.2.

---

## Done: v6.0 — Workforce session scope, agents, UX

| Area | Status | Notes |
|------|--------|--------|
| Workforce session workspace selection | **Done** | In-memory per `chatId`; IPC + dialog; cleared on New Chat; prompt injection block |
| Remove base-of-origin Workforce settings layer | **Done** | No persisted default repo/channel/workspace for tools |
| Autonomous permission bypass (sub-agents) | **Done** | Guided unchanged; audit log line; summaries |
| Tester findings batch | **Done** | Fullscreen, chat, modes, streaming/models.dev, Compass UI |
| Thoughts + Compass loading + Blueprint hitboxes | **Done** | `ThoughtsPanel`, `AtlarixAnimation`, `BlueprintCanvas` overlays |
| Two-stage auto-router + delegation hint | **Superseded (v6.1.14)** | Groq + fast-model fallback + tier floors; see `auto-router.ts`, `groq-classifier.ts` |

See [CHANGELOG.md](CHANGELOG.md) v6.0.0 for file-level detail.

---

## Done: v5.1 — Compass & limits

| Area | Status | Notes |
|------|--------|--------|
| Compass provider + tier gating | **Done** | `compass_constants.ts`, `get_model_client.ts`, Free = Fast only; Pro/Workforce fallback chain |
| Supabase migration + docs | **Done** | `20260329120000_compass_tokens.sql`, `docs/compass-limits.md` |
| Settings UI + usage | **Done** | Collapsible providers, Compass page, `useCompassUsage` |
| Chat usage + block + toasts | **Done** | IPC bump after stream, `useCompassSendGate`, banners/strip |
| Onboarding 3-step | **Done** | `onboarding.ts`, home/settings banners, progress bar |
| CI env | **Done** | `release.yml`, `vite.main.config.mts` MAIN_KEYS |

### v5.1.1 patch (2026-03-30)

- MCP: `ensureMcpBaseTablesIfNeeded` in `db/index.ts` before `fixMcpServersSchemaIfNeeded` (see `docs/CHANGELOG.md`).

### v5.1 follow-ups

- Chat-only ephemeral streams do not yet record Compass usage RPC (main workspace path does).
- Optional: centralize Compass usage in a single Jotai atom to avoid duplicate fetches if multiple panes mount usage hooks.

---

## Done: v5.0 — Blueprint context, memory, ignore

| Area | Status | Notes |
|------|--------|--------|
| **S1** Tiered Blueprint injection + Build RAG cap | **Removed v8.1.1** | `blueprintPromptTiers.ts` deleted — Blueprint is tool-driven only (`get_blueprint`) |
| **S1** Blueprint-first empty state | **Done** | Plan/Build tiers inject blocker when Blueprint has no nodes |
| **S2** Schema + migration + bootstrap | **Done** | `project_snapshots`, `project_memory`; `0031_project_memory.sql`; `ensureProjectMemoryTablesIfNeeded` in `db/index.ts` |
| **S2** Snapshots + pruning | **Done** | Max 100 rows/workspace; triggers: debounced blueprint change, plan file write, build-complete (Agent/Build + files), `session_end` on quit for touched workspaces |
| **S2** Session system prompt injection | **Done** | `buildProjectMemoryPromptBlock` in `chat_stream_handlers.ts` |
| **S2** Tools | **Done** | `get_project_history` (with `revert_to` for `revert_project_snapshot` approval), `set_project_memory` |
| **`.atlarixignore`** | **Done** | `ignore` npm package; filter at RTE (`generateBlueprint`), cache load (`inferBlueprint`), prompt (`buildBlueprintSystemPromptInjection`); `atlarixIgnoreSource` on cache; default file on first parse; `get_atlarixignore` / `update_atlarixignore`; Blueprint panel + IPC get/set |
| **S3** Explicit Blueprint tier from Settings | **Done** | `blueprintInjectionModePreference` (Auto \| Ask \| Plan \| Build \| Debug); plumbed via `streamMessage` → `chat:stream`; precedence: IPC `blueprintInjectionMode` then preference then heuristics; optional `blueprintDebugTrace` / `blueprintDebugFile` in settings + `ChatStreamParams` for Debug tier |
| **S4** Chat session override for Blueprint tier | **Done** | Config dropdown → **Blueprint in prompt**: Use Settings or force Ask/Plan/Build/Debug; `blueprintInjectionChatOverrideAtom` merged in `useStreamChat` before Settings preference |
| **Work modes** Ask / Plan / Build / Debug / Review + Auto | **Done** | `workModePreference` in settings; maps to `selectedChatMode` + Blueprint tier via `src/lib/work-mode.ts`; `useStreamChat` precedence: chat override → work mode (non-Auto) → settings; `ChatIntentSelector` + context bar; duplicate Ask/Build removed from `ChatModeSelector` |
| **Subscription Realtime dedupe** | **Done** | Material-change gate in `supabase-client` `subscribeToPlanChanges`; serialized setup + fingerprint dedupe in `SubscriptionManager.setupRealtimeSubscription` |
| **S5a** Agent–mode foundation | **Done (kickoff)** | `debugger` in `builtin` / `agent-bus` / `delegate_to_agent`; `work-mode-agents.ts` (default agent + `workModeSystemHint`); stream injects hint after base prompt in `chat_stream_handlers.ts` |
| **S5b** Structured handoffs | **Done** | Structured payloads validated via `agent-handoff-schemas`; `HandoffResultCard` renders isolated blocks in parent thread (collapsed by default). |
| **S5c** Handoff polish | **Done** | Superseded: bus emits typed `task_assign` / `task_result` activity events; autonomous review panel provides post-run collapsible handoff summary; `HandoffResultCard` provides inline preview. |
| **S6** Structured outputs per mode | **Done** | Delegate/handoff schema validation + one retry; Plan/Debug/Review stream validation + warning fallback; structured report rendering for supported mode outputs |
| **S7** ContextAssembler | **Done** | `src/lib/context/ContextAssembler.ts` + `context-assembly-cache.ts`; deterministic section ordering, per-mode caps (Review: 2000), low-priority-first trimming, cache hit/miss + trim diagnostics in stream logs |
| **S7** Tiered discovery flow + folder tooling | **Done** | Added `explore_folder` (structured directory exploration with `.atlarixignore` filtering), `get_blueprint_slice` (targeted architecture slices), and conditional diagram-prefix messaging to prevent synthetic context claims |

### v5.0 follow-ups / incomplete

- **S5b / S5c closure (v6.2.1+):** **S5b** is **done**: validated delegate handoffs plus `HandoffResultCard` in the parent thread for `delegate_to_agent` results. **S5c** is **done** under a superseded definition: the agent bus supplies typed multi-agent activity; **AutonomousReviewPanel** covers post-run review; **HandoffResultCard** covers inline collapsed/expandable handoff preview. No separate duplicate “handoff preview” system is planned.
- **S6 execution detail:** S6a validates `delegate_to_agent` + child handoff payloads first (highest-risk surface). S6b extends validation to mode-scoped stream outputs for Plan/Debug/Review only. Ask and general Build remain prose-first.
- **S6 resilience contract:** Structured output failures should retry once with schema instructions, then emit a non-blocking fallback warning (Activity/chat) while preserving turn continuity.
- **S7 integration note:** `chat_stream_handlers` now assembles additive context blocks via `ContextAssembler` before final prompt injection. Keep future context sources in assembler section order to preserve cap behavior and predictable trims.
- **S7 ignore parity:** `.atlarixignore` is now applied in file-tree blueprint source generation in addition to RTE parse and prompt injection safety-net filtering.

- **`session_end` scope:** Only workspaces touched during the session (memory/snapshot activity) get a quit snapshot; others do not.
- **Tool discovery:** MEMORY-category tools (`get_project_history`, etc.) may not appear in progressive “core” manifests; verify UX for discovering them.
- **Permission queue:** `revert_project_snapshot` has no file `path`; queue UI relies on `PermissionQueuePanel` parsing JSON preview (not the file-proposal path).
- **Default `.atlarixignore`:** Patterns are intentionally aggressive (e.g. lockfiles, large binaries); product may want softer defaults or onboarding copy.
- **File-tree Blueprint:** Confirm whether `buildBlueprintFromFileTree` / non-RTE paths respect `.atlarixignore` everywhere; unify if gaps remain.
- **Per-turn Blueprint tier (future):** S4 uses a session-level atom (applies to every stream until cleared). Optional: reset override after each send, or a per-chat map keyed by `chatId`.

---

## Done: v4.3 — UX and release alignment (2026-03-23)

- **Versioning/docs refresh:** App version bumped to 4.3.0; README/TODO/changelogs aligned to current release messaging.
- **Secure auth persistence:** Keychain/encrypted session persistence on restart, startup restore + refresh, and explicit logout clearing.
- **Onboarding tours:** First-run + feature `?` Shepherd tours with local resume/completion state.
- **Billing entitlement fixes:** Correct active vs cancelled-within-period vs expired behavior; prevent premature feature removal; account copy alignment.
- **Workforce flow improvements:** New-chat clears Token Auth sessions, connected-service indicator in chat, and polished Workforce settings areas.
- **Ask-mode planning:** `write_implementation_plan` allowed in Ask with approval while code writes remain Build-only.
- **Ollama recommendations:** Hardware-aware model suggestions with pull actions and quick selection in provider settings.
- **Workforce permissions UX:** Ask/Build read-write split, Build-only approval for write/trigger actions, and unified batch permission panel via `request_workspace_permissions(services[])`.

---

## Done: v3.8 — Credentials, DB ease, Onboarding redesign, GitHub OAuth, Pro gating (2026-03-11)

- **Credentials:** `.env.example`, `SECRETS.md`; all secrets from env; GitHub OAuth in UI and Supabase.
- **DB Extension:** Connection string parser, Test connection IPC + UI, Parse button; easier connection setup (`.atlarix` in .gitignore for future workspace DB config).
- **Onboarding (redesign):** Screen-by-screen first-run flow (login → workspace → Blueprint intro → Ask vs Build → Settings AI provider → Done). State in Supabase `users.onboarding_completed`; progress bar and per-step Skip/Skip all; Restart in Settings > General; reset when last workspace deleted.
- **Pro gating:** Settings > Extensions and Sidebar Extensions: when logged out, show "Log in" CTA and button to sign-in; when logged in (free), show "Upgrade to use Extensions & DB" and Upgrade button. Pro users see full DB Connections and Extension Manager.
- **Reviews (launchpad):** `REVIEW_ADMIN_EMAIL` env; frontend only shows approved reviews.

---

## Done: v3.7 — Apple Verified, Sentry, PostHog (2026-03-09)

- **Sentry:** Always-on error monitoring for stability and faster fixes.
- **PostHog:** Optional analytics with first-launch consent and Settings toggle.
- **Apple Verified:** Notarized and code-signed on macOS; no security warnings.

---

## Done: v3.6 — Build guide completion (2026-02-27)

- **Auto router:** Two-stage routing, capability registry, fallback-router; wiring in chat stream; routing preview and override in ChatInput.
- **Summarization:** 7-trigger system, per-agent thresholds, balanced model for complex sessions, structured prompt.
- **Blueprint:** Enricher (contentHash cache, batches of 10), reference-manager, plan-manager (`.atlarix/plans/`), workspace open enrichment + combined blueprint.
- **Blueprint live flow:** Unique path IDs, bidirectional particles, edge direction fix, particle glow keyframes, legend entry.
- **Blueprint simplify with AI:** Containers, beacons, and full architecture simplification.
- **Blueprint edge corrections:** Fallback matching by normalized label/path; test edge filtering.
- **Plan cards:** PlanCard component, plan-card-renderer, extract from content; Switch to Build.
- **Agent mesh:** AgentBus, orchestrator, IPC forward to Activity Stream; agent_message / routing_decision in Activity Stream.
- **Agent animation:** Zustand animation-state, AgentNode, AgentMessageEdge; store sync from delegation events.
- **Animation speed:** All animation durations halved (GuidedPipeline, AgentNode, AgentMessageEdge, BlueprintEdge).
- **Reviewer:** static-analyzer, qodo-prompt-adapter, lightning-review-memory (review_patterns table).
- **Reference projects:** add_reference_project tool, get/set reference paths IPC, ReferenceProjectsCard in Diagram panel.
- **DB Extension:** Full CRUD for connections (PostgreSQL, MySQL, SQLite). IPC handlers, persistence, schema introspection, query execution. AI tools: db_query, db_schema, db_list, db_mutate. Context injector for system prompt.
- **Settings > Extensions:** DB connections UI with global and per-workspace scope.
- **Persistent tool indicator:** chat:tool:start/end with Atlarix compass animation.
- **Prompt suggestions:** Context-aware suggestion chips.
- **Atlarix loading animation:** Configurable AtlarixAnimation component (compass/A phases).

---

## Next session (to be done)

- **Diagram/Blueprint layout:** File-tree layout for the Blueprint container canvas shipped in **v6.1.16** (top→bottom). Remaining work is beacon-level file-tree layout and richer edge/tooltips if desired.

---

# Atlarix TODO

## v3.5 (done)

- [x] **Prompt suggestor** — Context-aware suggestions via `<suggestions>` block in AI response; parse and strip in backend; show chips in ChatInput.
- [x] **GitHub Actions** — Forge `APPLE_IDENTITY` for macOS signing; certificate import step; Windows build disabled (`if: false`); VirusTotal job after Mac build; publish without Windows.
- [x] **Streaming / tool UX** — Persistent "Working…" tool indicator; `chat:tool:start` / `chat:tool:end` IPC; ToolIndicator component; clear on response end.
- [x] **Atlarix loading animation** — Dedicated `AtlarixAnimation` component (size xs/sm/md/lg/full, phase thinking/done); used in ChatMessage (streaming) and ToolIndicator.
- [x] **Hide Windows** — Website: Windows download hidden, "in development" placeholder; releases: Windows build disabled; atlarix-releases README note.

## Later

- [ ] Re-enable Windows build in CI when EV/OV code signing is ready.
- [x] Optional: stream terminal output into tool indicator for long-running commands.
- [ ] Optional: brief "done" phase of Atlarix animation when response completes.

---

## Done: v2.7 — AWS Bedrock and changelog order (released 2026-02-14)

- **AWS Bedrock:** Added to Settings → AI → AI Providers (cloud list); token budget supported.
- **Changelog order:** Newest releases now appear at the top.

---

## Done: v2.1 — Agent System and Project Understanding

- **Schema and settings:** Agent mode, permission mode (Ask/Build), Auto, three favorites per provider, AI Configuration options.
- **Project instructions:** Load/save `.atlarix/ATLARIX.md` and `~/.atlarix/ATLARIX.md`; precedence in system prompt; context window from resolved model.
- **Summarization model:** Fast/same/custom for compaction and title generation.
- **Built-in agents and delegate_to_agent:** Research, Architect, Builder, Reviewer; Guided flat delegation; Autonomous nested with depth limit.
- **Chat UI:** Mode (Direct/Guided/Autonomous) + Permission (Ask/Build); Auto toggle; active context bar.
- **Activity Stream:** Right-panel tab; events for delegation, compaction, self-review, turn summary.
- **Self-review:** Runtime stub (Activity Stream); settings schema in place.
- **Autonomous mode:** Nested delegation with max depth; shared context and approval modal can be extended later.
- **Agent Lightning:** Trace collection to `.atlarix/training_data/`; training entry point (placeholder).
- **Token budget:** Turn summary in Activity Stream; per-provider budget in schema.

---

## Done: v2.2 — Blueprint Intelligence (RTE + RAG + Combined Blueprints)

- **RTE parsers:** TypeScript and Python parsers; parser types and registry; single-project Blueprint from RTE.
- **Blueprint cache:** `~/.atlarix/blueprints/{projectHash}/`; manifest, blueprint.json; load/save and staleness.
- **Combined blueprints:** CombinedBlueprint schema, project-selector (findProjects), combined-generator (generateCombinedBlueprint, detectCrossProjectEdges); cache persistence for single and combined.
- **AI-selected blueprinting:** Activity scoring; "Generate Blueprints" modal with project list and recommendations; AI prompt for blueprint/diagram selection.
- **RAG:** queryBlueprint, getCodeForNodes; chat integration; file watcher for incremental Blueprint updates.
- **Parent-aggregated permissions:** batch_plan in PermissionInterceptor and schema; single approval modal; execute all on approve.
- **Motia-style UI:** React Flow canvas; node types and colors; Blueprint-driven ATLARIX_PLAN flow.
- All six implementation phases completed.

---

## v2.2 — Done (see Done section above)

---

## v2.5 — PIVOT (released 2026-02-14)

**Tagline:** From Code to Canvas, Canvas to Code — Architecture Made Simple

**Done in v2.5:** Right panel simplified (Activity removed, Vault kept); Thinking + agent delegation combined in chat; Auto model selection by mode/role (Direct/Guided → Balanced main, agents Fast; Autonomous → Thinking main, agents Balanced, subagents Fast); agent-phase animations on Blueprint canvas (Architect/Builder/Reviewer); PIVOT foundation (`src/lib/pivot/` types, SQLite schema, placeholders); atlarix-releases repo content (README, SECURITY, LICENSE).

---

## Done: v2.6 — Containers & Beacons UX and docs (released 2026-02-14)

- **Ephemeral session fix;** permission sounds on approval batches.
- **Docs:** AGENTS.md, AGENTS_COMPACT.md, agent-tools for delegate_to_agent and Blueprint (get_blueprint, compare_blueprint_to_live, add_blueprint_room/function/edge, update_blueprint).
- **chat:activity** for native tool start/end; Containers & Beacons UI rename (Diagram/Blueprint).
- **Blueprint UX:** Delete container/beacon, drag nodes, Summary Card, Edit Internals, Back, onboarding, "Always show beacons", AI-generated badge, Flow zoom/pan; aiGenerated in add_blueprint_function/update_blueprint.
- **Capability comparison** in README.

**Full PIVOT (implemented):**
- **Stage 1 — Parsing:** `src/lib/pivot/parsers` uses workspace-analyzer (regex + optional Tree-sitter) for TS/JS, Python, Go, Rust, etc.; unified `parseProject(workspacePath)`.
- **Stage 2 — Structure extraction:** `src/lib/pivot/structure.ts` maps WorkspaceAnalysis to PivotNode[] and PivotEdge[]; framework from analyzer.
- **Stage 3 — SQLite persistence:** `src/lib/pivot/` types, `src/db/schema.ts` pivot_nodes, pivot_edges, pivot_containers, pivot_beacons, blueprint_snapshots; `pivot-service.ts`; wired in blueprint_handlers (refresh-from-code and setBlueprint persist nodes/edges and snapshots).
- **Stage 4 — Clustering:** `src/lib/pivot/clustering.ts` AI clustering into 5–8 containers; blueprint:cluster IPC; "Cluster" button in Blueprint editor.
- **Stage 5 — Analysis layer:** `src/lib/pivot/analysis/` SonarQube (env: SONAR_URL, SONAR_TOKEN), Semgrep CLI, SCIP placeholder; pivot:run-analysis IPC; "Analysis" panel in Blueprint.
- **UI:** Live vs Blueprint comparison (Compare button), Generate Code (existing Generate button), blueprint undo stack and History (snapshots restore).
