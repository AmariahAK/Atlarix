# Atlarix TODO

This file tracks upcoming features, improvements, and known issues.

---

## ✅ v1.5.0 - Phase 3 Complete (2026-01-24, Week Before Last)

### Smart Diff Preview ✅
- [x] Hunks with ±3 lines of context
- [x] Expand All button for large files
- [x] AI-generated change summary at top
- [x] SmartDiffView in PermissionQueuePanel
- [x] oldContent in edit tools (write_file, replace_code, insert_code, delete_lines)

### Codebase Search Upgrade ✅
- [x] Natural language search
- [x] Results in context (±3 lines)
- [x] Recent Searches dropdown
- [x] CodebaseSearchBox in Search tab

### Right Panel Refinements ✅
- [x] Code tab - Edit opens correct file from Errors
- [x] Errors tab - No stacking, cleared on workspace switch
- [x] Terminal - Multi-tab for multiple dev servers

---

## ✅ v1.7.5 - Phase 4 Complete (2026-01-31, This Week)

### Diagram Refinements ✅
- [x] Smarter git tracking (structuralChangeScore 0.8, isMinorBugFix ≤3 files)
- [x] Capture: debounce 8min, threshold 5 files, lock files excluded
- [x] Right panel diagram tab - Previous versions dropdown

### Token Budget System ✅
- [x] Adaptive per-provider token budgets (Settings > AI > Token Budget)
- [x] Real-time usage display (color-coded TokenBar)
- [x] Warnings when approaching limit (80%, 90%)

---

## ✅ v1.8.0 - Phase 5 Complete (2026-01-31)

- Memory & Concurrency (10 turns, parallel read-only tools)
- Workspace Snapshots (Pro)
- DB migrations run on app start (drizzle migrate)

---

## 📋 Next Session – Diagram & Git Diagram System (Atlaflow Removed)

### Diagram – In-app notes ✅
- [x] Diagram tab shows **Architecture** only (Mermaid: project structure, components, data flow).
- [x] Atlaflow (n8n-style workflow canvas) has been **removed**; replaced by **Additive Blueprint** (see Phase 7 below).

### Refine Git diagram system (replace current tracking) ✅
- [x] **Problem:** Current system tracks files & changes like git for diagram updates, but it’s inaccurate and often wrong.
- [x] **Approach:** Use **simple-git** for a proper git-based diagram system.
  - **Why simple-git:** Lightweight, no native deps, full Git (diff, log, status, blame), Electron-compatible, TypeScript, 7M+ weekly downloads.
  - **Install:** `npm install simple-git`
- [x] **Step 1:** Create `src/lib/diagram/git_change_tracker.ts` – `GitChangeTracker` class:
  - `analyzeChanges(sinceCommit?)` → `ChangeAnalysis` (totalFiles, filesAdded/Modified/Deleted, linesAdded/Deleted, changePercentage, isArchitecturalChange, changes[]).
  - Parse uncommitted (status) + committed since baseline (diffSummary); `FileChange` type: path, type A|M|D|R, insertions, deletions, binary.
  - Helpers: `getDetailedChanges(filePath)`, `getRecentCommits(count)`.
- [x] **Step 2:** Create `src/lib/diagram/diagram_update_strategy.ts` – `DiagramUpdateStrategy`:
  - Thresholds: &lt;5% = minor (skip), 5–15% = update, 15–30% = update with caution, &gt;30% or architectural = regenerate.
  - `decideDiagramAction(lastDiagramCommit?)` → `DiagramDecision` (action: none | update | regenerate, reason, confidence, changes).
  - Architectural indicators: package.json change, new folders, config/routes/index changes, &gt;20% files.
  - `generateUpdatePrompt(changes)` for AI update (use modify_diagram, not generate_diagram).
- [x] **Step 3:** Integrate with existing DiagramManager:
  - `shouldUpdateDiagram(appPath, lastDiagramTimestamp)` using strategy; store/read `lastDiagramCommit` in diagram metadata.
  - In `_generateDiagram`: if decision action none → return latest; if update → updateExistingDiagram(updatePrompt); else regenerate.
  - `saveDiagramVersion` with `metadata.gitCommit`, `metadata.updateType`.
- [x] **Step 4:** DiagramPanel staleness UI: show decision banner (update vs regenerate), file counts, “Update Diagram” / “Regenerate Diagram” button.
- [x] **Outcome:** Bug fixes/typos don’t trigger diagram refresh; real architectural changes trigger regenerate; moderate changes get smart updates.

---

## 🚧 Phase 6 - Planned (→ v2.0)

**Implementation order (by complexity, simplest first):**

1. **IDE-like Workspace** (UI-focused, lower risk)
2. **Smart Model Routing** (settings + logic, medium)
3. **Context Bar + Auto-Summarize** (most complex: summarization flow, context management)

### 1. IDE-like Workspace (In progress)
- [x] File tree in sidebar (single-click expand, double-click chat)
- [x] Click file → opens in Code tab
- [x] Collapse previous workspace when switching

### 2. Smart Model Routing
- [x] 3-tier favorites per provider (Fast ⚡ / Balanced ⚖️ / Deep 🧠) – ModelPicker + LocalProviderFavoritesSelector show tier labels
- [ ] Provider preference order (drag to reorder)
- [ ] Task-based routing (coding→Anthropic, research→Gemini, etc.)
- [x] Auto = smart selection + fallback on provider failure (createFallback in get_model_client)
- [x] Favorites for Ollama and LMStudio (like OpenRouter)

### 3. Context Bar + Auto-Summarize (Claude Code style) ✅
- [x] Replace fixed exchange limits with fillable context bar
- [x] When bar fills (model/provider + query + tools): AI summarizes, resets, continues
- [x] New session = forget (ephemeral chats stay ephemeral)
- [x] **Post-turn compaction** – Run after AI responds (not before user message); uses real token counts
- [x] **Real token tracking** – Use API usage from onFinish for compaction decisions
- [x] **Tool output pruning** – Truncate old tool results (8K chars each) to prevent context bloat
- [x] **OpenCode-style compaction prompt** – Structured continuation (project overview, accomplished, current state, next steps)

### Command Chaining UI (Later)
- [ ] Visual dependency graph (commands as nodes)
- [ ] Partial/selective approvals
- [ ] Mid-chain failure handling with rollback hints

**Providers with native model fetch + tool calling (8):** openai, anthropic, google, openrouter, groq, togetherai, mistral, xai (+ ollama, lmstudio local)

*Session 2026-01-31: Phase 5 complete, v1.8.0 released. Phase 6 scoped.*

---

## 🚧 Phase 7 – Additive Blueprint (Deep Mermaid) – v2.x

**Goal:** Diagram is the single source of truth for *intent* and *new* structure. Code stays authoritative for existing implementation; we add on top, not rewrite in place.

