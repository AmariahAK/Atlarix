# Atlarix

**Atlas + Axis + Intelligence**

Atlarix is your premium AI coding copilot — a powerful desktop application that combines intelligent code understanding with visual architecture design.

**Created by:** [NorahLabs](https://norahlabs.com)  
**Website:** [atlarix.dev](https://atlarix.dev)

*Current: v6.1.12*

**Downloads:** The latest installers (macOS and Linux) are on [atlarix.dev](https://atlarix.dev). The **Windows** build is currently in development and not yet available; once EV/OV code signing is in place, Windows will be added to releases.

### What's New in v6.1.12

- Mermaid normalization for diagram page and AI-saved diagrams (prefix/fences/style hex); diagram remount + render retry.

### Earlier: v6.1.1

- **Diagram git:** Internal diagram snapshot repos no longer copy workspace `userData` / `.cursor`, avoiding `git add` failures during AI diagram updates.
- **Blueprint:** Container canvas runs ELK layout reliably on first open (no more stacked “blob” until Re-layout under React Strict Mode).
- **Preview:** When a managed dev server is up (e.g. Next on port 3000) but the dyad proxy URL is unset, the Preview tab uses the dev-server URL.

### What's New in v6.1.0

- **Build / migrations:** Main-process Vite uses a **`raw-sql`** plugin (`transform` + `enforce: "pre"`) so `.sql` modules from [`bundled.generated.ts`](src/db/migrations/bundled.generated.ts) stringify correctly (no conflicting `assetsInclude`). New migrations **`0032_pivot_tables`** (pivot graph + blueprint snapshots) and **`0034_prompts_new_schema`** (prompts `type` / `workspace_id`, drops legacy `title`); seed verification extended. **`prompts:get-global`** and related flows align with the new prompts schema.

### What's New in v6.0.3

- **Embedded SQLite migrations (main bundle):** Earlier approach used `assetsInclude` + `load`; v6.1.0 replaces that with the transform plugin above for reliable inlining across environments.

### What's New in v6.0.2

- **Workforce:** The sidebar/workspace list again allows adding or importing additional project workspaces on the Workforce tier (the UI previously treated only Pro as unlimited).
- **Diagrams:** AI diagram generation works when **Auto** model routing is enabled — the multi-model fallback wrapper now implements `doGenerate`, which `generateText` requires (fixes “doGenerate is not supported for fallback model” in production).

### What's New in v6.0.1

- **Streaming:** Reasoning blocks from the model are always closed when a turn ends (`reasoning-end` and end-of-stream flush), fixing replies that could appear cut off mid-message. Thinking-tag cleanup and post-thinking deduplication recognize both short `think` and long-form provider closing tags.
- **Output budget:** If a model has no catalogued `maxOutputTokens`, the stream uses a safe floor so providers do not fall back to an overly small completion limit.
- **Agent docs:** `AGENTS.md` / `AGENTS_COMPACT.md` updated with product identity (NorahLabs, atlarix.dev), current modes, Compass, Guided/Autonomous, and Workforce session behavior.

### What's New in v6.0

- **Workforce (session scope):** Connected tools (Slack, GitHub, Jira, etc.) use **per-chat** workspace choices stored in memory only; starting a new chat clears them. The AI sees your selections in the Workforce context block for that session. Legacy “base of origin” pre-configuration for repos/channels was removed in favor of this flow.
- **Autonomous mode:** Specialist runs can proceed **without per-tool approval dialogs** (Ask/Plan/Build restrictions still apply). You still confirm Workforce scope when needed; completed runs surface a **summary** of tools and changes for review before you commit.
- **Chat & UX:** Clearer **Ask vs Plan** behavior, streaming **phase and tool labels**, **models.dev** refresh timeout + UI notice, **Compass** usage visible during chat with milestone warnings, **fullscreen** hit areas and title bar behavior fixes, **New Chat** always visible, deep links for code preview, and expanded onboarding (continuity, right panel).
- **Agents UI & startup:** **Thoughts** panel (group-style activity from the activity stream), **Compass** canvas loading instead of a static logo on cold start and home loading, **Blueprint** canvas controls moved out of React Flow overlays for reliable **click targets**.
- **Auto routing:** Two-stage routing — **heuristics** plus optional **fast-model** classification when confidence is low — picks **Fast / Balanced / Thinking**; activity can show a **suggested specialist** (e.g. Architect) for delegation hints.

**Linux (v5.2.3+):** Packaged Linux builds disable Chromium sandboxing in Forge, register `atlarix://` for `.deb` / `.rpm`, handle cold-start OAuth deep links, and refresh login-shell PATH for local models. Details: [docs/CHANGELOG.md](docs/CHANGELOG.md).

**Recent (v4.3):** UX and workflow upgrade: secure session persistence across restarts, guided Shepherd tours, corrected subscription entitlement timing/copy, Ask-mode planning improvements, Workforce Ask/Build read-write split, batch Token Auth permissions (`request_workspace_permissions`), and hardware-aware Ollama model recommendations in Settings.

### What's New in v5.1 — Compass (managed AI, no API key)

- **Compass** is a first-class cloud provider backed by OpenRouter with a **build-time** API key only (never user-facing OpenRouter). Three tiers in-product — **Fast**, **Balanced**, **Thinking** — with **Free** limited to Fast; **Pro** and **Workforce** get all three.
- **Monthly token limits** are enforced per signed-in user via Supabase (`compass_tokens`, RPCs `get_compass_usage_state` / `record_compass_usage`); see [docs/compass-limits.md](docs/compass-limits.md).
- **CI / local builds:** set repository secrets `COMPASS_OPENROUTER_API_KEY`, `COMPASS_MODEL_FAST`, `COMPASS_MODEL_BALANCED`, `COMPASS_MODEL_THINKING`. They are injected only into the **main** process via `vite.main.config.mts` (`MAIN_KEYS`), not the renderer bundle.

### What's New in v5.0 — Blueprint context, project memory, and ignore rules

v5.0 completes the Blueprint-context and project-memory work and ships it as the default experience; see [docs/TODO.md](docs/TODO.md) for follow-ups and historical notes.

- **Section 1 — Tiered Blueprint injection:** The system prompt can include the Blueprint at different detail levels (**Ask / Plan / Build / Debug**) with separate token budgets. **Build** uses RAG-selected code snippets with a strict token cap and explicit messaging when snippets are omitted (no silent overflow). v5 discovery flow now prefers **targeted blueprint slices** (`get_blueprint_slice`) over full-graph mandatory fetches. Implementation lives in [`src/lib/blueprint/blueprintPromptTiers.ts`](src/lib/blueprint/blueprintPromptTiers.ts) and [`src/ipc/handlers/chat_stream_handlers.ts`](src/ipc/handlers/chat_stream_handlers.ts). **Section 3** adds **Settings → AI** controls (Auto vs forced tier) and optional Debug context (stack trace / file path), plumbed through `IpcClient.streamMessage` into `ChatStreamParams.blueprintInjectionMode`, `blueprintDebugTrace`, and `blueprintDebugFile` in [`src/ipc/ipc_types.ts`](src/ipc/ipc_types.ts). Precedence on the server is: IPC `blueprintInjectionMode` (from the stream request) first, then the saved settings preference, then heuristics.

**Section 4** adds a **chat Config (sliders) → Blueprint in prompt** override (`blueprintInjectionChatOverrideAtom` in [`src/atoms/chatAtoms.ts`](src/atoms/chatAtoms.ts)): choose **Use Settings** or force Ask / Plan / Build / Debug for the current app session. `useStreamChat` merges this ahead of Settings when calling `streamMessage`, so the in-chat choice wins over Settings until you switch back to **Use Settings**.

- **Work modes (five + Auto):** The chat bar uses a **work mode** dropdown — **Ask, Plan, Build, Debug, Review** — and a separate **Auto** control (sparkles). `workModePreference` is stored in user settings and maps to **Ask vs Build** tool permission and Blueprint tier when Auto is off. Precedence for Blueprint injection is: **in-chat override** (Section 4 atom) → **work-mode tier** → **Settings** → heuristics. Mapping helpers live in [`src/lib/work-mode.ts`](src/lib/work-mode.ts); UI in [`src/components/ChatIntentSelector.tsx`](src/components/ChatIntentSelector.tsx). With no workspace open, mode is pinned to **Ask** and Auto is disabled.

- **Subscription / Supabase Realtime:** Plan row updates from Postgres Realtime only log and notify when **plan / status / period end / effective tier** actually change. [`SubscriptionManager`](src/lib/SubscriptionManager.ts) **serializes** realtime setup (no overlapping listeners) and **dedupes** identical fingerprints within a short window so session refresh and `plan-changed` IPC fire once per real transition.

- **Section 5 — Agent–mode binding & handoffs (kickoff):** Work mode maps to a **default specialist** (e.g. Plan → Architect, Debug → Debugger). A **Debugger** built-in agent joins Research / Architect / Builder / Reviewer. Zod schemas for structured handoffs live in [`src/lib/agents/agent-handoff-schemas.ts`](src/lib/agents/agent-handoff-schemas.ts); a short **Work mode** block is injected into the main stream system prompt when using a manual mode. Deeper delegation threading, Activity Stream events, and handoff UI cards are tracked in [docs/TODO.md](docs/TODO.md).

- **Section 6 — Structured outputs:** Zod validation + one-retry fallback flow is enforced on delegation handoffs and mode-bound Plan/Debug/Review outputs. Structured responses are rendered as report-style cards in chat for these modes, with non-blocking warning fallback when schema validation fails twice.

- **Section 7 — ContextAssembler (implemented):** Prompt-context assembly in stream flow is centralized through `ContextAssembler` with deterministic section ordering, per-mode caps, and session cache reuse. The cap table includes **Review: 2000** tokens. Lower-priority sections trim first under pressure (summary/session memory after higher-priority work-mode and Blueprint context), with concise trim/cache diagnostics logged for observability. `.atlarixignore` filtering is now also applied in the file-tree Blueprint source path for consistency with RTE parse/cache/prompt layers.

- **Section 2 — SQLite project memory:** Persistent **`project_snapshots`** and **`project_memory`** tables (see [`src/db/schema.ts`](src/db/schema.ts), migration `0031_project_memory.sql`) capture blueprint + plan checkpoints and key/value facts. Service: [`src/lib/project-memory/service.ts`](src/lib/project-memory/service.ts). AI tools: `get_project_history`, `revert_to_snapshot` (with `revert_project_snapshot` approval), `set_project_memory`. Snapshots are triggered on blueprint saves (debounced), `.atlarix/ATLARIX_PLAN.md` writes, successful Build turns with file changes, and app quit (`session_end` for touched workspaces).

- **`.atlarixignore`:** Gitignore-syntax patterns (via the [`ignore`](https://www.npmjs.com/package/ignore) package) exclude paths from RTE parsing, from cached Blueprint nodes on load, and as a final filter before prompt injection. A default file is created at the project root on first Blueprint parse when missing. Tools: `get_atlarixignore`, `update_atlarixignore` (Build + approval). The Blueprint panel includes an editable pattern list; IPC: `blueprint:get-atlarixignore` / `blueprint:set-atlarixignore`. Core logic: [`src/lib/atlarix/atlarix-ignore.ts`](src/lib/atlarix/atlarix-ignore.ts).

**Recent (v4.0 — Workforce):** New **Workforce** tier ($79/mo): Auth0 Token Vault for secure agent auth, Workspace Context (Slack, Jira, Linear, CI, Sentry, Calendar), Teams (up to 20 seats), GitLab CI & Bitbucket Pipelines, Progressive Tool Reveal. DB Studio moved to Workforce (existing Pro subscribers grandfathered). Three tiers: Free, Pro ($19/mo), Workforce ($79/mo). Credentials via env — see [SECRETS.md](SECRETS.md) and [.env.example](.env.example).

### Workspace tools & extensions (how it works)

- **Core workspace tools (all tiers)**: When you open a workspace and use **Build** mode, the model always has access to core tools for files, code, search, diagrams, git, and commands. In **Ask** mode it automatically filters to read‑only tools (`read_file`, `list_files`, `search_code`, `get_diagram`, `git_log`, `web_search`, etc.) using each tool’s `isReadOnly` flag (with explicit `allowInAskMode` exceptions, e.g. implementation-plan writes).
- **MCP tools (`@mcp` mentions)**: Add MCP servers in **Settings → Tools → MCP**. In chat, type `@` and pick an MCP server (e.g. `@mcp:MyServer`). The mention is sent in your message so the AI can prefer that server’s tools, but you never call tools manually—the model chooses which MCP tools to invoke.
- **Workforce tools (Slack, Jira/Linear, Sentry, calendar, CI)**: On the **Workforce** tier, connect services via **Token Vault**. Per **chat session**, you pick workspace/repo/channel context when a tool first needs it; that choice is remembered until **New Chat**. Read tools are Ask-safe; write/trigger tools are Build-only with approval. For multi-service auth, the AI can call `request_workspace_permissions(services[])` to open one unified permission panel that excludes already-connected services.
- **Database Extension (DB tools)**: Configure database connections (PostgreSQL, MySQL, SQLite) through the **AI and extensions flow** (no separate Workspace block in Settings). After a connection is active for a workspace, the AI gets DB tools:
  - `db_query` and `db_schema` for read‑only SELECTs and schema inspection  
  - `db_list` to list configured/active connections  
  - `db_mutate` for writes (INSERT/UPDATE/DELETE/DDL) that always require explicit user approval in the permission queue  
  You never paste credentials into chat; connection details live in settings, and the AI interacts with the active connection through these tools.

### Deployment & CI/CD

**Releases** are built and published via GitHub Actions for every version. **GitHub Actions**: in the **left panel**, add the GitHub Actions extension (Pro) to list workflow runs, view job logs, stream logs live, and send logs to the AI. Connect GitHub in Settings → Extensions. Token is read from the Supabase session (`session.provider_token`) when signed in with GitHub. The workflow runs on tag push (`v*`) and **reads all credentials from GitHub repository secrets** — nothing is hardcoded in the repo.

- **Workflow:** [`.github/workflows/release.yml`](.github/workflows/release.yml) — on push of a version tag (e.g. `v4.0.3.23`), creates a draft release on atlarix-releases, builds macOS (arm64/x64) and Linux, uploads assets, then publishes the release.
- **SQLite migrations in installers:** As of **v5.2.0**, migration SQL is **embedded in the main process bundle** (Vite `?raw` imports via [`src/db/migrations/bundled.generated.ts`](src/db/migrations/bundled.generated.ts)); packaged apps do **not** depend on a `drizzle/` folder at runtime. Release builds still use [`forge.config.ts`](forge.config.ts) for natives and `dugite`; keep `npm run db:bundle-sql` (or `postdb:generate`) in sync after new Drizzle migrations.
- **Important for future SQLite migrations:** Avoid bare `type` columns on the packaged SQLite graph/diagram tables. As of **v5.2.2**, `pivot_nodes`, `pivot_edges`, and `diagrams` use `node_type`, `edge_type`, and `diagram_type` plus matching Drizzle field names (`nodeType`, `edgeType`, `diagramType`) to prevent packaged production query failures and keep embedded migrations forward-safe.
- **Secrets:** In the repo go to **Settings → Secrets and variables → Actions** and add the same variables as in [.env.example](.env.example). See [docs/CREDENTIALS_SETUP.md](docs/CREDENTIALS_SETUP.md) for a step-by-step guide to obtain each. Required:  
  `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANT_ID`, `LEMONSQUEEZY_WORKFORCE_VARIANT_ID`, `LEMONSQUEEZY_EXTRA_SEAT_VARIANT_ID`, `LEMONSQUEEZY_WEBHOOK_SECRET`,  
  `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_TOKEN_VAULT_ID`, `AUTH0_AUDIENCE`,  
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`,  
  `SENTRY_DSN`, `POSTHOG_API_KEY`, `RESEND_API_KEY`, `EMAIL_SOURCE`,  
  `COMPASS_OPENROUTER_API_KEY`, `COMPASS_MODEL_FAST`, `COMPASS_MODEL_BALANCED`, `COMPASS_MODEL_THINKING` (managed Compass; main bundle only).  
  For macOS builds: `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_CERT_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_ID`, `APPLE_IDENTITY`, `APPLE_TEAM_ID`.  
  For publishing to a separate releases repo: `RELEASES_TOKEN` (PAT with `repo` scope).  
  `GITHUB_TOKEN` is provided automatically for same-repo releases.
- **All versions:** Every tagged release uses these secrets for the build and publish step.

---

## What's New in v4.0 — Workforce

v4.0 introduces the **Workforce** tier and secure agent authentication.

- **Tiers:** Free ($0), Pro ($19/mo), Workforce ($79/mo, up to 20 seats; extra seats $10/mo).
- **Auth0 Token Vault:** Secure agent auth for Workforce extensions; step-up for high-stakes actions.
- **Workspace Context:** Workforce-only block injected into the system prompt: open PRs, failing pipelines, assigned tickets, unread mentions, Sentry errors, today's meetings (from connected extensions).
- **Teams:** Create a team, invite members, manage seats; shared .atlarix (team-memory.md, Blueprint) via Git.
- **Extensions:** Slack, Google Chat, Jira, Linear, GitLab CI, Bitbucket Pipelines, Sentry, Notion, Google Calendar — connect via Token Vault, no manual credential inputs.
- **Progressive Tool Reveal:** System prompt gets a compact tool manifest; full schemas loaded on first use (core tools always loaded).
- **DB Studio:** Now part of Workforce; existing Pro subscribers keep access (grandfathered).
- **File revert:** "Revert to here" in conversation restores workspace file state from the snapshot at that exchange.
- **CI:** GitHub Actions (Pro), plus GitLab CI and Bitbucket Pipelines (Workforce, Token Vault).

---

## What's New in v2.1 — Agent System and Project Understanding

v2.1 adds a three-tier agent system, built-in specialists, project instruction files, and reorganized AI configuration.

- **Modes:** Direct (no agents), Guided (flat delegation; default), Autonomous (agents can spawn sub-agents; higher token usage).
- **Permission:** Separate Ask (read-only tools) vs Build (can write/run), independent of mode.
- **Built-in agents:** Research, Architect, Builder, Reviewer, Debugger — each with a dedicated tool set and icon (no emojis; Lucide icons).
- **Project instructions:** `.atlarix/ATLARIX.md`, workspace prompts, `~/.atlarix/ATLARIX.md`, bundle AGENTS.md — loaded in precedence order for the system prompt.
- **Self-review and Agent Lightning:** Optional runtime self-review (score, threshold); offline trace collection for future training.
- **Activity Stream:** Right-panel tab showing model selection, delegation, compaction, tool use, and turn summary (Lucide icons only).
- **Auto routing:** When Auto is ON, model picker is hidden; complexity-based routing uses Fast/Medium/Thinking (when configured).
- **AI Configuration:** Settings reorganized with provider/model setup, agent config, quality control, context and summarization, project understanding.

v2.2 (Blueprint Intelligence) built on these systems (e.g. Architect and Builder agents, project instructions).

---

## What's New in v2.2 — Blueprint Intelligence (RTE + RAG)

Atlarix 2.2 transforms the Blueprint from a static diagram into a **living knowledge system** powered by **Round-Trip Engineering (RTE)** and **Retrieval-Augmented Generation (RAG)**.

### Core Concept

**Parse once, query forever.** Instead of progressively learning your codebase, Atlarix parses it fully (RTE parsers per language), generates a Blueprint, and uses it as a RAG knowledge base so the AI answers from the graph and only loads relevant code.

```
┌─────────────────────────────────────────────────────────────┐
│  TRADITIONAL AI CODING                                      │
│  User asks question -> AI scans codebase -> 100K tokens     │
│  Problem: Expensive, slow, no learning                      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  ATLARIX 2.2 (RTE + RAG)                                    │
│  Parse once -> Blueprint cached -> Query graph -> 5K tokens │
│  Code changes: File watcher re-parses affected files only   │
│  Full understanding from session 1; no code stored.          │
└─────────────────────────────────────────────────────────────┘
```

### Key Features (v2.2)

| Feature | Description |
|---------|-------------|
| **One-Time RTE Parsing** | Complete project understanding in &lt;30s; TypeScript, Python, optional others |
| **Blueprint as RAG** | Query graph ("What connects to Auth?"); inject only relevant code into LLM context |
| **Incremental Updates** | File watcher updates affected Blueprint nodes automatically |
| **Combined Blueprints** | Polyrepo/monorepo: one view with frontend/backend/mobile markers and cross-project edges |
| **AI-Selected Blueprinting** | AI chooses which projects to blueprint/diagram (activity, intent); confirmation modal |
| **Parent-Aggregated Permissions** | One approval for entire feature (not per-tool) |
| **Motia-Style Visual UI** | React Flow; nodes (API, WH, FN, CLS, DB, etc.); drag-and-drop, Cmd+K |
| **Blueprint-Driven Planning** | Compare desired vs actual, generate `.atlarix/ATLARIX_PLAN.md`, implement with review gates |

### Step Types

```
[API]    HTTP endpoint (GET, POST, PUT, DELETE)
[WH]     Webhook handler (Stripe, GitHub, etc.)
[FN]     Function (utility, business logic)
[CLS]    Class (OOP container with methods)
[IF]     Conditional branch (routing logic)
[CRON]   Scheduled job
[AI]     AI agent (LLM-powered processing)
[DB]     Database operation
[3P]     Third-party service
[STREAM] WebSocket/SSE
```

### Planning with .atlarix/ATLARIX_PLAN.md

When you design in Blueprint and click "Generate," the AI:
1. Compares Blueprint (desired) to Live (actual)
2. Generates ordered tasks in `.atlarix/ATLARIX_PLAN.md`
3. Implements one task per exchange (user message -> AI response)
4. Waits for your review before proceeding
5. Quality over quantity: fixes bugs before moving on

```markdown
# .atlarix/ATLARIX_PLAN.md

## Overview
Building user authentication with JWT tokens.

## Backend
- [ ] Create /api/auth/login endpoint
- [ ] Add JWT token generation
- [ ] Add refresh token logic

## Frontend
- [ ] Create login form component
- [ ] Add auth context provider

## Completed
- [x] Set up project structure (2026-02-05)
```

---

## Features

### Live Diagram <-> Blueprint <-> Code (v2.0)
- **Live View** – Diagram extracted from your codebase (Mermaid). Read-only architecture visualization.
- **Blueprint Mode** – Toggle **Live | Blueprint**. Add **containers** (Auth API, Worker, DB), **beacons** per container (API, Webhook, Function, Feature), and **edges**.
- **Vault** – Manage environment variables per workspace; syncs to `.env.local`. Reference env keys by name in Blueprint.
- **Codegen** – **Generate code** creates stub files and merges env refs. Additive only.
- **Compare Mode** – Current / before / after / side-by-side diagram comparison.

### Smart Scaffolding
- **CLI-First Approach** - AI uses `npx create-vite`, `npx create-next-app` etc. instead of writing files manually
- **25+ Framework Support** - React, Next.js, Vue, Svelte, Astro, Express, NestJS, Electron, and more
- **Template Fallback** - Falls back to SearxNG template search when GitHub API is rate-limited

### Authentication & Security
- **Supabase Auth** - Sign in with Google or GitHub via Supabase; session and DB in Supabase
- **Session Persistence** - Stay logged in across restarts
- **Deep Linking** - Seamless redirect handling (`atlarix://`)

### Session Change Tracking
- **Mini-git** – Tracks file changes before commit
- **Smart Staleness** – <5%, 5-15%, >15% drift detection
- **Git-based Updates** – Smart update vs regenerate decisions

### Context Management
- **Context Bar** – Real-time token usage visualization
- **Auto-Summarize** – Long conversations compressed automatically
- **Conversation Revert** – Revert to a prior assistant message or edit a user message and continue from there (v3.9)
- **Project Memory** – `.atlarix/ATLARIX.md` is the single project memory/instructions file; legacy `.atlarix/memory.md` and `.atlarix/spec.md` are auto-migrated on first read/write
- **.atlarix/ATLARIX_PLAN.md** – Version-controllable implementation plan
- **Workspace location** – New workspaces are created at project root (e.g. **Choose folder** or ~/Documents/Atlarix). The `~/atlarix-apps` folder is legacy only; to remove old projects there, run `node scripts/cleanup-atlarix-apps.js` (use `--delete` to remove).

### Smart Diff Preview
- **Hunk View** - Changed sections with ±3 lines of context
- **Expand All** - Toggle full diff for large files
- **AI Summary** - Change description at top of each file diff
- **Permission Queue** - Approve/reject AI changes before execution

### 59+ Intelligent Tools
**File Operations** - Read, write, search, modify files  
**Code Intelligence** - Semantic search, architecture diagrams  
**Web & Research** - web_search, deep_search, read_url  
**Development** - Command execution, template scaffolding  
**Stream tools (v3.9)** - stream_terminal_output (live terminal from run_command), stream_pipeline_logs (CI/CD job logs e.g. GitHub Actions)

### Capability comparison
Atlarix supports **code generation and modification**, **session/context summarization** (auto-compaction, project memory), **web search** (`web_search`, `read_url`), **tool calls** (with a permission layer for writes and commands), and **agent delegation** (Guided/Autonomous modes with specialist agents: research, architect, builder, reviewer). These capabilities are comparable to or stronger than those in [claude-code](https://github.com/anthropics/claude-code) and [opencode](https://github.com/anomalyco/opencode): code gen and tool use are on par or better due to explicit permission UI; session summarization and web search are on par; agent delegation is a differentiator with a structured delegate-to-specialist model. See those projects for their exact feature sets.

### Multi-Provider AI Support
8 cloud providers with native model fetch + tool calling: **OpenAI**, **Anthropic**, **Google Gemini**, **OpenRouter**, **Groq**, **Together AI**, **Mistral**, **xAI**. Plus **Ollama** and **LM Studio** for local models.

### Token Budget System
- **Per-provider caps** - Optional token limits in Settings to control API costs
- **Real-time display** - Color-coded bar (amber 70%+, red 90%+)
- **Warnings** - "Approaching token limit" at 80%, critical message at 90%

### Live Preview
- **Lovable-Style Preview** - Auto-starts dev server for frontend projects
- **Responsive Iframe** - Mobile, tablet, desktop viewport controls
- **Framework Detection** - Vite, Next.js, Create React App, Nuxt, Astro

### Hybrid Error Detection
1. **Terminal Parser** - Reads output from dev server to catch build errors
2. **Type Watcher (LSP-Lite)** - Runs `tsc --watch` for type errors
3. **CDP Browser Debugger** - Captures runtime errors via Electron debugger API

### Live Code Editor
- **Monaco Editor** - Edit error files directly in the Code tab
- **Error Underlines** - Red/yellow squiggly lines at exact error locations
- **Save Shortcut** - Cmd/Ctrl+S saves changes directly
- **Auto-Focus** - Cursor positions at first error automatically

### Permission System
- **Tool Approval Flow** - AI proposes changes, you approve before execution
- **FileDiffPanel** - Preview file changes with syntax highlighting
- **Batch Approval** - Approve All / Reject All / Execute Selected buttons
- **Sound Notifications** - Hear when new proposals arrive

---

## Installation

### Prerequisites
- **Node.js 24+**
- **macOS / Windows / Linux**

### Development Setup

**Important — Schema changes:** Any update that modifies the database schema (adding columns, tables, indexes, or relations) must include a corresponding migration under [`drizzle/`](drizzle/) and regenerate [`bundled.generated.ts`](src/db/migrations/bundled.generated.ts) via `npm run db:generate` (runs `postdb:generate` → `db:bundle-sql`). Do not rely on `db:push` alone in production builds. Follow [`drizzle/meta/_journal.json`](drizzle/meta/_journal.json). **v4.0** adds one local SQLite migration (`0030_v40_tool_session_loads`) and two Supabase migrations (`20260316_v40_teams.sql`, `20260316_v40_workforce_connected_services.sql`); the local migration runs automatically on first launch; run the Supabase migrations in your project (e.g. `supabase db push` or via Dashboard) when deploying v4.0.

**Important — Embedded SQLite migrations (v5.2.0+):** Migration SQL is **inlined into the Electron main bundle** at build time (`?raw` imports). There is **no** runtime dependency on `process.resourcesPath`, `extraResource`, or a `drizzle/` folder inside the installer. The app ledger is **`__atlarix_migrations`** (migration tag + `applied_at`). On first run after upgrade, rows in legacy **`__drizzle_migrations`** are **bridged** by matching SHA-256 hashes to the current bundle (see [`src/db/migrate_atlarix.ts`](src/db/migrate_atlarix.ts)). Unknown hashes are reported via **electron-log + Sentry** and **do not** trigger a destructive DB retry.

**Maintainer checklist when adding a migration:** (1) `npm run db:generate` (Drizzle Kit) — this runs **`postdb:generate`** → `npm run db:bundle-sql`, which regenerates [`src/db/migrations/bundled.generated.ts`](src/db/migrations/bundled.generated.ts) from [`drizzle/meta/_journal.json`](drizzle/meta/_journal.json). (2) Add or update a branch in [`src/db/migration_seed_verification.ts`](src/db/migration_seed_verification.ts) (`isJournalMigrationApplied`). (3) Commit the new `.sql` file **and** `bundled.generated.ts`. Verify import paths in the generated file use `../../../drizzle/<tag>.sql?raw` from `src/db/migrations/`.

**Important — Auto-recovery (local SQLite):** If `sqlite.db` under Electron `userData` is **inconsistent** (e.g. core tables missing while bootstrap `ensure*` tables exist, or `__atlarix_migrations` count does not match the embedded bundle after apply), the app **deletes** `sqlite.db` and `-wal`/`-shm` **once** and retries initialization. **Unknown Drizzle migration hashes** (bridge failure) **skip** this retry so user data is not wiped blindly. Workspace project folders on disk are not removed.

**Important — Verified journal seed (SQLite):** Some legacy databases had `apps` but an empty migration ledger. Atlarix seeds **`__atlarix_migrations`** only for migrations whose effects are already present (`seedVerifiedAtlarixMigrationsIfNeeded` in [`src/db/migrate_atlarix.ts`](src/db/migrate_atlarix.ts)), then runs embedded SQL for the rest. **Every new migration** needs a matching `isJournalMigrationApplied` case so we never mark work as done when tables/columns are missing.

```bash
git clone https://github.com/norahlabs/atlarix.git
cd atlarix
npm install
cp .env.example .env
npm start
```

**Dependencies & audit:** Run `npm audit` to check for known vulnerabilities (use default npm registry if your project uses a custom registry). Prefer `npm audit fix` without `--force` first. Top-level `glob` is already `^11`; transitive deprecations (`prebuild-install` from native deps like `better-sqlite3`, `node-domexception`) are accepted until upstream updates. See [TODO.md](TODO.md) § 4.0.5 for full deprecation cleanup notes.

**Important — Supabase OAuth browser fallback (v5.2.1):** `signInWithOAuth()` now guards `shell.openExternal()` and logs both success and failure. If opening the browser fails on **Linux**, Atlarix shows a fallback dialog with the OAuth URL and a **Copy Link** action so sign-in can continue manually instead of silently stalling. The `atlarix://auth/callback` deep-link return flow in [`src/main.ts`](src/main.ts) is unchanged.

---

## Pricing

### Free Tier
- Unlimited non-workspace chats
- 1 Workspace chat (Full features)
- Full access to all 57 tools
- BYOK (Bring Your Own Keys)

### Pro - $19/month
- Unlimited workspaces
- Unlimited prompts
- Priority support

---

## Coming Soon (v2.8+)

v2.7 adds AWS Bedrock in Settings → AI → AI Providers and changelog order (newest first). Next up:

- **Full PIVOT** – ANTLR4 parsing, SQLite persistence, AI clustering into containers/beacons, Live vs Blueprint comparison, and Generate Code from architecture.
- **Command Chaining UI** – Visual dependency graph for commands; partial approvals; rollback hints
- **Voice Input** – Speak your instructions
- **Code Playground** – Test snippets in isolation
- **Timeline Export (GIF)** – Animated architecture evolution
- **Workspace Templates (Pro)** – Save workspace config as template

---

## License

PROPRIETARY - All Rights Reserved.  
Copyright 2024-2026 NorahLabs.

---

**Built with care by NorahLabs**
