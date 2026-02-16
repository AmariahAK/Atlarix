# Atlarix Changelog

All notable changes to Atlarix will be documented in this file.

## [2.9.0] — 2026-02-16

### Diagram: visible connections, flow side panel, badge, larger panel

- **Visible connection lines:** Flow view and container canvas edges now use explicit `style: { stroke, strokeWidth }` so connector lines are always visible (primary color), making it clear what is connected to what and where data flows.
- **Flow mode: edit in side panel (Option B):** Clicking a beacon in Flow view no longer switches to List; a side panel opens next to the flow with the selected beacon’s details (name, Connected to, etc.). Close with X to stay in Flow.
- **Connection badge in flow:** Replaced inline “Connected to” text on flow nodes with a small icon badge (GitBranch + count); list view still has the full “Connected to” section for editing.
- **Larger flow panel:** Inline flow height increased (180px → 320px); expanded flow dialog is larger horizontally (min-w 85vw, max-w 95vw).

### Telemetry: OpenTelemetry + SQLite (replaces Jaeger)

- **Telemetry:** Replaced Jaeger with OpenTelemetry + SQLite. Lightweight in-process tracing; spans stored in user data directory as `telemetry.db`. New `RuntimeAnalyzer` (in `lib/telemetry/runtime-analyzer.ts`) for call frequency, average latency, call graph, and hot paths. Blueprint `mergeRuntimeData` now accepts a call graph `Map<string, string[]>` (e.g. from `RuntimeAnalyzer.getCallGraph()`) for runtime-derived edges.
- **Removed:** Jaeger client, trace parser, and Jaeger URL from Settings. All Jaeger-related code and UI removed.

---

## [2.8.0] — 2026-02-16

### Blueprint connection visualization, descriptions, tree view, co-author, website

- **Connection visualization:** RTE parsers (TypeScript, Python) now emit import and call edges; Blueprint canvas and room flow view render edges with type labels (import/call/api) and arrow markers.
- **Connection UI:** Connection handles on room and function nodes are shown only on hover (or connect mode) so they do not interfere with dragging.
- **Simple descriptions:** Beacons get human-readable descriptions from JSDoc/docstrings first, then pattern heuristics (e.g. createX, useX, API routes); "Simplify" button uses the user’s AI to generate a one-line description on demand; optional expandable "Technical details" in the list item.
- **Tree / hierarchical layout:** Diagram toolbar has a Diagram vs Tree layout toggle; Tree uses ELK for a dependency-style layout.
- **Git co-author:** Commits made through Atlarix include `Co-authored-by: Atlarix AI Agent <agent@atlarix.dev>` by default; Settings → Integrations has a checkbox to disable.
- **Website (atlarix-launchpad):** Hero and Footer have "As Seen On" (SaaSHub, AlternativeTo); version set to v2.8; IndexNow key file hosted at site root for Bing.

---

## [2.7.0] — 2026-02-14

### AWS Bedrock and changelog order

- **AWS Bedrock:** Added to Settings → AI → AI Providers (cloud list). Configure API key (AWS_BEARER_TOKEN_BEDROCK) and optional AWS_REGION; token budget supported.
- **Changelog order:** Newest releases now appear at the top.

---

## [2.6.0] — 2026-02-14

### Containers & Beacons UX, docs, and polish

- **Ephemeral session fix:** Persist partial session on abort; fix duplicate user message on ephemeral sessions.
- **Permission sounds:** Sound on first and subsequent permission batches when approvals are ready.
- **Delegate and Blueprint docs:** AGENTS.md, AGENTS_COMPACT.md, and agent-tools documentation for delegate_to_agent and Blueprint/containers & beacons tools.
- **chat:activity for native tools:** Thinking/agent flow now emits chat:activity for native tool start/end so the UI reflects tool usage.
- **Containers & Beacons UI rename:** Diagram and Blueprint editor use "Containers" and "Beacons" (replacing "rooms" and "functions" in UI labels); "Add room" → "Add container".
- **Blueprint UX:** Delete container/beacon and delete selected container; entire node draggable; Summary Card and Edit Internals with Back button; onboarding tooltip; "Always show beacons" setting; AI-generated flag and badge on nodes; Flow zoom/pan.
- **Blueprint tools:** add_blueprint_function and update_blueprint support aiGenerated; get_blueprint, compare_blueprint_to_live, add_blueprint_room, add_blueprint_function, add_blueprint_edge, update_blueprint documented and available to agents.
- **Capability comparison:** README/docs updated with capability comparison for users.

---

## [2.5.0] — 2026-02-14

### PIVOT foundation, UI refinements, and model routing

- **Right panel:** Activity tab removed to reduce clutter. Vault tab kept for env keys (e.g. STRIPE_API_KEY, RESEND_API_KEY) referenced in Blueprint/beacons.
- **Thinking + agent in chat:** Agent delegation (Guided pipeline / Autonomous graph) and activity stream are now shown in the AI response section, combined with the Thinking card, so users see task delegation and reassurance during long tasks without opening a separate tab.
- **Model selection by mode and role (Auto):** Direct and Guided main requests use Balanced (second tier); Autonomous main uses Thinking (or deepest when provider has no third tier). Guided agents (Architect, Builder, Reviewer) use Fast; Autonomous agents use Balanced at depth 0 and Fast for subagents. Optional complexity bump (settings) can promote Guided agents to Balanced for heavy tasks. Thinking fallback uses provider's deepest favorite when no Thinking model is configured.
- **Agent animations on Blueprint canvas:** When Architect runs, container (room) nodes show a "forming" animation; when Builder runs, nodes show a "beacon highlight" glow; when Reviewer runs, edges pulse green. Activity stream drives the phase so the Diagram tab reflects the active agent.
- **PIVOT foundation:** New `src/lib/pivot/` with types (Container, Beacon, PivotBlueprint), SQLite schema (nodes, edges, containers, beacons, blueprint_snapshots), and placeholder API for future ANTLR4 parsing, clustering, and persistence. Beacon/container descriptions support env key references; Vault remains the source of truth for values.
- **atlarix-releases repo:** README, SECURITY.md, and LICENSE added in `atlarix-releases-repo-content/` for copying into the official release repository (atlarix.dev, Norah Labs, Issues/Discussions). Enable Issues (and optionally Discussions) in the releases repo and remove obsolete content as needed.

---

## [2.2.0] — 2026-02-12

### Blueprint Intelligence (RTE + RAG + Combined Blueprints)

Atlarix 2.2 transforms the Blueprint from a static diagram into a **living knowledge system** powered by **Round-Trip Engineering (RTE)** and **Retrieval-Augmented Generation (RAG)**. v2.2 builds on v2.1 (agents, project instructions).

- **RTE parsing** – One-time parsing per project; TypeScript and Python parsers; framework detection; single-project Blueprint from RTE (rooms, edges).
- **Blueprint cache and combined blueprints** – `~/.atlarix/blueprints/{projectHash}/`; manifest, blueprint.json; load/save and staleness; CombinedBlueprint schema (projects, cross_project_edges); findProjects, generateCombinedBlueprint, detectCrossProjectEdges.
- **AI-selected blueprinting** – Activity scoring; "Generate Blueprints" modal with project list and recommendations; AI prompt for blueprint/diagram selection.
- **Blueprint as RAG and file watcher** – queryBlueprint, getCodeForNodes; chat integration; incremental Blueprint update on file change.
- **Parent-aggregated permissions** – Batch mode (planId); single approval modal; execute all on approve.
- **Motia-style UI and ATLARIX_PLAN flow** – React Flow canvas; node types and colors; Blueprint-driven planning; blueprint cache invalidation on diagram regen; "Refresh from code"; AI editing indicator.