### Mental model

| Mode | Direction | Use case |
|------|-----------|----------|
| **Live View** | Code → Diagram | Read-only. Diagram is extracted/regenerated from code (current behavior). User sees architecture; no edits to repo from diagram. |
| **Blueprint Mode** | Diagram → Code | Editable. User/AI edits diagram (rooms, edges, annotations); *only new* rooms/edges/env refs are codegen’d and merged into repo. |

- **Existing projects:** Blueprint Mode is **additive only** – add new rooms, connections, env refs; codegen *new* files/routes/env entries. We do **not** remodel/refactor existing code from diagram edits (see “Editing existing structure” below).
- **New projects:** Blueprint Mode can be **full** – create diagram from scratch, then codegen entire scaffold (routes, modules, env stub) into a new repo.

### Architecture JSON (single source for Blueprint Mode)

Structured JSON that the app (and codegen) use. Stored per workspace; derived from Mermaid for display, or edited in a future “Blueprint editor”.

- **Rooms:** Nodes (services, apps, DBs, queues). Each has: `id`, `label`, `type`, optional `path` (existing module path if mapped), **intent** (short description of what this room does / should do).
- **Edges:** Directed links between rooms (e.g. `API → DB`, `Worker → Queue`). Metadata: `from`, `to`, optional `label` (e.g. “reads”, “writes”).
- **Annotations:** Per-room or per-edge notes, env var references (e.g. `DATABASE_URL`), secrets refs (by name only, not value).
- **Intent per room:** Drives codegen and AI context – e.g. “Auth API”, “User read/write”, “Sends email via SendGrid”.

Mermaid view is a **render** of this JSON (and vice versa for round-trip where we allow diagram edits).

### Vault (env / secrets)

- **Dedicated UI** for environment variables and secrets (e.g. Settings → Vault, or per-workspace).
- **Storage:** Local only, e.g. `.env` in workspace (or user-chosen path); **never** embed secret values in diagram or Architecture JSON.
- **Diagram reference:** Rooms/edges can reference env by **name** (e.g. `DATABASE_URL`, `SENDGRID_API_KEY`). Codegen and AI use these names; values stay in Vault/.env.

### Codegen (from Architecture JSON delta)

- **Input:** Delta of Architecture JSON – e.g. “new rooms A, B” and “new edges A→B”.
- **Output:** Scaffold only for *new* parts: new files, new routes, new env keys (merged into existing `.env` or Vault), new dependencies if needed.
- **Merge:** Generated code is written into the repo; user can edit. No automatic refactor of existing files from diagram edits (additive only for existing projects).

### Editing existing structure (strategy)

**Recommendation: defer** full “remodeling” of existing code via diagram edits. Reason: diagram → bulk refactor of existing modules is ambiguous (many ways to map one diagram change to code) and risky.

**Preferred approaches:**

1. **Additive only (now):** Diagram edits only add new rooms/edges/env refs; codegen adds new code. Existing code is left as-is; diagram is re-extracted/updated from code so Live View stays in sync.
2. **Chat-led refactor (later):** User describes changes in chat (“split auth into two services”, “move DB access to a repository”). AI performs refactor with existing tools; when done, diagram is **re-extracted** from code (not the other way around). Diagram follows code.
3. **Strict 1:1 room ↔ module (later, optional):** If we ever allow “remodeling” from diagram, limit it to a **strict 1:1** mapping: one diagram room = one package/module/folder. Rename/move/merge only at that boundary (e.g. “rename room X” → rename module X). No fuzzy “this diagram change means refactor these 5 files.”

**Summary:** For existing projects, treat diagram as the place to *add* intent and new structure; use chat + tools + re-extraction for changing existing structure. For new projects, diagram-first → full codegen is in scope.

### Current context (RAG) & memory – for Blueprint design

- **Diagram + workspace analysis:** For workspace chats, `getWorkspaceContext(appPath)` is always called. Its output (`systemPromptAddition`: diagram + structure summary) is injected into the system prompt. So the **Live diagram** (and analysis) is always there to guide the model and make it easy to understand the codebase at scale. This is the primary “RAG” for the repo.
- **User prompts:** Global/workspace prompts (Library) are inlined into the **user message** when the user references them (e.g. `@prompt:5`). So if set, they are part of the request context.
- **Session summary & remembering (Claude Code / OpenCode style):** Implemented as follows:
  - **Post-turn compaction:** When context exceeds ~75% of the model’s budget, the oldest messages are summarized by the AI; the summary is injected as “Session Summary (earlier conversation)” on the next request. Uses real token counts from the API; compaction prompt is OpenCode-style (project overview, accomplished, current state, next steps).
  - **Session memory (rolling):** Last 10 exchanges (truncated) are injected per request for workspace chats (keyed by `appId`), so the model keeps recent conversation context across turns and mode switches.
  - **Persistent memory tools:** `recall_memory` (daily logs + diagram versions) and `search_memory` (semantic search over daily logs). `save_learning` was removed; learnings are not currently persisted by the AI.
  - **Tool output pruning:** Old tool results are truncated (e.g. 8K chars each) to avoid context bloat.
- **Project-level MEMORY.md:** Implemented. When compaction runs, the summary is written to `<workspace>/.atlarix/MEMORY.md`. When building the system prompt for a workspace chat, MEMORY.md is read (if present) and injected as “Project memory (cross-session)”. Single rolling summary per project; truncated to ~3K chars when injected.

So: the AI has diagram-first RAG, session compaction, rolling session memory, persistent memory tools, **project-level MEMORY.md**, and **implementation plan** (`.atlarix/PLAN.md` via `read_implementation_plan` / `write_implementation_plan`). Flow: compare Blueprint to Live → write plan → implement in exchanges with review gates.

### Blueprint Edit Mode: task-based implementation (existing & large projects)

To support **editing existing structure** and large projects without “one big edit,” we can make Blueprint Mode **task-based** and plan-led:

1. **Always-on RAG:** Keep current behavior: user prompts (if set) + **Live diagram** (and workspace analysis) are used so the model can explore and understand the system. The diagram is always there to guide search and understanding at scale.
2. **When user asks to “generate code” from Blueprint:**  
   - **Compare:** Live diagram (current code) vs Blueprint diagram (desired). Optionally compare in code as well (what exists vs what needs to change: functions, classes, routes, APIs, webhooks).  
   - **Break into tasks:** Give the model 1–2 minutes (or a dedicated “planning” phase) to turn the **diff** (Live vs Blueprint, and code-level gaps) into an ordered **task list** by workspace (mono vs poly). Flow: understand repo → inspect code (APIs, routes, etc.) → consider user request from Blueprint → output tasks.
