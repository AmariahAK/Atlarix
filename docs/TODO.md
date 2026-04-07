# Atlarix TODO

**Current Version:** v6.1.15  
**Next Version:** v6.2+ (planning)  
**Last Updated:** 2026-04-07

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
| Theme toggle | **Done** | `settings.tsx` — `useTheme` + `<Select>` System/Light/Dark |
| Hero glow contrast fix | **Done** | `atlarix-home.tsx` — glow `to-[#F59E0B]` → `to-[#059669]` |
| Panel toggle button clip fix | **Done** | `layout.tsx` — `top-2 right-2` → `top-3 right-3` |
| Auto-updater in-app UI | **Done** | `UpdateBanner.tsx`; `update:downloaded` IPC replaces native dialog; `update:defer` writes flag; cold-start deferred install in `onReady()` |
| AppImage target | **Done** | `@reforged/maker-appimage` in `forge.config.ts` + `package.json` |
| GitHub Actions Node 24 | **Done** | `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`, softprops v2, `latest-mac.yml` + `latest-linux.yml` generation steps |

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
| **S1** Tiered Blueprint injection + Build RAG cap | **Done** | `blueprintPromptTiers.ts`: Ask/Plan/Build/Debug budgets; `estimateTokens` uses chars÷4; Build adds ranked snippets with explicit omit footer + `truncateToTokens` safety net |
| **S1** Blueprint-first empty state | **Done** | Plan/Build tiers inject blocker when Blueprint has no nodes |
| **S2** Schema + migration + bootstrap | **Done** | `project_snapshots`, `project_memory`; `0031_project_memory.sql`; `ensureProjectMemoryTablesIfNeeded` in `db/index.ts` |
| **S2** Snapshots + pruning | **Done** | Max 100 rows/workspace; triggers: debounced blueprint change, plan file write, build-complete (Agent/Build + files), `session_end` on quit for touched workspaces |
| **S2** Session system prompt injection | **Done** | `buildProjectMemoryPromptBlock` in `chat_stream_handlers.ts` |
| **S2** Tools | **Done** | `get_project_history`, `revert_to_snapshot` (`revert_project_snapshot` permission), `set_project_memory` |
| **`.atlarixignore`** | **Done** | `ignore` npm package; filter at RTE (`generateBlueprint`), cache load (`inferBlueprint`), prompt (`buildBlueprintSystemPromptInjection`); `atlarixIgnoreSource` on cache; default file on first parse; `get_atlarixignore` / `update_atlarixignore`; Blueprint panel + IPC get/set |
| **S3** Explicit Blueprint tier from Settings | **Done** | `blueprintInjectionModePreference` (Auto \| Ask \| Plan \| Build \| Debug); plumbed via `streamMessage` → `chat:stream`; precedence: IPC `blueprintInjectionMode` then preference then heuristics; optional `blueprintDebugTrace` / `blueprintDebugFile` in settings + `ChatStreamParams` for Debug tier |
| **S4** Chat session override for Blueprint tier | **Done** | Config dropdown → **Blueprint in prompt**: Use Settings or force Ask/Plan/Build/Debug; `blueprintInjectionChatOverrideAtom` merged in `useStreamChat` before Settings preference |
| **Work modes** Ask / Plan / Build / Debug / Review + Auto | **Done** | `workModePreference` in settings; maps to `selectedChatMode` + Blueprint tier via `src/lib/work-mode.ts`; `useStreamChat` precedence: chat override → work mode (non-Auto) → settings; `ChatIntentSelector` + context bar; duplicate Ask/Build removed from `ChatModeSelector` |
| **Subscription Realtime dedupe** | **Done** | Material-change gate in `supabase-client` `subscribeToPlanChanges`; serialized setup + fingerprint dedupe in `SubscriptionManager.setupRealtimeSubscription` |
| **S5a** Agent–mode foundation | **Done (kickoff)** | `debugger` in `builtin` / `agent-bus` / `delegate_to_agent`; `work-mode-agents.ts` (default agent + `workModeSystemHint`); stream injects hint after base prompt in `chat_stream_handlers.ts` |
| **S5b** Structured handoffs | **Planned** | Thread child JSON into parent as isolated blocks from `delegate_to_agent`; explicit Blueprint tier per sub-agent role; reuse `agent-handoff-schemas.ts` (ArchitectPlanPayload, BuilderExecutionSummary, ReviewerFindings) |
| **S5c** Handoff polish | **Planned** | Activity Stream send/receive events; collapsible handoff preview in UI |
| **S6** Structured outputs per mode | **Done** | Delegate/handoff schema validation + one retry; Plan/Debug/Review stream validation + warning fallback; structured report rendering for supported mode outputs |
| **S7** ContextAssembler | **Done** | `src/lib/context/ContextAssembler.ts` + `context-assembly-cache.ts`; deterministic section ordering, per-mode caps (Review: 2000), low-priority-first trimming, cache hit/miss + trim diagnostics in stream logs |
| **S7** Tiered discovery flow + folder tooling | **Done** | Added `explore_folder` (structured directory exploration with `.atlarixignore` filtering), `get_blueprint_slice` (targeted architecture slices), and conditional diagram-prefix messaging to prevent synthetic context claims |

### v5.0 follow-ups / incomplete

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

## Product context (for AI and blueprint accuracy)

- **PIVOT:** Code to Canvas, Canvas to Code. **Containers** = top-level diagram nodes; **Beacons** = functions/features inside a container. **Blueprint** = living diagram from RTE (Round-Trip Engineering) and RAG. RTE parsers (TS, Python) produce single-project blueprints; combined blueprints span projects. Diagram types: architecture, dependencies, flows.
- **Blueprint connections:** Inferred edges are **import-based** only (file A imports file B → edge A→B). No call-graph or data-flow analysis; add manual edges for other relationships. Cross-room edges into test-like rooms from non-test rooms are filtered out.
- **Ask vs Build:** Ask mode = read-only tools only (read_file, search_code, web_search, get_diagram, git_status; no run_command, no write_file/code gen). Build mode = full tool set with user approval.
- **Agents:** Research, Architect, Builder, Reviewer, Debugger; delegate_to_agent; Guided or Autonomous; Fast/Balanced/Thinking model tiers. Work mode sets a default specialist (see `src/lib/agents/work-mode-agents.ts`).
- **Workspace:** `.atlarix/ATLARIX.md` (single memory/instructions file, legacy memory/spec auto-migrated); token budget; permission queue; summarization.

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

- **Diagram: file-tree layout**
  - Replace grid/ELK with a **hierarchical file-tree style** so users see what is connected to what and how data flows.
  - **Beacons:** Horizontal tree for main beacons (e.g. DB ←→ API); under each main beacon, a **vertical file tree** for sub-beacons (e.g. User Profile with children Edit, Delete; Signup/Login with OAuth, Manual). Layout should reflect real structure (main beacons with sub-beacons underneath doing tasks).
  - **Containers:** Same file-tree idea for the container canvas (no sub-containers); main containers in a horizontal or vertical tree so connections and hierarchy are clear.
- **Optional:** Ensure edge labels or tooltips show what data is sent where when supported by the model.

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
- [ ] Optional: stream terminal output into tool indicator for long-running commands.
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