---

## [2.1.0] — 2026-02-08

### Scope release: MCP, Auto mode, Model picker, Workspace sync, Right panel, Full-screen pages, Errors, Tools

- **MCP workspace limiting:** No workspace → only global MCPs in Config and at runtime. In workspace → global + that workspace's MCPs. Same filter used in chat/run context.
- **Auto mode:** Removed Auto provider order from Settings. New settings: single Auto provider + 3 models (Fast/Medium/Thinking). Config → Configure Auto (provider + 3 models). Backend uses these when Auto is ON.
- **Model picker:** "Change model" opens in a Sheet (no more popover close). Selected model displayed clearly.
- **Right panel:** Panel and toggle shown only on home/chat page (`/` or `/chat`). Hidden on Settings, Tools, Library, etc.
- **Workspace sync:** `get-app` and `list-apps` return `pathExists`. When folder is missing, UI shows "Workspace not found" with Remove from list; Diagram/Code/Preview and panel bar hidden until path is valid.
- **Errors:** Per-error "Mark done" (removes from list). "View code" opens exact file and line in Code tab (and in full-screen Code page). FileEditor/ErrorFileEditor accept `initialLine` for scroll-to-line.
- **Full-screen Code page:** Route `/code` with optional `appId`. Left: file tree; center: single-file editor; right: Chat (same session), Errors, Terminal. "Code full screen" in workspace bar.
- **Full-screen Diagram page:** Route `/diagram` with optional `appId`. When opened with appId, right panel shows Chat (same session). "Diagram full screen" in workspace bar.
- **Tools page:** Redesigned: 4 features per view, search bar, category filters, short descriptions, steps, "How it works", and in-app links (Settings, Home, Library). Setup models section with link to Settings.

### 2.1 fixes and polish (2026-02-12)

- **Auto mode fix:** When Auto is ON, backend uses effective model (Fast/Medium/Thinking chain) for the chosen provider; supports all providers (OpenRouter, Ollama, LM Studio) with 2–3 favorite models.
- **Auto UI:** When Auto ON: show provider selection only (providers with ≥2 favorites); hide model picker. When Auto OFF: show model picker; hide Auto provider dropdown.
- **Diagram 404 fix:** Diagram generation uses Auto chain when Auto is ON; deprecated OpenRouter models (e.g. Pony Alpha) mapped to a working model; on 404/model not found, retry with fallback model.
- **Website (atlarix-launchpad):** Privacy Policy and Terms of Service pages at `/privacy` and `/terms`; footer links; sitemap updated; dependencies added for anime.js and Three.js/react-three-fiber for future animations.
- **Right panel:** Prefer code-preview (9 tabs) when dev server is running; tab bar uses flex-nowrap and min-w-0 for horizontal scroll.
- **Full-screen Code/Diagram:** Narrower left column (file tree w-48, diagram sidebar w-56) to give editor/diagram more room.
- **Errors tab:** Dismissed errors stored by signature; "Mark done" adds signature; when the same error recurs, it is re-shown.
- **Setup guide:** Copy updated to list all supported providers and MCP configuration (Settings / "Manage MCP tools", `@mcp name`).
- **Thinking card:** Streaming assistant turns show a "Thinking…" card above the response with live animation until the task is done.
- **Context progress bar:** Horizontal bar beside the context line showing context usage (tokens); updates after each AI response.
- **Changelog:** 2.1 items marked done; duplicate Unreleased v2.1.0 section removed.

---

## [v2.0.0] - 2026-02-02

### Live diagram ↔ Blueprint diagram ↔ Code (Phase 7)

Architecture is now a two-way system: **Live** (code → diagram, read-only) and **Blueprint** (diagram → code, additive).

- **Live View** – Diagram is extracted/regenerated from your codebase (Mermaid). View only; no edits to repo from the diagram.
- **Blueprint Mode** – In the Diagram tab, toggle **Live | Blueprint**. In Blueprint mode you add **rooms** (e.g. Auth API, Worker, DB), **functions** per room (API, Webhook, Function, Feature), and **edges** between rooms. Stored as Architecture JSON per workspace (`blueprints` table).
- **Vault** – Right panel **Vault** tab: manage environment variables per workspace; syncs to `.env.local`. Env keys can be referenced by name in the Blueprint (no values in diagram).
- **Codegen** – From Blueprint delta: new stub files (`src/<room>.ts`) and merge of env refs into `.env.local`. **Generate code** button in Blueprint editor; AI tool `generate_from_blueprint`. Additive only (skips existing files).
- **Re-extract after refactor** – After AI file writes/moves, the permission interceptor runs `evaluateDiagramRefresh()`; when structural change is detected, background diagram regeneration runs so the Live diagram stays in sync.
- **New-project flow** – Create workspace (empty or from template) → Diagram → Blueprint mode → design → **Generate code** to scaffold. Same codegen supports additive (existing project) and full scaffold (new project).
- **Implementation plan** – `ATLARIX_PLAN.md` at project root (like claude.md), version-controllable. `get_plan_scope` determines placement for multi-repo. `read_implementation_plan` / `write_implementation_plan` support optional `targetPath`. Compare Blueprint to Live → plan tasks → implement exchange-by-exchange with user review.

### Phase 6 – Smart Model Routing & IDE

- **3-tier favorites** – Fast ⚡ / Balanced ⚖️ / Deep 🧠 in ModelPicker and Settings for OpenRouter, Ollama, LM Studio.
- **Auto fallback** – When provider is "Auto", a fallback chain is built; if the first provider fails (e.g. rate limit), the next is tried automatically.
- **IDE-like workspace** – File tree in sidebar; click file → Code tab; collapse previous workspace on switch.
- **Context bar + auto-summarize** – Fillable context; post-turn compaction; real token tracking; tool output pruning; OpenCode-style continuation.

### Already in app (documented as v2.0)

- **Token budget** – Per-provider caps in Settings; real-time TokenBar; 80%/90% warnings.
- **Dangerous command UX** – "I understand" for risky commands; plain-English explanation; audit log.
- **Themes** – Light / Dark / System (ThemeContext); diagram and code views follow theme.
- **Compare mode** – Diagram tab: current / before / after / side-by-side diagram comparison.
- **Persistent memory** – `.atlarix/MEMORY.md` written on compaction; injected into workspace system prompt.

### Blueprint UX – Phases A–D (2026-02-03)

Blueprint room detail is now a hybrid list + flow with credentials linking.

- **Phase A** – **Type differentiation**: Each function in “Edit room details” shows type (API, Webhook, Function, Feature) with icon (Lucide) and expandable config (description, provider, credential key, trigger). **List | Flow** toggle per room.
- **Phase B** – **Creds in Diagram**: Diagram panel tabs include **Vault** (key icon). In the function list, API/Webhook rows show a **Key** field (e.g. `OPENROUTER_API_KEY`) and **Edit in Creds** opens the Vault tab. Optional `credentialKey`, `provider`, `trigger` on `BlueprintFunction`.
- **Phase C** – **Flow view**: For each room, **Flow** shows a mini React Flow canvas: nodes = room functions (same type icons), edges from `room.flowEdges`. Click a node to select that function and switch back to List with it expanded.
- **Phase D** – **Editable flow edges**: In Flow view, drag from node handles to connect; Backspace/Delete removes an edge. Edges stored as `BlueprintRoom.flowEdges` and kept in the in-memory blueprint (codegen/AI can use them when generating “connected” code).