3. **Implementation plan file:** Allow the AI to create/update an **implementation plan** (its “todo list”) in the project:  
   - **Monorepo:** one plan at project root, e.g. `Atlarix_Plan.md` (or `.atlarix/PLAN.md`).  
   - **Polyrepo / multi-workspace:** one plan per workspace root (e.g. frontend root, backend root).  
   - **Permission:** Request user approval to create or alter this file (e.g. “Allow Atlarix to create/update `Atlarix_Plan.md` in this project?”).
4. **Execute after plan:** When the plan is ready, the model says it’s ready and then codes **according to the plan** (one task or batch at a time), using existing file/codegen tools. Compaction and session memory keep context so the model remembers the plan and progress.

**Why this helps editing existing structure:**  
- Avoids “do everything in one go”: the model explicitly plans before coding.  
- Live diagram + comparison gives a clear diff (what to add/change), and code-level comparison clarifies concrete gaps.  
- A durable `Atlarix_Plan.md` (or equivalent) gives the model and user a shared todo list; the model can tick off tasks and stay aligned on scope.  
- Fits the existing stack: diagram-first RAG + compaction + session memory already support long, structured work; the plan file and comparison step add structure without replacing them.

**Execute in exchanges (one task per phase):** The AI does **not** have to do all tasks in one go. It can do them **exchange by exchange** (one user query → one AI response):

- After completing the **first task**, the AI asks the user for **review/test** (e.g. “Please run tests / try the flow and tell me if anything fails”).
- When the user confirms (or reports issues), the AI says when it’s **ready for the next phase** (next task) and proceeds in the next exchange.
- Repeat until all tasks from the plan are done. Each phase = one exchange (or a short back-and-forth for that task only).

This **review gate** between tasks gives the user control, keeps changes incremental, and works for both **additive** and **editing** blueprints on any project size (mono, poly, small, large). It completes the Blueprint idea: plan → tasks → execute in exchanges with review gates → next task.

**Implementation checklist (task-based Blueprint):**

- [x] **Live vs Blueprint comparison** – `compare_blueprint_to_live` tool returns Live diagram + Blueprint + diff summary.
- [x] **Planning phase** – Agent guidance: model uses comparison + user request to produce ordered task list (documented in AGENTS).
- [x] **Atlarix_Plan.md (or .atlarix/PLAN.md)** – `.atlarix/PLAN.md`; `read_implementation_plan` and `write_implementation_plan` tools; permission via existing write_file flow.
- [x] **Execute in exchanges** – Agent guidance: after each task, ask for user review/test; when ready, proceed to next task.
- [x] **Agent guidance** – AGENTS.md / AGENTS_COMPACT.md updated: compare → plan file → announce ready → code in exchanges with review gates.

### Implementation checklist (Phase 7)

- [x] **Architecture JSON schema** – Blueprint types in `shared/blueprint-types.ts`; persisted in DB table `blueprints` (one per workspace).
- [x] **Mermaid ↔ Architecture JSON** – Blueprint editor renders to Mermaid via `blueprintToMermaid()`; Live stays from code.
- [x] **Blueprint editor (minimal)** – Diagram tab Blueprint mode: add/edit rooms, functions (api/webhook/function/feature), edges; renders to Mermaid preview.
- [x] **Vault UI** – Right panel "Vault" tab: list/add/edit/delete env keys per workspace; sync to `.env.local`; dedicated VaultPanel component.
- [x] **Codegen pipeline** – `lib/blueprint/codegen.ts`: from Blueprint delta → new stub files (`src/<room>.ts`), merge envRefs into `.env.local`; `generate_from_blueprint` tool + blueprint:codegen IPC; "Generate code" button in Blueprint editor.
- [x] **New-project flow** – “New from Blueprint”: Create workspace (empty or template) → Diagram → Blueprint mode → "Generate code" runs full scaffold; same codegen supports additive and new-project.
- [x] **Re-extract after chat refactor** – After AI operations complete, `evaluateDiagramRefresh()` in interceptor runs `decideDiagramAction(workspaceId, executedOperations)` and triggers `diagram:regenerate-background` when action is generate/refresh (diagram-refresh-engine).

### Blueprint UX – Phases A–D (2026-02-03) ✅

- [x] **Phase A** – Type differentiation (icons + labels per API/Webhook/Function/Feature), expandable config per row, List | Flow toggle.
- [x] **Phase B** – Vault tab in Diagram panel; Key field + “Edit in Creds” in function list; `credentialKey` / `provider` / `trigger` on BlueprintFunction.
- [x] **Phase C** – Flow view inside a room: mini React Flow, nodes = functions, edges from `room.flowEdges`; click node → switch to List with that function expanded.
- [x] **Phase D** – User-editable flow edges (connect/disconnect in Flow); persisted on `BlueprintRoom.flowEdges`; cleanup on function remove.

**Left for later (optional):**

- [ ] **Codegen/AI use flowEdges** – When generating from Blueprint, optionally use `room.flowEdges` so generated code reflects “A calls B” (e.g. webhook → function → API).
- [ ] **View code / Edit in list** – Wire “View code” and “Edit” buttons in the function list (e.g. open file from `description` path or editor).
- [ ] **Inferred flow edges** – Optional pass that infers “this webhook calls this function” from code and pre-fills `flowEdges`.

---

## ✅ Phase 8 – Internal diagram git (simple-git for all projects)

- [x] **DiagramGitTracker** – Per-workspace internal repo at `userData/diagram-git/<workspaceId>`. Snapshots = commits of workspace file hashes (one tiny file per project file). Uses simple-git; works for repo, monorepo, polyrepo, and non-repo.
- [x] **captureSnapshot** – After diagram generation, write workspace state and commit; store hash in `diagram.metadata.diagramGitCommit`.
- [x] **analyzeChanges** – On staleness check, write current snapshot and diff against `diagramGitCommit`; same thresholds (e.g. &lt;5% skip, &gt;30% regenerate) for accurate update vs regenerate and fewer unnecessary refreshes.
- [x] **check-staleness** – Use only internal diagram git when `diagramGitCommit` is present; no fallback to project git (older diagrams rely on fingerprint-based staleness).
- [x] **DiagramUpdateStrategy.decideFromChangeAnalysis** – Shared threshold logic for internal diagram git.

---

## 🚧 Workflow-as-Prompt (v2+) – n8n-style [SUPERSEDED by Phase 7 Additive Blueprint]

**Concept:** Instead of long text prompts, users create **node-based workflows** (like n8n) that encode intent. The AI reads the workflow (structure + nodes + connections) as the "prompt," reducing tokens and improving clarity.

### Phase 1: JSON Workflow Import ✅
- [x] Parse n8n/Zapier JSON from chat
- [x] Infer tech stack from nodes
- [x] Generate AI prompt from workflow
- [x] Wire into chat_stream_handlers + chat_only_handlers

