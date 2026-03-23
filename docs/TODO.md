# Atlarix TODO

**Current Version:** v4.3.0  
**Next Version:** v4.4+  
**Last Updated:** 2026-03-23

---

## Product context (for AI and blueprint accuracy)

- **PIVOT:** Code to Canvas, Canvas to Code. **Containers** = top-level diagram nodes; **Beacons** = functions/features inside a container. **Blueprint** = living diagram from RTE (Round-Trip Engineering) and RAG. RTE parsers (TS, Python) produce single-project blueprints; combined blueprints span projects. Diagram types: architecture, dependencies, flows.
- **Blueprint connections:** Inferred edges are **import-based** only (file A imports file B → edge A→B). No call-graph or data-flow analysis; add manual edges for other relationships. Cross-room edges into test-like rooms from non-test rooms are filtered out.
- **Ask vs Build:** Ask mode = read-only tools only (read_file, search_code, web_search, get_diagram, git_status; no run_command, no write_file/code gen). Build mode = full tool set with user approval.
- **Agents:** Research, Architect, Builder, Reviewer; delegate_to_agent; Guided or Autonomous; Fast/Balanced/Thinking model tiers.
- **Workspace:** `.atlarix/memory.md`, `.atlarix/spec.md`; token budget; permission queue; summarization.

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