**Left for later (optional):** AI/codegen reading `flowEdges` when generating code; “View code” / “Edit” actions in the function list; inferring flow edges from code analysis.

### Phase 8 – Internal diagram git (simple-git for all projects)

- **DiagramGitTracker** – Per-workspace internal git repo under `userData/diagram-git/<workspaceId>`. Each snapshot is a commit of workspace file hashes (one small file per project file); no dependency on the project having git.
- **captureSnapshot** – After each diagram generation, we write the current workspace state into the internal repo and commit; the commit hash is stored in `diagram.metadata.diagramGitCommit`.
- **analyzeChanges** – On staleness check, we write the current workspace snapshot (no commit) and run `simple-git` diff against `diagramGitCommit` to get file-level changes; same thresholds (e.g. &lt;5% skip, 5–15% update, &gt;30% regenerate) drive update vs regenerate. Reduces unnecessary refreshes and works for repo, monorepo, polyrepo, and non-repo.
- **check-staleness** – Use only internal diagram git when `diagramGitCommit` is present; no fallback to project git (older diagrams use fingerprint-based staleness).

---

### (Prior: Atlaflow conditionals & template library – 2026-02-02)

#### Conditionals from code
- **Source → AppMap** – Node and Python extractors detect `if`/`else` (and equivalent branching) around route handlers and API logic. Each branch is represented in the AppMap as an `AppMapConditional` with synthetic entry points for "then" and "else" paths.
- **Types & round-trip** – `AppMapConditional` and branch entry points in `app_map_types.ts`. Converters `app_map_to_atlaflow.ts` and `atlaflow_to_app_map.ts` support the conditional type and the **Branch** node on the Atlaflow canvas.
- **Canvas** – Atlaflow node library includes a **Branch** node (`ATLAFLOW_BRANCH`). When workflow is inferred from code, conditionals appear as branch nodes so the canvas reflects routing logic from the project.

#### Template library
- **Database** – New `workflow_templates` table (id, name, description, workflow JSON, created_at, updated_at). Migration `0027_workflow_templates.sql`; migrations run on app start.
- **IPC** – Four handlers: `workflow:template-save`, `workflow:template-list`, `workflow:template-get`, `workflow:template-delete`. Exposed via preload and `IpcClient` (`saveWorkflowTemplate`, `listWorkflowTemplates`, `getWorkflowTemplate`, `deleteWorkflowTemplate`).
- **Atlaflow editor UI** – Toolbar: **Save as template** (modal: name, optional description) persists the current canvas workflow. **Load template** lists saved templates; click to load onto canvas (same effect as Import). Each template row has a delete (trash) button on hover with confirmation; list updates in-place after delete.
- **Use case** – Reusable workflows (e.g. "API + DB", "Webhook → Slack"); save once, load into any workspace or start from a template when building a new project.

### Atlaflow round-trip (2026-02-02)
- **AppMap pipeline** – Language-agnostic spec (entry points, data sources, flows, screens) for project ↔ workflow ↔ diagram. `app_map_types.ts`, `app_map_to_atlaflow.ts`, `atlaflow_to_app_map.ts`.
- **Atlaflow** – Full support for Node/Bun and Python (extractors + codegen); other runtimes use inference/ecosystem fallback. Polyproject splits; conditionals; diagram-from-AppMap fallback.
- **Diagram staleness** – Session-based only; no staleness check on load (banner only after in-session file changes).
- **Regenerate diagram** – User-friendly API error toasts; 401 → “Check API key in Settings.”
- **Atlaflow page** – Scroller on Diagram tab when View = Atlaflow; entry/data/screen node types and labels.
- **Right panel toggle** – Button in top-right when workspace or chat active (layout).

### Fixes (2026-02-01)
- **MCP list-servers** – Fixed `SqliteError: no such column: "scope"` by adding a one-time schema fix in DB init: if `mcp_servers` exists without `scope`/`app_id`, columns are added before Drizzle runs.
- **Right panel in chats** – Chat page header button now toggles the **toolbar right panel** (7-tab: Preview, Code, Diagram, etc.) via `rightPanelVisibleAtom`; button remains chat-only (home with active chat + workspace `/chat`).

---

## [v1.8.0] - 2026-01-31
### Phase 5 Complete

#### Memory & Concurrency
- **Chat turns** - Default 3→10; configurable in Settings (5, 8, 10, 15, 20, 30)
- **Session memory** - 5→10 exchanges; truncation 300/500→800/1500 chars
- **MaxChatTurnsSelector** - Now user-configurable dropdown

#### Concurrency
- **Read-only tools in parallel** - When AI requests multiple read-only tools (read_file, web_search, etc.), they now execute in parallel

#### Workspace Snapshots (Pro)
- **Save snapshot** - One-click save of files, prompt, diagram, chat history
- **Restore snapshot** - Restore from any saved snapshot
- **Pro-gated** - Requires Atlarix Pro subscription

#### Database
- **Migrations** - Run automatically on app start (drizzle migrate from ./drizzle)

---

## [v1.7.5] - 2026-01-31
### 🎯 Phase 4 Complete - Atlarix 2.0 Progress (This Week)

#### Phase 4: Diagram Refinements
- **Smarter tracking** - structuralChangeScore 0.7→0.8, isMinorBugFix broadened (≤3 files)
- **Less capture churn** - debounce 5→8 min, file threshold 3→5; lock files removed from significant
- **Diagram version history** - Previous versions dropdown in Diagram tab (workspace snapshots)

#### Phase 4: Token Budget System
- **Adaptive per-provider budgets** - Optional token caps per provider in Settings (OpenAI, Anthropic, etc.)
- **Real-time usage display** - TokenBar shows usage vs budget; color-coded bar (amber 70%+, red 90%+)
- **Warnings** - "Approaching token limit" at 80%; "Token limit nearly reached" at 90%

---

## [v1.5.0] - 2026-01-24
### 🎯 Phase 3 Complete - Atlarix 2.0 Progress (Week Before Last)

#### Smart Diff Preview
- **Hunk View** - Changed sections with ±3 lines of context (DIFF_CONTEXT_LINES)
- **Expand All** - Toggle between hunks and full diff when >50 lines
- **AI Summary** - Change description at top; fallback to +X -Y line counts
- **SmartDiffView** - New component in PermissionQueuePanel for file edits
- **oldContent** - write_file, replace_code, insert_code, delete_lines now pass oldContent for proper diffs

#### Codebase Search Upgrade
- **Natural Language** - semantic_search accepts "find authentication logic" style queries
- **Results in Context** - ±3 lines (contextBefore, contextAfter) per match
- **Recent Searches** - recentCodeSearchesAtom + dropdown (max 10)
- **Search Tab** - CodebaseSearchBox with search-codebase IPC in Right Panel
- **deep_search** - Fixed to use semantic_search instead of non-existent search_code

#### Right Panel Refinements
- **Code Tab** - selectedErrorFileForCodeAtom; Edit button opens correct file
- **Errors Tab** - Build errors replace (no stacking); runtime errors preserved; cleared on workspace switch
- **Terminal** - Multi-tab for multiple outputs (backend + frontend dev servers)

## [v1.0.1] - 2026-01-17
### 📦 Build & Release
- **macOS DMG**: Switched from `.zip` to `.dmg` for macOS releases for easier installation.