### Phase 1b: n8n-node-definitions (no hardcoding) ✅
### Phase 1c: Credential mappings from n8n source ✅
- [x] Fetch credential defs from n8n-io/n8n GitHub
- [x] Parse .credentials.ts → extract properties
- [x] Auto-generate env vars from property names
- [x] Heuristic package inference
- [x] Remove hardcoded CREDENTIAL_MAPPINGS
- [x] Fetch node defs from DecayAI/n8n-node-definitions on demand
- [x] Credential→env/package map (small manual layer)
- [x] Project→workflow inference (package.json deps → nodes)
- [x] Diagram + workflow produced when reading project
- [x] Architecture | Workflow toggle in Diagram tab

### Phase 2: Native Workflow Builder (v2.2) – Atlaflow ✅
- [x] Renamed workflow feature to **Atlaflow**
- [x] ReactFlow integration in Diagram tab
- [x] Node library (Webhook, Postgres, Stripe, OpenAI, SendGrid, etc.)
- [x] Visual editor – drag nodes, connect, Export/Import JSON
- [x] AppMap pipeline – `AppMap` types, `appMapToAtlaflow`, `atlaflowToAppMap`; round-trip and vision implemented
- [x] Multi-language fallback nodes (React App, Python App, Go, Rust, etc.) so every workspace gets at least one node
- [x] Staleness session-based only; Regenerate error toasts; Atlaflow page scroller; top-right panel toggle

### Phase 3: Atlaflow implementation (project → workflow → code) ✅
- [x] **Extractors** (per language) – Node/Express (routes + data sources), Python (FastAPI/Django/Flask). Others: add when needed.
- [x] **Codegen** (Node/Express) – AppMap → atlaflow.generated.routes.js, atlaflow.generated.data.js; optional package.json deps. “Generate Code” runs codegen when workspace selected.
- [x] **Live sync** – “Refresh workflow” button reloads from project; after “Generate Code” success, diagram marked stale (banner suggests refresh).
- [x] **Polyproject** – detectPolyproject (frontend/backend, packages/*, apps/*); inferWorkflowForWorkspace merges workflows with x-offset and _group label.
- [x] **Optional** – workflowVersion in diagram metadata; appMapToMermaid for diagram-from-AppMap; Import from URL in Atlaflow (Fetch URL).
- [x] **Conditionals from code** – Extract if/else (or branching) around routes/handlers into AppMap conditionals so canvas shows branch nodes from source. Node/Python extractors emit `AppMapConditional` with synthetic then/else entry points; `app_map_to_atlaflow` / `atlaflow_to_app_map` support Branch node; **Branch** in Atlaflow node library.
- [x] **Template library** – Save/load workflow templates (e.g. “API + DB”, “Webhook → Slack”); apply template to workspace or new project. DB: `workflow_templates` table, migration 0027. IPC: template-save, template-list, template-get, template-delete. UI: "Save as template" (modal name/description), "Load template" (list + load + delete per row with confirm).

### Right Panel UX (Before Workflow) ✅
- [x] Show right panel when workspace selected (before first prompt)
- [x] Diagram/Preview/Code quick-toggle bar above content
- [x] Load diagram on workspace select (useLoadApp)

---

## ✅ v0.9.19 - Language Detection & Setup UI (Complete)

### Language Detection System ✅
- [x] **Language Registry**: 12 languages (Node.js, Python, Go, Rust, Ruby, Java, PHP, .NET, Deno, Bun, Elixir, Docker)
- [x] **Project Detector**: Auto-detect languages from indicator files (package.json, Cargo.toml, etc.)
- [x] **Lazy Validation**: Only check when running/building, not on startup
- [x] **AI Tools**: Added `check_language_installed` and `detect_project_languages` (57 total)

### SetupBanner & Settings UI ✅
- [x] **Removed Node.js Block**: Banner no longer blocks for Node.js (lazy detection)
- [x] **Removed Google Gemini Card**: Simplified to OpenRouter + Atlarix Pro only
- [x] **OpenRouter Credits Note**: Added info about paid vs free models
- [x] **Fixed Banner Visibility**: Now checks database for API keys (hides when configured)
- [x] **Workflow Settings**: Disabled toggles with "Coming Soon" badge
- [x] **Fixed Atlarix Pro Logo**: Uses correct `/logo/Atlarix.png`

### API Key Fix ✅
- [x] **OpenRouter Production Fix**: Added database fallback in `get_model_client.ts`
- [x] **Provider Detection**: `useLanguageModelProviders` now checks DB

---


## ✅ v0.9.18 - Authentication & Polish (Complete)

### Authentication & Session ✅
- [x] **Google OAuth**: Supabase Auth integration with Deep Linking (`atlarix://`)
- [x] **Session Persistence**: Custom file-based storage for Electron
- [x] **Auth UI**: User profile, plan status, sign out

### UI Improvements ✅
- [x] **App Icon**: Updated to Split design
- [x] **Theme-Aware Logos**: Home page auto-switches dark/light logos
- [x] **Success Flow**: Toast notification to close browser tab

---

## ✅ v0.9.17 - Session Tracker & Architecture (Complete)

### Core Systems ✅
- [x] **SessionTracker**: Implemented "Mini-Git" to track uncommitted changes
- [x] **Staleness Logic**: Added <5%, 5-15%, >15% thresholds for diagram updates
- [x] **New Tools**: `get_session_changes` and `get_dev_server_port`
- [x] **Right Panel**: Fixed global prompt diagram staleness bug

### Documentation ✅
- [x] **Architecture Rewrite**: Removed Dyad references, documented Atlarix accurately
- [x] **Tool Docs**: Added new tools to AGENTS.md and AGENTS_COMPACT.md

---

## ✅ v1.0.0 - Business Logic (Complete)

### Authentication ✅
- [x] Choose provider (Supabase)
- [x] Implement Login/Signup (Google OAuth)
- [x] Session Persistence (Electron file-based storage)

### Monetization (LemonSqueezy Integration) ✅
- [x] Integrate Payment Provider (LemonSqueezy)
- [x] Subscription checkout flow (Upgrade button)
- [x] Unsubscribe button with direct API cancellation
- [x] Supabase Realtime for instant plan updates
- [x] LemonSqueezy webhook handling (subscription lifecycle)
- [x] Customer portal URL storage for subscription management
- [x] Subscription expiry handling (access until billing period ends)

### Workspace Limits Strategy
**Free Tier (1 Workspace):**
- ✅ Full feature access: All 57 tools, live preview, diagrams, any AI model
- ✅ Unlimited incognito/non-workspace chats (free, ephemeral)
- ❌ Limit: 1 workspace - delete to create another, or upgrade

**Pro Tier ($19/mo):**
- ✅ Unlimited workspaces
- ✅ Workspace switching (no setup loss)
- ✅ (Future) Cross-workspace memory
- ✅ (Future) Workspace templates

**Implementation:**
- [x] `canCreateWorkspace(userId)` - check tier + workspace count
- [x] Delete confirmation modal with data loss warning
- [x] Upgrade prompt when hitting limit

### Template System ✅
- [x] **Git Clone UX**: Clicking template triggers `apply_template` (clone → rm .git → init)
- [x] **Template Search**: SearxNG-powered template discovery (not hardcoded)
- [ ] **Visual Previews**: Show diagram/preview *before* cloning (Future v1.1+)


### Other TBD Items
- [x] **LemonSqueezy Live Mode**: Switched to production mode for release
- [x] **Setup Video**: Created setup walkthrough video for SetupBanner & Help Docs button
- [x] **SearxNG for web_search**: Added fallback when API rate limits hit (v0.9.2)
- [x] **"Other AI Providers" section**: Settings UI implemented

---

## 🔮 Future Versions (v1.1+)

### Workspace Templates (Pro Feature)
- [ ] Save workspace config as template (prompts, diagram style, tool preferences)
- [ ] Apply to new workspaces in 1 click
- [ ] Useful for freelancers/agencies with similar project setups

### Enhanced Features
- [ ] Cross-workspace AI memory (remembers patterns across projects)
- [ ] Team collaboration features
- [ ] Priority support for Pro users

---

## ✅ v0.9.15 - Error Handling & UI Fixes (Complete)

All 4 bugs fixed and verified on 2026-01-09.

---

### Fix 1: AI Missing File Paths ✅
**File:** `src/components/RightPanel.tsx`

- [x] Changed `error.source` → `error.file` in function signature
- [x] Added `error.line` to include line number in AI prompt

---

### Fix 2: Errors Not Clearing ✅
**Files:** `console_debugger.ts`, `useBrowserErrorListener.ts`, `preload.ts`, `interceptor.ts`

- [x] Added `clearConsoleBuffer()` and `clearAllConsoleBuffers()` functions
- [x] Added `browser-console-cleared` IPC channel to preload whitelist
- [x] Added listener in `useBrowserErrorListener.ts` to reset error state
- [x] Call `clearAllConsoleBuffers()` after operations complete in interceptor

---

### Fix 3: Monaco Cursor Jumping ✅
**File:** `src/components/preview_panel/ErrorFileEditor.tsx`

- [x] Added `isInitialLoad` state to track first load vs user editing
- [x] Only apply decorations and cursor positioning on initial load
- [x] Set `isInitialLoad=false` in onChange handler

---

### Fix 4: Duplicate Messages ✅
**File:** `src/hooks/useAIPanelListener.ts`

- [x] Added `processedTimestamps` ref to track handled events
- [x] Skip events with already-processed timestamps
- [x] Limit set size to prevent memory leak

---

### Verification ✅
- [x] TypeScript check passed (`npx tsc --noEmit`)
- [ ] Manual test: "Fix with AI" shows file path + line number
- [ ] Manual test: Errors clear after fix
- [ ] Manual test: Cursor stays in place while typing
- [ ] Manual test: Messages appear only once


---

## 🔥 v0.9.16 - Right Panel & AGENTS.md Updates (Complete)

### AGENTS.md Right Panel Documentation ✅
- [x] Added comprehensive "Right Panel Overview" section
- [x] Documented all 7 tabs (Preview, Code, Terminal, Errors, Permissions, Search, Diagram)
- [x] Clarified port info (Atlarix 5173 vs user projects 5174+)
- [x] Added common user Q&A responses
- [x] Clarified Mermaid diagrams (not PlantUML)
- [x] Added guidance for diagram syntax errors

### AGENTS_COMPACT.md Updates ✅
- [x] Added right panel tabs list
- [x] Added Mermaid clarification
- [x] Added port warning

---

## 🔥 v0.9.14 - AGENTS.md Context Optimization (In Progress)

Goal: Make AGENTS.md the single source of truth for AI guidance (StackSense approach)

### Phase 1: Create AGENTS.md Full Reference ✅
- [x] Document all 55 tools with full descriptions, parameters, examples
- [x] Add decision trees (workspace exploration, bug fixing, feature adding)
- [x] Add common workflows (CLI → template → manual priorities)
- [x] Add critical rules section (code style, sequential commands)
- [x] **Result: 1464 lines, 34KB (~8500 tokens)**

### Phase 2: Create AGENTS_COMPACT.md for Small Models ✅
- [x] Essential tools and workflows only
- [x] Critical rules and decision trees
- [x] **Result: ~100 lines, 3KB (~750 tokens)**

### Phase 3: Simplify system_prompt.ts ✅
- [x] Strip from 770 lines → **153 lines** (80% reduction!)
- [x] Remove agent mode (UI only has build/ask)
- [x] AGENTS.md is now primary guidance source
- [x] Add model-aware `getAgentsMdForContextSize()`

### Phase 4: Trim Tool Descriptions ✅
- [x] Trimmed `web_search` description
- [x] Trimmed `check_command_status`, `get_project_structure`, `get_diagram`
- [x] Trimmed `create_workspace`, `search_templates`, `apply_template`
- [x] Trimmed `preview_changes`, `batch_read_files`
- [x] 9 verbose tool descriptions → one-liners

### Phase 5: Test & Validate
- [X] Test with Ollama 8K context model
- [X] Verify all tools still work correctly
- [X] Measure actual token usage before/after

---

## 🔥 v0.9.13 - AI-Controlled Diagram System (In Progress)

### Phase 1: DiagramManager Creation
- [X] Create `/src/lib/DiagramManager.ts` static utility class
  - [X] Add `generatingWorkspaces` Set for tracking in-progress generation
  - [X] Add `generationPromises` Map for deduplication
  - [X] Implement `hasAnyDiagram(workspaceId)` - check if diagram exists
  - [X] Implement `isGenerating(workspaceId)` - check generation status
  - [X] Implement `waitForGeneration(workspaceId, timeout)` - wait for completion
  - [X] Implement `generateInitialDiagram(workspaceId, appPath)` - with deduplication
  - [X] Implement `regenerateForWorkspace(workspaceId, options)` - for AI updates

### Phase 2: update_diagram Tool
- [X] Modify `diagram-tools.ts` - replace existing `update_diagram` with permission-based version
  - [X] Schema: updateType (minor/major/new_component), affectedComponents, changeDescription, suggestedFocus
  - [X] Return `__permission_required: true` for approval flow
  - [X] Add comprehensive description for AI guidance (when to use/not use)

### Phase 3: Cold Start Handling
- [X] Modify `chat_stream_handlers.ts`
  - [X] Check `hasAnyDiagram()` before first workspace message
  - [X] Start background generation (non-blocking) for new workspaces
  - [X] Emit `diagram:initial-ready` IPC when generation completes

### Phase 4: get_diagram Enhancement
- [X] Modify `diagram-tools.ts` - update `get_diagram` handler
  - [X] Wait for in-progress generation if `isGenerating()` is true
  - [X] Start on-demand generation if no diagram exists

### Phase 5: Permission System Integration
- [X] Modify `interceptor.ts`
  - [X] Add case for `update_diagram` operation in `executeOperation()`
  - [X] Call `DiagramManager.regenerateForWorkspace()` on approval
  - [X] Return result with diagramId

### Phase 6: UI Components
- [X] Modify `PermissionQueuePanel.tsx`
  - [X] Add diagram update card for `update_diagram` operation
  - [X] Show updateType badge, affected components, description
  - [X] Emerald theme styling to match diagram panel

### Phase 7: System Prompt & Preload
- [X] Modify `system_prompt.ts`
  - [X] Add "Diagram Management" section with examples
  - [X] Document when to use/not use `update_diagram`
- [X] Modify `preload.ts`
  - [X] Whitelist `diagram:initial-ready` channel

### Phase 8: PlantUML → Mermaid Migration
- [X] Remove PlantUML references from type definitions
  - [X] `db/schema.ts` - Remove "plantuml" from diagram type enum
  - [X] `atoms/sourceAtoms.ts` - Remove "plantuml" from DiagramState type
  - [X] `ipc/ipc_client.ts` - Remove "plantuml" from DiagramInput type
  - [X] `ipc/handlers/diagram_handlers.ts` - Remove "plantuml" from DiagramInput type
- [X] Remove PlantUML components
  - [X] `components/preview_panel/DiagramPanel.tsx` - Remove PlantUMLPreview component
  - [X] `lib/tools/meta-tools.ts` - Remove PlantUML detection from explain_diagram tool
- [X] Update comments to reference only Mermaid

---

## ✅ v0.9.12 - Live Code Editor & Session Persistence (COMPLETED)

### Chat Session Persistence ✅
- [x] **Hidden Div Approach**: Chat mounted in invisible div during navigation
- [x] **Streaming Persists**: AI continues streaming when navigating away
- [x] **Route Detection**: Shows/hides based on current path

### Diagram State Notifiers ✅
- [x] **Staleness IPC**: `diagram:staleness-detected` sent after file operations
- [x] **Atom Updates**: `diagramStalenessAtom` tracks outdated state
- [x] **Staleness Banner**: DiagramPanel shows when diagram needs refresh
- [x] **Preload Whitelist**: Added staleness channel

### Live Code Editor ✅
- [x] **ErrorFileEditor**: Monaco-based editor for error files
- [x] **File List**: Collapsible list with error counts
- [x] **Save Shortcut**: Cmd/Ctrl+S saves changes
- [x] **Error Markers**: Squiggly underlines at error locations
- [x] **Auto-Position**: Cursor moves to first error
- [x] **File IPC**: Read/write/stats handlers added

### UI Improvements ✅
- [x] **Simplified Toolbar**: Removed top 4-icon bar, now single 7-tab row
- [x] **Diagram Tab**: Added to secondary toolbar
- [x] **URL Cleanup**: Parses `http://localhost:5174/src/...` → `src/...`
- [x] **Error Filtering**: Ignores Monaco, CDN, extension errors

---


## ✅ v0.9.11 - Error Capture UX Improvements (COMPLETED)

### CDP-Based Error Capture ✅
- [x] **Electron Debugger API**: Replaced proxy with `webContents.debugger` for reliability
- [x] **Filter Atlarix Errors**: Skip port 5173 (Atlarix dev server) and internal Electron errors
- [x] **IPC Whitelisting**: Added `browser-console-error` channel to preload.ts

### "Fix with AI" Button ✅
- [x] **SimpleChatInput Atom**: Changed from local useState to global `chatInputValueAtom`
- [x] **Textarea Auto-Resize**: Added useEffect to expand when pre-filled
- [x] **Clean Prompt Format**: Simplified to "Error: ... File: ..." (no redundant markdown)

### "Suggest" Button ✅
- [x] **Notes Input**: User can add suggestions when sending error to AI
- [x] **Inline UI**: Input appears below Suggest button when clicked
- [x] **Combined Prompt**: Error + user suggestion sent together

---

## ✅ v0.9.8 - Permission Queue & Workspace Delete Fixes (COMPLETED)

### Permission Queue Integration ✅
- [x] **Unified FileDiffPanel**: Merged PermissionQueuePanel into Approve tab
- [x] **Simplified routing**: `show-permissions` intent → `file-diff` panel
- [x] **Real-time IPC**: Added `permission-request` event emission
- [x] **useEffect loading**: Permissions load on panel mount

### Workspace Delete UI ✅
- [x] **Instant UI update**: Optimistic delete removes workspace immediately
- [x] **"Already deleted" handling**: Errors ignored gracefully
- [x] **Auto-navigate**: Returns to home when current workspace deleted

### Bug Fixes ✅
- [x] **AI prompt error**: Restored `chat_stream_handlers.ts` to stable 4a2b440
- [x] **PlantUML code removal**: DiagramPanel no longer shows raw code
- [x] **IPC whitelist**: Added `operation-status` and `auto-recovery-needed` channels

---

---

## ✅ v0.9.7 - Command Execution & Smart Context Management (COMPLETED)

### Core Command Wait Fix ✅
- [x] **Move resolveApproval()**: Call AFTER command execution, not before
- [x] **Store command results**: Add `CommandExecutionResult` with stdout/stderr/exitCode/duration
- [x] **Sequential executeAllOperations()**: Commands wait for completion before next starts

### Smart Output Formatting ✅
- [x] **Priority slicing**: Errors → Warnings → First 5 lines → Last 5 lines
- [x] **formatCommandOutput()**: Intelligent 1500-char limit for AI context
- [x] **Include output in getExecutionResult()**: AI sees terminal results

### Timeout Protection ✅
- [x] **5-minute timeout**: Configurable timeout with Promise.race()
- [x] **Progress updates**: UI updates every 2 seconds for long commands
- [x] **Error storage**: Capture timeout/failure info for AI context

### Command Error Handling ✅
- [x] **Distinguish errors vs rejection**: Command failures include terminal output for AI
- [x] **Dev server detection**: `npm run dev`, `vite` etc. timeout as success after 10s
- [x] **Terminal UI feedback**: CommandOutputCard shows running commands with spinner

### Smart Context Management (Solving AI "Blindness") ✅
- [x] **Smart read_file**: Add `max_lines`, `context` mode, `line_range` parameters
- [x] **Smart search_code**: Add `context_lines` for surrounding context
- [x] **get_file_outline tool**: Table of contents for files (imports, functions, classes)
- [x] **view_symbol tool**: Read single function/class by name
- [x] **list_files stats**: Add file size/line count to help AI decide
- [x] **ContextManager**: Model-aware token budgets (8K Ollama → 200K Claude)
- [x] **System prompt update**: Context management hints for AI

### Surgical Edit Tools (Precise Code Changes) ✅
- [x] **replace_code tool**: Find and replace specific code snippet
- [x] **insert_code tool**: Insert code at specific line
- [x] **delete_lines tool**: Delete specific line range
- [x] **Updated system prompt**: Document new tools prominently
- [x] **Updated request_tools**: Document core tools already available

### Diagram Stale Detection ✅
- [x] **Workspace fingerprint**: Track file counts, types, and hash per workspace
- [x] **Staleness severity**: none/minor/moderate/major based on % change
- [x] **diagram:check-staleness IPC**: Compare stored vs current fingerprint
- [x] **Schema columns**: `fingerprintHash`, `fingerprintData`, `createdFromFileCount`
- [x] **StalenessBanner UI**: Color-coded banner with refresh button
- [x] **Empty state enhancement**: "Generate First Diagram" CTA

### UI Bug Fixes ✅
- [x] **Dev server detection fix**: Exclude `npm install` from timeouts
- [x] **AI text deduplication**: Filter consecutive identical responses
- [x] **Copy button fix**: Exclude thoughts and tool calls from copy
- [x] **Unified diff view**: +/- line style with theme colors
- [x] **Command queue status**: Queued/Done labels in FilesTab

### Live Preview (Lovable-style) ✅
- [x] **Preload whitelist**: Added `dev-server:*` IPC channels
- [x] **DevServerProvider**: Auto-detects frontend, starts server
- [x] **RightPanel Preview tab**: Iframe with viewport controls
- [x] **Framework detection**: Vite, Next, CRA, Nuxt, Astro

### Todo: Timeline & Evolution ✅
- [x] **Timeline auto-capture**: queueCapture() in interceptor.ts after file ops
- [x] **AI preview awareness**: System prompt teaches Lovable-style workflow
- [x] **Project evolution view**: Added 11 timeline IPC channels to preload.ts

### Token-Saving Stop Button ✅
- [x] **chat:abort IPC handler**: Cancels backend AI stream immediately
- [x] **abortAllStreams()**: Cleanup on app quit
- [x] **Stop button wired**: Both SimpleChatInput and ChatInput call abort
- [x] **Preload whitelist**: chat:abort added for frontend access

---

## 🔥 v0.9.6 - Prompts, Persistence & Polish ✅

### Global & Workspace Prompts ✅
- [x] **Global Prompt**: Custom AI instructions for all incognito chats
- [x] **Workspace Prompts**: Per-project AI instructions with workspace binding
- [x] **Library Page Redesign**: Two sections - Global (single) + Workspace (paginated list)
- [x] **Character Limit**: 2000 chars with visual counter
- [x] **DB Schema Update**: New prompts table with type/workspaceId fields

### Session Persistence ✅
- [x] **activeChatIdAtom**: Chat sessions persist across navigation (Settings → Home)
- [x] **New Chat Button**: Subtle "← New Chat" in header resets session
- [x] **Jotai State**: Replaced useState with atom for global persistence

### Error Handling ✅
- [x] **LM Studio Errors**: Friendly "LM Studio not running" message instead of stack traces
- [x] **MiniMax Deduplication**: Fixed content repeating twice with reasoning models
- [x] **Ephemeral History**: Full chat history displayed, not just current exchange

### Bug Fixes ✅
- [x] **Permission Requests**: Sequential requests now display correctly (timestamp fix)
- [x] **Auto-scroll**: Only scrolls after streaming starts, preserves scroll position
- [x] **Chat History Clipping**: Fixed by waiting for DOM render with requestAnimationFrame

---

## 🔥 v0.9.5 - AI-Controlled Right Panel ✅

### AI-Controlled Panel System ✅
- [x] **Explicit AI Intent**: AI now explicitly sets what right panel shows via `aiControlledPanelAtom`
- [x] **Priority Order**: AI state → Pinned → Heuristics (replaces brittle detection logic)
- [x] **Permission Panel**: New panel type for showing pending permission requests
- [x] **IPC Integration**: Backend sends `right-panel:set-view` events when permissions buffered

### UI Fixes ✅
- [x] **Prompt Box Clipping**: Fixed - Mode/model controls no longer hidden after first message
- [x] **flex-shrink-0 Wrapper**: ChatInput wrapped to prevent compression
- [x] **Stream Cancel Error**: Silenced non-critical "no callbacks" error for cancelled streams

### Workspace Registration ✅
- [x] **Direct Path Storage**: Workspaces registered by original path (no copying to ~/atlarix-apps)
- [x] **Duplicate Detection**: Smart check for existing path OR name duplicates
- [x] **Safe Delete**: Only removes database records, never deletes user source files

---

## 🔥 v0.9.4 - Diagram System Overhaul ✅

### AI-Powered Diagram Generation ✅
- [x] **Real AI Diagrams**: Replaced hardcoded placeholders with actual AI analysis
- [x] **Codebase Analysis**: `diagram:generate-ai` extracts and analyzes project structure
- [x] **Path Bug Fix**: Correctly handles imported apps with absolute paths

### Pan/Zoom Controls ✅
- [x] **react-zoom-pan-pinch**: Installed and integrated
- [x] **Drag to Pan**: Click and drag to navigate large diagrams
- [x] **Scroll to Zoom**: Mouse wheel zooms in/out
- [x] **Zoom Controls**: +, -, Reset, Center buttons in top-right

### Version History Sidebar ✅
- [x] **History Toggle**: "History" button in diagram header
- [x] **Collapsible Sidebar**: Shows all past versions with timestamps
- [x] **Restore Functionality**: Click "Restore" to revert to any version
- [x] **Smart Dates**: Shows "Today at 2:30 PM" vs "Dec 31, 2:30 PM"

---

## 📋 v0.9.3 Implementation Plan (Completed)

### Phase 1: Core Command Execution Fix ✅
- [x] **Fix interceptor.ts**: Add `executeRunCommand()` method to actually execute commands
  - Import `runShellCommand` utility
  - Store command output for UI display
  - Handle exit codes and errors
- [x] **Fix execution-tools.ts**: Return JSON permission request instead of legacy string
  - Use structured `{ __permission_required: true, operation: "run_command", preview: {...} }`
- [x] **Fix useStreamChat.ts**: Parse command proposals by checking `request.operation`
  - Check `request.operation === 'run_command'` instead of `p.command`

### Phase 2: Collapsed Terminal Output Card ✅
- [x] **New: CommandOutputCard.tsx**: Collapsed card showing terminal output (like ThinkingCard)
  - Auto-collapse on success, auto-expand on error
  - Show spinner while running, checkmark/error on complete
  - Click to expand full terminal output
  - Display: `⚡ npx create-vite my-app → ✓ Completed in 8.3s [View ▼]`

### Phase 3: Project Environment Detection ✅
- [x] **New: project_environment.ts**: Read package.json to detect project context
  - Detect framework (vite, next, cra, nuxt, astro)
  - Extract available scripts (dev, start, build, test)
  - Determine correct dev command (`npm run dev` vs `npm start`)
- [x] **New: get_project_info tool**: Read-only tool for AI to query project details
  - Prevents hallucination (AI calls this BEFORE running npm commands)

### Phase 4: TensorFlow + Heuristics Smart Slicing (StackSense Approach) ✅
- [x] **New: SliceExtractorAgent.ts**: Port from StackSense's slice_extractor_agent.py
  - Language-specific parsing (Python, JavaScript/TypeScript, generic)
  - Heuristic scoring: keyword density + function/class name matching
  - TensorFlow semantic scoring (optional, using @tensorflow/tfjs-node)
  - Combined score: 60% heuristic + 40% TensorFlow
  - Context budget management (select within token limit)
  - Context integrity (don't cut mid-function, merge adjacent slices)
- [x] **New: TerminalOutputSlicer.ts**: Real-time terminal output slicing
  - Categorize lines: errors, warnings, normal
  - Priority: Errors > Warnings > Last 5 lines > First 5 lines
  - Prevents AI context overflow from long command output

### Phase 5: Wire Everything Together
- [x] **Text-Based Tool Parser**: Added `text_tool_parser.ts` to handle models that output tool calls as XML text (MiniMax, etc.)
- [x] **Integrated into chat_stream_handlers.ts**: Parses and executes text-based tool calls after stream completes
- [x] **Integrated into chat_only_handlers.ts**: Same for ephemeral chats
- [x] **Agentic Tool Loop**: Feeds tool results back to AI so it can continue (up to 5 iterations)
- [ ] **Modify chat_stream_handlers.ts**: Use SliceExtractorAgent for file context
- [ ] **Emit terminal output**: Send to frontend for CommandOutputCard
- [ ] **Test end-to-end**: Create project → Approve command → See collapsed output


---

## ⏳ Known Issues (Ongoing)
- [x] **AI Message Repetition (MiniMax)**: ✅ FIXED in v0.9.6 - Deduplication logic added
- [x] **Prompt Box Clipping**: ✅ FIXED in v0.9.5 - Mode/model controls now always visible
- [x] **Diagram Persistence**: ✅ FIXED - Diagrams now persist and display correctly
- [x] **Right Panel Heuristics**: ✅ FIXED in v0.9.5 - AI now explicitly controls panel state
- [x] **LM Studio Errors**: ✅ FIXED in v0.9.6 - User-friendly error messages

---

## ✅ COMPLETED: v0.9.2 Enhancements
- [x] **Smart Project Scaffolding**: AI now uses CLI commands first (npx create-vite, etc.)
- [x] **Session Memory Persistence**: Memory persists across Ask → Build mode switches
- [x] **Permission Sound Notification**: Plays `remaining.mp3` when new proposals arrive
- [x] **SearxNG Template Fallback**: Templates fetched via SearxNG when GitHub rate-limited
- [x] **Code Copy Button**: Fixed - Copy button now visible on ALL code blocks
- [x] **Diagram Page Reset**: Fixed - Selected diagram resets when switching workspaces
- [x] **Sidebar Workspace Selection**: Fixed - Click to select, double-click for new chat
- [x] **Individual File Approval**: Added "Execute Selected" button for granular file acceptance
- [x] **Command Safety Wrapper**: Added dangerous pattern blocklist (rm -rf, sudo, curl|bash)

---

## 📋 Completed ✅

### v0.9.0 (2025-12-28)
- [x] **Permission System**: JSON-based tool permissions with FileDiffPanel
- [x] **PermissionInterceptor**: Buffer, validate, execute approved operations
- [x] **IPC Client Methods**: executePermission, rejectPermission, etc.
- [x] **Right Panel Cleanup**: Removed Tools tab (ThinkingCard handles it)
- [x] **Diagram Wiring**: Tool results populate diagramStateAtom

### v0.8.0 (2025-12-27)
- [x] **ThinkingCard**: Two independent cards, collapsed by default
- [x] **Absolute Paths**: Projects store full paths

### v0.7.0 (2025-12-27)
- [x] **Ask Mode Tools**: 21 read-only tools
- [x] **Tool Summary UI**: Claude-style grouped badges

### v0.6.0 (2025-12-27)
- [x] **Diagram Timeline**: Architecture evolution visualization

### v0.4.0 (2025-12-25)
- [x] **3-Panel Layout**: Left, Middle, Right panels
- [x] **SearxNG Setup**: One-click Docker

---

## 🚀 Roadmap: Future Versions

### v2.0 - Shipped (2026-02)
- [x] **Live ↔ Blueprint ↔ Code** – See Phase 7 section: Live diagram (code → diagram), Blueprint mode (diagram → code), Vault, codegen, re-extract after refactor.
- [x] **Token Budget System**: Per-provider caps in Settings; real-time TokenBar; warnings at 80%/90%.
- [x] **Dangerous Command UX**: "I understand" for risky commands; plain-English explanation; audit log.
- [x] **Chat Themes**: Light/Dark/System (ThemeContext); diagram/code theme-aware.
- [x] **Compare Mode**: Diagram tab – current / before / after / side-by-side diagram comparison.
- [x] **Persistent Memory (MEMORY.md)**: `.atlarix/MEMORY.md` on compaction; injected into workspace system prompt.
- [ ] **Command Chaining UI**: Visual dependency graph, partial approvals, mid-chain rollback (future).
- [ ] **Voice Input**, **Code Playground**, **Usage Stats**, **Timeline Export (GIF)**, **Multiple Diagram Types** (future).
- [ ] **Workspace Templates (Pro)**: Save workspace config as template; apply to new workspace; visual previews before clone (future).

### v3.0 - Advanced AI
- [ ] **Multi-Agent**: Parallel AI queries for complex tasks
- [ ] **Custom Agents**: User-defined tool sets and personas
- [ ] **Team Collaboration**: Shared workspaces and permissions

---

**Last Updated**: 2026-02-03
**Version**: v2.0.0 (Phase 6 & Phase 7 Complete; Blueprint UX Phases A–D Complete – List | Flow | Creds | flowEdges)