## [v1.0.0] - 2026-01-17
### 🎉 First Major Release
- **Official Release**: Atlarix is now out of beta!
- **Documentation**: New comprehensive `/docs` page.
- **Onboarding**: Setup video and polished onboarding flow.
- **Production Ready**: Live LemonSqueezy integration, robust auth, and signed binaries.

### 📝 Documentation & Polish
- **Documentation Page**: Added `/docs` route with Getting Started, Features, and Workflow guides.
- **Setup Video**: Integrated setup tutorial video in Setup banner.
- **Credentials**: Switched LemonSqueezy to Live Production mode.
- **Supabase**: Secured webhook secrets and functions.
- **Vercel**: Added routing configuration for documentation site.

## [v0.9.22] - 2026-01-16
### 🔐 Workspace Cleanup & Auth Flow
- **Logout Clears Workspaces**: Signing out now deletes ALL workspaces for a fresh start
- **Free Tier Enforcement**: Login now enforces 1-workspace limit (keeps oldest, deletes newer)
- **Robust FK Handling**: Manual cleanup of chats, prompts, diagrams before workspace deletion
- **Fail-Safe Logout**: Sign-out now proceeds even if DB cleanup has errors

### 🖼️ UI Improvements  
- **Auth-Gated UI**: "Add Workspace" (+) and "Delete All" buttons hidden when logged out
- **Onboarding Banner**: Video placeholder replaced with Atlarix logo + play button overlay
- **Theme-Aware Chat Header**: Logo switches between dark/light correctly
- **Removed Pro Button**: ProModeSelector removed from chat input controls

### 🐛 Bug Fixes
- **Diagram Generation Error**: Fixed `NOT NULL constraint failed: diagrams.title` by using AI-powered generation
- **Database Schema**: Added fingerprint columns to diagrams table migration

### 📝 Known Issues
- **Library Workspaces (Prod Only)**: `npm start` shows workspaces in Library page, but bundled app doesn't (under investigation)

## [v0.9.21] - 2026-01-16
### 🔒 Workspace Limits (Free Tier Enforcement)
- **Limit Check**: Free tier now limited to 1 workspace (enforced in frontend + backend)
- **Upgrade Prompt**: Shows upgrade modal when limit reached
- **Cache Fix**: Fixed stale workspace count after deletion (was blocking new imports)
- **Import Safeguard**: Backend validates limit in `import-app` handler

### 🐛 Bug Fixes
- **Unsubscribe White Screen**: Removed page reload after cancellation (UI now updates reactively)
- **IPC Whitelist**: Added `auth:check-workspace-limit` channel

## [v0.9.20] - 2026-01-15
### 💳 LemonSqueezy Integration (Monetization)
- **Checkout Flow**: Upgrade button opens LemonSqueezy checkout with pre-filled email
- **Webhook Handling**: Supabase Edge Function processes subscription lifecycle events
- **Realtime Updates**: Supabase Realtime instantly updates UI when plan changes
- **Unsubscribe Button**: Direct API cancellation with confirmation dialog
- **Subscription Expiry**: Users keep Pro access until billing period ends (not immediately revoked)
- **Hardcoded Fallbacks**: LemonSqueezy credentials bundled for production builds

### 🔧 Help Modal Improvements
- **Email Bug Reports**: "Report a Bug" now opens email form (auto-fills user email)
- **Removed Chat Upload**: Removed "Upload Chat Session" button (unused)
- **Simplified UI**: Cleaner dialog with Open Docs and Report a Bug options

### 🐛 Bug Fixes
- **Profile Picture Fix**: Fixed Google avatar not showing in bundled app (was hardcoded to undefined)
- **OAuth Hang Fix**: Added 5-second timeout to `getUserPlan()` for new accounts
- **Reload Fix**: Changed `window.location.reload()` to proper Electron-compatible refresh

## [v0.9.19] - 2026-01-14
### 🌐 Language Detection System
- **Language Registry**: Added support for 12 languages (Node.js, Python, Go, Rust, Ruby, Java, PHP, .NET, Deno, Bun, Elixir, Docker)
- **Project Detection**: Auto-detects project languages from indicator files (package.json, Cargo.toml, go.mod, etc.)
- **Lazy Validation**: Languages are only checked when running/building projects, not on startup
- **AI Tools**: Added `check_language_installed(lang)` and `detect_project_languages()` tools (now 57 total)

### 🎨 Setup Banner UI
- **Simplified Cards**: Removed Google Gemini, now shows OpenRouter + Atlarix Pro only
- **Credits Note**: Added info message about OpenRouter paid vs free models
- **Hidden Other Providers**: Commented out until settings are complete
- **Fixed Logo**: Atlarix Pro card now uses correct `/logo/Atlarix.png`

### ⚙️ Settings Page
- **Workflow Toggles**: Disabled Auto-Approve and Auto-Fix with "Coming Soon" badge
- **Reset Text**: Updated to mention workspaces, diagrams, prompts

### 🐛 Bug Fixes
- **OpenRouter API Key**: Fixed production loading from database in `get_model_client.ts`
- **Banner Visibility**: `useLanguageModelProviders` now checks database for API keys
- **Fixed Duplicate Span**: Resolved JSX parsing error in SetupBanner

## [v0.9.18] - 2026-01-14
### 🔐 Authentication & Session
- **Google OAuth**: Implemented Google Sign-In via Supabase Auth (removed GitHub option).
- **Session Persistence**: Implemented file-based session storage (`supabase-auth.json`) to keep users logged in across app restarts.
- **Deep Linking**: Fixed `atlarix://` protocol handling for OAuth callbacks.
- **Auth UI**: Added sidebar dropdown with User Email, Plan status, and Upgrade/Sign Out buttons.

### 🎨 UI Polish
- **App Icon**: Updated to "Split" (Dark/Light) design for better visibility on all backgrounds.
- **Theme-Aware Logos**: Home page now switches between Dark/Light logos based on theme.
- **Success Toast**: Added notification to close browser tab after successful OAuth login.

### 🐛 Bug Fixes
- **Profile Picture**: Fixed missing user avatar by extracting from Google metadata.
- **Lint Errors**: Resolved TypeScript errors in auth hooks.
- **Logo Paths**: Fixed broken image paths in production build.

## [v0.9.17] - 2026-01-13
### ✨ New Features
- **SessionTracker**: Implemented "Mini-Git" to track live file changes and detect diagram staleness.
- **Smart Staleness**: Warns user if diagrams are <5% (clean), 5-15% (minor drift), or >15% (needs regen) outdated.
- **New AI Tools**: `get_session_changes()` and `get_dev_server_port()`.

### 📚 Documentation
- **Architecture Rewrite**: Rewrote `docs/architecture.md` to accurately reflect Atlarix (Electron+React) architecture.
- **Tool Verification**: Verified all 55 tools in `src/lib/tools/`.

### 🐛 Bug Fixes
- **Right Panel**: Fixed stale diagram state persisting in Global Prompts.
- **AI Context**: Fixed missing file paths in "Fix with AI" prompts.

## [v0.9.16] - 2026-01-10
### 🚀 Right Panel & Documentation
- **Right Panel**: Completed documentation for all 7 tabs.
- **Port Info**: Clarified Atlarix (5173) vs User App ports.
- **Mermaid Support**: Standardized on Mermaid.js for diagrams.
- **Docs**: Updated AGENTS.md and AGENTS_COMPACT.md with new Right Panel guidance.

## [v0.9.15] - 2026-01-09 (WIP)

### Error Handling Investigation

This session focused on debugging error persistence and AI hallucination issues.

#### Changes Made
- **Todo Approach**: Simplified error clearing logic to clear ALL errors on success signals (HMR success, operation complete, full reload)
- **Edit Button**: Added "Edit" button to individual error cards for quick file editing
- **Line Number Regex**: Fixed `extractLineNumber` to handle URLs with port numbers (was matching port instead of line number)

#### Root Causes Identified

| Issue | Root Cause | Status |
|-------|------------|--------|
| Errors not clearing | CDP browser console buffer not cleared, old errors re-reported | Identified |
| AI doesn't see file paths | Field mismatch: `ParsedError.file` vs `handleSolveWithAI.source` | Identified |
| Duplicate messages | IPC sent to all windows + React StrictMode double-mount | Suspected |
| Monaco cursor jumping | Line highlighting triggers re-render during typing | Suspected |

#### Files Modified
- `src/hooks/useBrowserErrorListener.ts` - Simplified error clearing, fixed line number regex
- `src/components/preview_panel/CodePreviewPanel.tsx` - Added Edit button to error cards
- `src/ipc/handlers/permissions/interceptor.ts` - Simplified emitStatus (removed unused filePath)
- `TODO.md` - Added v0.9.15 investigation summary with fix plan

## [v0.9.14] - 2026-01-08

### AGENTS.md Context Optimization (StackSense Approach)

This release dramatically reduces AI context usage, making Atlarix work on small context models (Ollama 8K).

#### New Files
- **AGENTS.md** - Single source of truth for all 55 tools (1464 lines, 34KB)
  - Full documentation for every tool with parameters and examples
  - Decision trees for workspace exploration, bug fixing, feature adding
  - Common workflows (CLI → Template → Manual priority)
  - Critical rules (code style, sequential commands)
  
- **AGENTS_COMPACT.md** - Essential guidance for 8K models (~100 lines, 3KB)
  - Core tools and workflows only
  - Fits in small context windows

#### system_prompt.ts Stripped
- **770 lines → 153 lines** (80% reduction!)
- Removed embedded guidance (now lives in AGENTS.md)
- Removed "agent mode" (UI only has build/ask)
- Added `getAgentsMdForContextSize()` for model-aware loading

#### Tool Descriptions Trimmed
- 9 tool descriptions reduced to one-liners:
  - `web_search`, `check_command_status`, `get_project_structure`
  - `get_diagram`, `create_workspace`, `search_templates`
  - `apply_template`, `preview_changes`, `batch_read_files`

#### Token Usage (8K Model)
| Before | After |
|--------|-------|
| ~19,000 tokens (overflow!) | ~6,050 tokens |
| No chat room | ~2,000 tokens for chat |

#### Files Modified
- `AGENTS.md` - Created (55 tools documented)
- `AGENTS_COMPACT.md` - Created (essential guidance)
- `src/prompts/system_prompt.ts` - Rewritten (770→153 lines)
- `src/lib/tools/web-tools.ts` - Trimmed descriptions
- `src/lib/tools/execution-tools.ts` - Trimmed descriptions
- `src/lib/tools/project-structure-tools.ts` - Trimmed descriptions
- `src/lib/tools/diagram-tools.ts` - Trimmed descriptions
- `src/lib/tools/workspace-tools.ts` - Trimmed descriptions
- `src/lib/tools/ai-template-tools.ts` - Trimmed descriptions
- `src/lib/tools/meta-tools.ts` - Trimmed descriptions
- `TODO.md` - Updated v0.9.14 progress

## [v0.9.12] - 2026-01-07

### Chat Session Persistence
- **Fixed**: Chat sessions now persist when navigating to Settings/Library/Diagram pages
- **New**: Hidden div approach keeps chat mounted but visually hidden during navigation
- **Improvement**: Streaming continues even when chat is hidden

### Diagram State Notifiers
- **New**: Staleness detection sends IPC events when AI modifies files
- **New**: `diagramStalenessAtom` tracks when diagram needs refresh
- **New**: Staleness banner in DiagramPanel shows when outdated
- **New**: IPC channel `diagram:staleness-detected` whitelisted in preload.ts

### Live Code Editor (Code Tab)
- **New**: Monaco-based editor for files with errors
- **New**: Collapsible file list showing files with error counts
- **New**: Cmd/Ctrl+S to save changes directly from the editor
- **New**: Unsaved changes indicator (amber dot)
- **New**: Error line highlighting (red/yellow underlines like IDE)
- **New**: Auto-position cursor at first error on file open
- **New**: IPC handlers for file read/write operations

### UI Improvements
- **Changed**: Removed top 4-icon mode toolbar (simplified to single 7-tab bar)
- **Added**: Diagram tab to secondary toolbar (now 7 tabs total)
- **Fixed**: URL path parsing - extracts real paths from `http://localhost:5174/src/...`
- **Fixed**: Filters out CDN/library files from error file list

### Error Filtering
- **New**: `shouldIgnoreError` filter in useBrowserErrorListener
- **Filters**: Monaco `inmemory://model` errors
- **Filters**: CDN library errors (jsdelivr, unpkg, esm.sh)
- **Filters**: Browser extension errors
- **Filters**: Chrome Autofill DevTools errors

### Monaco Editor Improvements
- **Fixed**: Disabled built-in TypeScript validation (prevents inmemory errors)
- **Fixed**: Error markers auto-apply after file loads (100ms retry)
- **New**: Squiggly underlines at error locations like real IDE

### Files Modified
- `src/app/layout.tsx`: PersistentChatContainer for session persistence
- `src/ipc/handlers/file_handlers.ts`: [NEW] File read/write/stats IPC handlers
- `src/components/preview_panel/ErrorFileEditor.tsx`: [NEW] Monaco-based editor
- `src/components/preview_panel/CodePreviewPanel.tsx`: DiagramTab, workspacePath
- `src/hooks/useRightPanelContext.ts`: Added diagram tab, workspacePath from currentAppAtom
- `src/hooks/useBrowserErrorListener.ts`: Added shouldIgnoreError filter
- `src/components/RightPanel.tsx`: Removed top toolbar, simplified to tabs only
- `src/preload.ts`: Whitelisted file operation and diagram channels

## [v0.9.11] - 2026-01-07


### Error Capture UX Improvements

#### CDP-Based Browser Error Capture
- **New**: Replaced proxy-based capture with Electron's `webContents.debugger` API (CDP)
- **Filter**: Atlarix's own errors (port 5173) and internal Electron warnings filtered out
- **Reliability**: Direct access to iframe console without injection race conditions

#### "Fix with AI" Button
- **Fixed**: Button now correctly pre-fills chat input (was using local state instead of atom)
- **Added**: Textarea auto-resizes when pre-filled with error prompt
- **Simplified**: Error prompt format - clean "Error: ... File: ..." (no redundant markdown/stack)

#### "Suggest" Button (New Feature)
- **New**: Users can add their own suggestions/notes when sending errors to AI
- **UI**: Inline input field appears when Suggest is clicked
- **Format**: Combined prompt includes error + user's suggestion for better AI context

#### Files Modified
- `src/ipc/handlers/console_debugger.ts`: Added `isAtlarixOrInternalError` filter
- `src/components/SimpleChatInput.tsx`: Changed to use `chatInputValueAtom` + auto-resize
- `src/components/RightPanel.tsx`: Simplified error prompt format, handles user suggestions
- `src/components/preview_panel/CodePreviewPanel.tsx`: Added Suggest button in ErrorsTab
- `src/preload.ts`: Whitelisted `browser-console-error` IPC channel

## [v0.9.10] - 2026-01-05
## [v0.9.5] - 2026-01-06

### Added
- **Hybrid Error Detection System**:
  - Implemented `devServerErrorParser` to capture errors from terminal output (Vite, Next.js, Python, Go, Rust).
  - Added **LSP-Lite (Type Watcher)**: Runs `tsc --watch` in background to catch type errors (like missing exports) that bundlers ignore.
  - Unified "Errors" tab displaying both Build and Runtime errors.
- **Smart Error UI**:
  - Errors grouped by file.
  - "Fix with AI" button for one-click resolution.
  - Framework badges and severity indicators.

### Fixed
- **Silent Type Errors**: Fixed issue where "Module not found" errors were ignored by Vite and invisible in terminal.
- **Linting**: Resolved TS lint errors in `useBrowserErrorListener` and `CodePreviewPanel`.

### Known Issues
- **Early Browser Errors**: Runtime errors triggering strictly on initial page load (ms 0) may still occasionally slip past the browser injector, though the new Watcher catches the underlying cause in most cases.

### 🎨 Right Panel UX Improvements

#### Terminal Output Formatting
- **Fixed**: Terminal output now properly formatted with line breaks instead of one paragraph
- **Added**: ANSI color code stripping for cleaner display
- **Improvement**: Leading empty lines filtered out automatically

#### Tab Navigation Improvements
- **Fixed**: Tab names no longer truncated (increased from `text-xs` to `text-sm`)
- **Added**: `whitespace-nowrap` and `flex-shrink-0` to prevent text cutting
- **Improvement**: Tab container now horizontally scrollable if needed

#### Browser Error Capture (WIP)
- **Added**: New "Errors" tab in code preview panel
- **Added**: Collapsible error cards with stack traces
- **Added**: "Solve with AI" button to pre-fill chat with error context
- **Infrastructure**: Error capture proxy and injection script created
- **Known Issue**: Proxy not starting correctly - errors not yet being captured from iframe
- **Note**: Proxy approach will be replaced by CDP in v0.9.11

#### Files Modified
- `src/components/RightPanel.tsx`: Improved tab styling and sizing
- `src/components/preview_panel/CodePreviewPanel.tsx`: Added ErrorsTab with collapsible cards
- `src/hooks/useRightPanelContext.ts`: Fixed terminal output formatting with ANSI stripping
- `src/lib/error_capture_proxy.ts`: Created HTTP proxy for error script injection
- `src/lib/dev_server_manager.ts`: Integrated error capture proxy (pending fixes)
- `src/hooks/useBrowserErrorListener.ts`: Added message listener for browser errors
- `src/atoms/sourceAtoms.ts`: Added `browserErrorsAtom` for error storage

## [v0.9.9] - 2026-01-03

### 🎨 Unified Permission Card UI

#### Data Extraction Fix
- **FIXED**: "Unknown operation" display bug - commands now show correctly
- **Root Cause**: Frontend extracted `request.command` but data was in `request.preview.command`
- **Solution**: Updated `PermissionQueuePanel.tsx` to extract from `preview` object

#### Collapsible Operation Cards
- **New design**: Each operation displays as a collapsible card (like ThinkingCard)
- **Header**: Icon + command/filename + inline Approve/Reject buttons
- **Expandable**: Click chevron to reveal full command/diff preview
- **Status badges**: Pending → Running → Completed/Failed

#### Simplified Panel
- **Unified view**: Removed separate Files/Diff/Approve tabs
- **PermissionQueuePanel**: Now the single source of truth for all operations
- **Cleaner UI**: No more visual duplication between tabs

#### Emerald Theme Integration
- **Updated colors**: All hardcoded slate colors → theme variables
- **StatusBadge**: Yellow→amber, cyan→emerald, green→emerald
- **OperationCard**: Uses `bg-card`, `border-border`, `text-foreground`
- **Approve buttons**: Green→emerald to match app theme

#### Files Modified
- `src/components/PermissionQueuePanel.tsx`: Fixed data extraction, redesigned OperationCard
- `src/components/preview_panel/FileDiffPanel.tsx`: Simplified to render PermissionQueuePanel directly
- `src/hooks/useRightPanelContext.ts`: Removed unused tabs for file-diff panel

### 🔄 Agentic Loop Continuation (Option A)

#### Root Cause
- AI stopped after approved commands (e.g., `npm install`)
- Loop only checked for text-based tool calls (MiniMax XML format)
- Native function calling (Claude, GPT via OpenRouter) wasn't detected

#### Solution
- Added `hadToolExecution` flag to track ALL tool executions
- Check `permissionInterceptor.getPendingOperations()` for native tool calls
- Loop continues if tools executed (regardless of format)
- Error feedback already works via tool results message

#### Files Modified
- `src/ipc/handlers/chat_stream_handlers.ts`: Added tool execution tracking

### 🗺️ Diagram Path Fix

#### Root Cause
- "Not in folder" error for imported projects
- Code used `getAtlarixAppPath(app.name)` → created wrong path
- Should use `app.path` directly (actual project location)

#### Solution
- Changed to use `app.path` for both `diagram:generate-ai` and `diagram:regenerate-background`

#### Files Modified
- `src/ipc/handlers/diagram_handlers.ts`: Fixed path resolution

### 🤖 Dev Server Error Auto-Reporter

#### Feature
- ThinkingCard-style collapsible error banner in preview panel
- One-click "Fix with AI" for quick error reporting
- "Edit" mode for developers to add custom instructions
- Comprehensive error context sent to AI (server URL, source, notes)

#### Files Modified
- `src/components/preview_panel/PreviewIframe.tsx`: Enhanced ErrorBanner component

### 📺 Preview Panel Visibility

#### Issue
- After `npm run dev` completed, the right panel stayed on "permission" mode instead of switching to preview

#### Solution
- Added `terminal-output` event listener in permission handlers
- Emits `show-preview` intent when dev server completes successfully
- Added `show-preview` to `AIPanelIntent` type and `mapIntentToView` function

#### Files Modified
- `src/ipc/handlers/permissions/handlers.ts`: Added terminal-output listener
- `src/atoms/sourceAtoms.ts`: Added show-preview intent mapping

### 🔄 Improved Agentic Loop Tracking

#### Issue
- Loop showed "0 tools executed" even after commands completed
- `getPendingOperations()` checked after operations were resolved

#### Solution
- Added `getAllOperationsCount()` to PermissionInterceptor
- Compare operation count before/after stream to detect native tool calls
- Loop now continues properly after any tool execution

#### Files Modified
- `src/ipc/handlers/permissions/interceptor.ts`: Added tracking methods
- `src/ipc/handlers/chat_stream_handlers.ts`: Fixed detection logic

---

## [v0.9.8] - 2026-01-03

### 🔧 Permission Queue Integration

#### Unified FileDiffPanel
- **Merged PermissionQueuePanel** into FileDiffPanel's Approve tab
- **Simplified routing**: `show-permissions` intent → `file-diff` panel
- **No more dual panels**: Single panel handles both file changes and permissions
- **Real-time updates**: Permissions load via IPC `permission-request` events

#### Files Modified
- `src/atoms/sourceAtoms.ts`: Reverted `show-permissions` → `file-diff` mapping
- `src/components/preview_panel/FileDiffPanel.tsx`: Approve tab now shows PermissionQueuePanel
- `src/ipc/handlers/permissions/handlers.ts`: Added `permission-request` IPC emission
- `src/components/PermissionQueuePanel.tsx`: Added useEffect for loading permissions

### 🚀 Workspace Delete UI Fix
- **Instant UI update**: Workspace disappears immediately on delete click
- **Optimistic update**: UI updates before backend confirms deletion
- **Graceful handling**: "Already deleted" errors ignored silently
- **Auto-navigate**: Returns to home when current workspace deleted

### 🐛 Bug Fixes
- **FIXED**: AI `Invalid prompt: The messages must be a ModelMessage[]` error
  - Restored `chat_stream_handlers.ts` to stable commit 4a2b440
  - Error was caused by message format incompatibility
- **Removed PlantUML code**: DiagramPanel no longer shows raw PlantUML code
- **IPC whitelist**: Added `operation-status` and `auto-recovery-needed` channels

## [v0.9.7] - 2026-01-02

### 🚀 Command Execution Wait Fix (Critical)

#### Core Fix
- **FIXED**: AI now waits for commands to complete before issuing next command
- **Root Cause**: `resolveApproval()` was called BEFORE command execution, not after
- **Solution**: Moved approval resolution to AFTER `executeRunCommand()` completes
- **Sequential Execution**: `executeAllOperations()` now runs commands sequentially

#### Smart Output Formatting
- **Priority Slicing**: Command output limited to 1500 chars with intelligent truncation
- **Extraction Order**: Errors → Warnings → First 5 lines → Last 5 lines
- **AI Context**: AI now receives formatted terminal output for decision making

#### Timeout Protection
- **5-Minute Default**: Commands timeout after 300 seconds (configurable)
- **Progress Updates**: UI updates every 2 seconds for long-running commands
- **Error Storage**: Timeout/failure info captured for AI context

### 🔧 Technical Changes

#### Files Modified
- `src/ipc/handlers/permissions/interceptor.ts`
  - Moved `resolveApproval()` to after execution completes
  - Added `CommandExecutionResult` interface with timing info
  - Added `formatCommandOutput()` with smart slicing
  - Changed `executeAllOperations()` to sequential execution
  - Added timeout with `Promise.race()` and progress interval
  - Added `queueCapture()` for timeline auto-capture after file ops

### 🌐 Live Preview (Lovable-style)
- **Auto-Start Dev Server**: DevServerProvider detects frontend projects and starts server
- **Iframe Preview**: RightPanel Preview tab with responsive viewport controls
- **Framework Detection**: Vite, Next.js, Create React App, Nuxt, Astro
- **Backend Fallback**: Auto-pins diagram panel for non-frontend projects

### 📊 Timeline & Project Evolution
- **Auto-Capture**: Diagram snapshots on AI file changes (5-min debounce)
- **11 Timeline IPC Channels**: Full timeline API for project evolution
- **AI Awareness**: System prompt teaches Lovable-style workflow

### 💰 Token-Saving Stop Button
- **chat:abort IPC**: Cancels backend AI stream immediately
- **abortAllStreams()**: Cleanup on app quit
- **Stop Button Wired**: SimpleChatInput + ChatInput call abort to save tokens

### 🐛 Bug Fixes
- **PlantUMLPreview null check**: Fixed undefined split error
- **Database paths documented**: Dev vs Production DB locations

## [v0.9.6] - 2026-01-01

### 🎉 New Features

#### Global & Workspace Prompts System
- **Global AI Behavior**: Define custom instructions that apply to all incognito chats
- **Workspace Prompts**: Per-project AI instructions for workspace-specific context
- **Library Page Redesign**: Clean UI with Global prompt editor + paginated workspace prompts
- **Character Limit**: 2000 characters with visual counter

#### New Chat Button
- **Hover-Reveal Header**: Subtle "← New Chat" button appears at top of active chats
- **Session Persistence**: Chat sessions now persist across navigation (Settings → Home)
- **Jotai Atom**: `activeChatIdAtom` ensures chat state survives component unmounts

### 🐛 Bug Fixes

#### LM Studio Error Handling
- **FIXED**: Technical stack traces replaced with user-friendly messages
- **New Message**: "LM Studio not running. Please start LM Studio and load a model."
- **Graceful Degradation**: Connection errors no longer crash the model picker

#### MiniMax Content Duplication
- **FIXED**: MiniMax 2.1 "Interleaved Thinking" caused responses to appear twice
- **Deduplication Logic**: `cleanFullResponse.ts` now detects and removes exact content repeats
- **Reasoning Support**: Works with both `<think>` block responses and plain text

#### Chat History Display
- **FIXED**: Ephemeral chat history now shows all previous messages, not just current exchange
- **Scroll Preservation**: Auto-scroll only triggers after streaming starts, not on initial load

#### Permission Request Flow
- **FIXED**: Sequential AI permission requests now display correctly
- **Timestamp Fix**: Unique timestamps force frontend to re-process intents

### 🔧 Technical Changes

#### Files Created
- None

#### Files Modified
- `src/atoms/chatAtoms.ts` - Added `activeChatIdAtom` for session persistence
- `src/pages/atlarix-home.tsx` - New Chat button, session persistence via Jotai
- `src/pages/library.tsx` - Complete redesign for Global + Workspace prompts
- `src/ipc/handlers/prompt_handlers.ts` - New prompt system IPC handlers
- `src/ipc/handlers/local_model_lmstudio_handler.ts` - Friendly error handling
- `src/ipc/ipc_types.ts` - Added `error` field to `LocalModelListResponse`
- `src/ipc/utils/cleanFullResponse.ts` - Content deduplication for reasoning models
- `src/hooks/useLMStudioModels.ts` - Parse error field from response
- `src/db/schema.ts` - New prompts table with type/workspaceId fields

---

## [v0.9.5] - 2025-12-31

### 🎉 Major Features

#### AI-Controlled Right Panel
- **Explicit AI Intent**: AI now explicitly sets what the right panel shows instead of heuristic guessing
- **aiControlledPanelAtom**: New Jotai atom that takes priority over pinned/heuristic panel detection
- **Permission Panel**: New dedicated panel type (`'permission'`) for showing pending approval requests
- **IPC Integration**: Backend emits `right-panel:set-view` events when permissions are buffered
- **useAIPanelListener Hook**: Frontend hook that receives and applies AI panel updates

### 🐛 Bug Fixes

#### Prompt Box Clipping (Critical)
- **FIXED**: Mode switcher (Build/Ask) and model picker were hidden after first message
- **Root Cause**: ChatInput area was being compressed due to missing flex-shrink-0
- **Solution**: Wrapped ChatInput in flex-shrink-0 container in ChatPanel.tsx

#### Stream Cancel Error
- **FIXED**: "No callbacks found for chat -1" error when stopping generation
- **Changed**: console.error → console.debug (expected behavior when cancelling)

### 🔧 Technical Changes

#### Files Created
- `src/hooks/useAIPanelListener.ts` - Listens for AI panel updates from main process

#### Files Modified
- `src/atoms/sourceAtoms.ts` - Added AIPanelState interface and aiControlledPanelAtom
- `src/hooks/useRightPanelContext.ts` - Prioritizes AI state over heuristics
- `src/components/RightPanel.tsx` - Added PermissionPanel component
- `src/components/ChatPanel.tsx` - Fixed prompt box clipping with flex-shrink-0
- `src/ipc/handlers/permissions/handlers.ts` - Sends panel updates via IPC
- `src/preload.ts` - Whitelisted 'right-panel:set-view' channel
- `src/ipc/ipc_client.ts` - Silenced expected stream-end debug message

---

## [v0.9.4] - 2025-12-31

### 🎉 Major Features

#### Real AI Diagram Generation
- **AI-Powered Analysis**: Diagrams now generated by analyzing actual codebase structure
- **Codebase Extraction**: Reads project files (respecting .gitignore) and sends to AI
- **Smart Prompting**: System prompt guides AI to create architecture-focused Mermaid diagrams
- **Path Bug Fix**: Correctly handles imported apps with absolute paths

#### Pan/Zoom Diagram Controls
- **react-zoom-pan-pinch**: Professional pan/zoom library integration
- **Drag to Pan**: Click and drag to navigate large diagrams
- **Scroll to Zoom**: Mouse wheel zooms in/out smoothly
- **Zoom Controls**: +, -, Reset View, Center View buttons
- **Hint Bar**: Shows "Drag to pan • Scroll to zoom • Double-click to reset"

#### Version History Sidebar
- **History Toggle**: "History" button in diagram header toolbar
- **Collapsible Panel**: Side panel shows all historical versions
- **Smart Timestamps**: "Today at 2:30 PM" vs "Dec 31, 2:30 PM"
- **Restore Button**: One-click restore to any previous version
- **Empty State**: Friendly message when no history exists

### 🔧 Technical Changes

#### Files Created
- None (used existing infrastructure)

#### Files Modified
- `src/components/MermaidRenderer.tsx` - Complete rewrite with TransformWrapper
- `src/pages/diagram.tsx` - Added history state, handlers, sidebar UI
- `src/ipc/handlers/diagram_handlers.ts` - Added `diagram:generate-ai` handler
- `src/ipc/ipc_client.ts` - Added `generateAiDiagram()` method
- `src/preload.ts` - Whitelisted `diagram:generate-ai` channel
- `package.json` - Added `react-zoom-pan-pinch` dependency

---

## [v0.9.2] - 2025-12-30

### 🚀 New Features
- **Smart Project Scaffolding**: AI now uses CLI commands first (`npx create-vite`, `npx create-next-app`, etc.) instead of writing files from scratch
- **Session Memory Persistence**: Memory now persists across Ask → Build mode switches (keyed by appId instead of chatId)
- **Permission Sound Notification**: Plays `remaining.mp3` when new file proposals arrive after initial batch approved
- **SearxNG Template Fallback**: When GitHub API is rate-limited, templates are fetched via SearxNG search

### 🔧 Technical Improvements
- **scaffold_commands.ts**: New library with 25+ framework CLI mappings
- **Command Approval UI**: Extended `FileProposal` type to support `command` operations
- **FileDiffPanel**: Commands now grouped under "⚡ Commands" with purple icon

### 🐛 Known Issues
- **Command Approval Not Showing**: `run_command` permissions not appearing in right panel (needs deeper investigation)
- **AI Repetition**: Model sometimes repeats previous messages (model behavior, not code issue)

---

## [v0.9.1] - 2025-12-29

### ✅ Bug Fixes
- **Input Box Clipping**: Fixed - Added `min-h-0` to flex containers + `flex-shrink-0` to input
- **Chat Scroll**: Fixed - Added `min-h-0` to enable proper overflow
- **ThinkingCard in Ask Mode**: Fixed - Added `<think>` tag instructions to chat-only prompt
- **Permission System**: All 4 phases complete - AI tools properly block for user approval

### 🚀 Enhancements
- **Session Memory**: In-memory buffer of last 5 exchanges for conversation continuity
- **Session Cleanup**: Memory cleared on new chat creation and app quit
- **Right Panel Empty State**: Improved empty state with mode explanations

### 🐛 Known Issues (v1.0)
- **Right Panel Toggle**: Keyboard shortcuts not fully working (Cmd+B system conflict)
- **Diagrams Page Empty**: Diagrams not persisting to sidebar page

---

## [v0.9.0] - 2025-12-28

### 🎉 Major Features

#### Permission System (Build Mode)
- **Structured JSON Permissions**: Tools return JSON permission requests for user approval
- **PermissionInterceptor**: Buffers operations, validates with Zod schemas
- **FileDiffPanel**: Shows file proposals with Approve All / Reject All buttons
- **IPC Integration**: Frontend communicates with backend via executePermission/rejectPermission

#### Right Panel Improvements
- **Context-Aware Display**: Auto-switches based on content (file-diff, diagram, web-search)
- **Removed Tools Tab**: ThinkingCard now handles tool display
- **Diagram Wiring**: Diagram tools now populate diagramStateAtom automatically

#### Planned Fixes
- [ ] **Chat Memory Cache**: Cache last 5 chats for AI context continuity
- [ ] **Web Search Sources**: Make file code show like web search results

### 🔧 Technical Changes

#### Files Created
- `src/lib/tools/permissions/schema.ts` - Zod schemas for permission requests
- `src/ipc/handlers/permissions/interceptor.ts` - Permission buffering and execution
- `src/ipc/handlers/permissions/handlers.ts` - IPC handlers for approve/reject
- `src/ipc/handlers/permissions/index.ts` - Module exports

#### Files Modified
- `src/lib/tools/file-tools.ts` - write_file returns JSON permission request
- `src/ipc/handlers/chat_stream_handlers.ts` - Integrated PermissionInterceptor
- `src/ipc/ipc_client.ts` - Added 5 permission methods + onPermissionRequest handler
- `src/hooks/useStreamChat.ts` - Wires permissions to pendingProposalsAtom
- `src/hooks/useRightPanelContext.ts` - Removed tools panel from routing
- `src/components/preview_panel/FileDiffPanel.tsx` - IPC buttons with loading state
- `src/components/RightPanel.tsx` - Removed Tools button from toolbar

---

## [v0.8.0] - 2025-12-27

### 🎉 Major Features

#### ThinkingCard UI (Claude-style)
- **Two Independent Cards**: Thinking and Response as separate, non-connected cards
- **Collapsed by Default**: ThinkingCard shows summary, click to expand details
- **No Streaming Lag**: Cards are independent, streaming doesn't cause UI bugs
- **Clean Layout**: Answer always visible, thinking tucked away

#### Absolute Path Storage
- **Full Path Support**: Projects now store absolute paths in database
- **Backward Compatible**: `resolveAppPath()` helper handles both old relative and new absolute paths
- **Fresh Import**: New projects correctly point to their original location

---

## [v0.7.0] - 2025-12-27

### 🎉 Major Features

#### Ask Mode with Read-Only Tools
- **Smart Tool Filtering**: `isReadOnly` flag on all tools enables safe Ask mode exploration
- **21 Read-Only Tools**: `read_file`, `list_files`, `search_code`, `find_file`, `get_diagram`, etc.
- **Workspace Aware**: Tools automatically resolve paths relative to workspace
- **Memory Integration**: `recall_memory` and `search_memory` tools for context retrieval

#### Compact Tool Summary UI (Claude-style)
- **Grouped Badges**: Consecutive tool calls grouped into one compact bar
- **Expandable Details**: Click to see individual tool calls and results
- **Native Tool Tags**: Ask mode now uses `atlarix-tool-call` tags

---

## [v0.6.0] - 2025-12-27

### Diagram Timeline System
- **Project Evolution**: Visualize architecture changes over time
- **Smart Snapshots**: Auto-capture on file changes with deduplication
- **Time Drill-Down**: Navigate from "All Time" down to hourly changes

---

## [v0.4.0] - 2025-12-25

### 3-Panel Layout
- Left, Middle (Chat), Right (Context) panels
- Web search, File diff, Diagrams in right panel
- One-click SearxNG Docker setup

---

**Last Updated**: 2026-01-17
**Version**: v1.0.1 (DMG Update)
