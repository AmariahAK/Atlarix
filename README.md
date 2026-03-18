# Atlarix

**Atlas + Axis + Intelligence**

Atlarix is your premium AI coding copilot — a powerful desktop application that combines intelligent code understanding with visual architecture design.

**Created by:** [NorahLabs](https://norahlabs.com)  
**Website:** [atlarix.dev](https://atlarix.dev)

*Current: v4.0.0*

**Downloads:** The latest installers (macOS and Linux) are on [atlarix.dev](https://atlarix.dev). The **Windows** build is currently in development and not yet available; once EV/OV code signing is in place, Windows will be added to releases.

**Recent (v4.0 — Workforce):** New **Workforce** tier ($79/mo): Auth0 Token Vault for secure agent auth, Workspace Context (Slack, Jira, Linear, CI, Sentry, Calendar), Teams (up to 20 seats), GitLab CI & Bitbucket Pipelines, Progressive Tool Reveal. DB Studio moved to Workforce (existing Pro subscribers grandfathered). Three tiers: Free, Pro ($19/mo), Workforce ($79/mo). Credentials via env — see [SECRETS.md](SECRETS.md) and [.env.example](.env.example).

### Workspace tools & extensions (how it works)

- **Core workspace tools (all tiers)**: When you open a workspace and use **Build** mode, the model always has access to core tools for files, code, search, diagrams, git, and commands. In **Ask** mode it automatically filters to read‑only tools (`read_file`, `list_files`, `search_code`, `get_diagram`, `git_log`, `web_search`, etc.) using each tool’s `isReadOnly` flag.
- **MCP tools (`@mcp` mentions)**: Add MCP servers in **Settings → Tools → MCP**. In chat, type `@` and pick an MCP server (e.g. `@mcp:MyServer`). The mention is sent in your message so the AI can prefer that server’s tools, but you never call tools manually—the model chooses which MCP tools to invoke.
- **Workforce tools (Slack, Jira/Linear, Sentry, calendar, CI)**: On the **Workforce** tier, connect services via **Token Vault**. Once connected, the AI can read your workspace context (open PRs, failing pipelines, assigned tickets, unread mentions, Sentry errors, today’s meetings) and call workforce tools as needed. You do **not** use an `@` command for these; you just ask in natural language (“What Jira tickets are assigned to me?”, “Any new Slack mentions?”, “How did the CI pipeline go?”).
- **Database Extension (DB tools)**: Configure database connections (PostgreSQL, MySQL, SQLite) in the **DB extension / DB Studio UI**. After a connection is active for a workspace, the AI gets DB tools:
  - `db_query` and `db_schema` for read‑only SELECTs and schema inspection  
  - `db_list` to list configured/active connections  
  - `db_mutate` for writes (INSERT/UPDATE/DELETE/DDL) that always require explicit user approval in the permission queue  
  You never paste credentials into chat; connection details live in settings, and the AI interacts with the active connection through these tools.

### Deployment & CI/CD

**Releases** are built and published via GitHub Actions for every version. **GitHub Actions**: in the **left panel**, add the GitHub Actions extension (Pro) to list workflow runs, view job logs, stream logs live, and send logs to the AI. Connect GitHub in Settings → Extensions. Token is read from the Supabase session (`session.provider_token`) when signed in with GitHub. The workflow runs on tag push (`v*`) and **reads all credentials from GitHub repository secrets** — nothing is hardcoded in the repo.

- **Workflow:** [`.github/workflows/release.yml`](.github/workflows/release.yml) — on push of a version tag (e.g. `v4.0.3.23`), creates a draft release on atlarix-releases, builds macOS (arm64/x64) and Linux, uploads assets, then publishes the release.
- **Secrets:** In the repo go to **Settings → Secrets and variables → Actions** and add the same variables as in [.env.example](.env.example). See [docs/CREDENTIALS_SETUP.md](docs/CREDENTIALS_SETUP.md) for a step-by-step guide to obtain each. Required:  
  `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANT_ID`, `LEMONSQUEEZY_WORKFORCE_VARIANT_ID`, `LEMONSQUEEZY_EXTRA_SEAT_VARIANT_ID`, `LEMONSQUEEZY_WEBHOOK_SECRET`,  
  `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_TOKEN_VAULT_ID`, `AUTH0_AUDIENCE`,  
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`,  
  `VITE_ATLARIX_API_URL`, `SENTRY_DSN`, `POSTHOG_API_KEY`, `RESEND_API_KEY`, `EMAIL_SOURCE`, `ATLARIX_API_URL`.  
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
- **Built-in agents:** Research, Architect, Builder, Reviewer — each with a dedicated tool set and icon (no emojis; Lucide icons).
- **Project instructions:** `.atlarix/ATLARIX.md`, `AI_RULES.md`, workspace prompts, `~/.atlarix/ATLARIX.md`, bundle AGENTS.md — loaded in precedence order for the system prompt.
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
| **Blueprint-Driven Planning** | Compare desired vs actual, generate `ATLARIX_PLAN.md`, implement with review gates |

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

### Planning with ATLARIX_PLAN.md

When you design in Blueprint and click "Generate," the AI:
1. Compares Blueprint (desired) to Live (actual)
2. Generates ordered tasks in `ATLARIX_PLAN.md`
3. Implements one task per exchange (user message -> AI response)
4. Waits for your review before proceeding
5. Quality over quantity: fixes bugs before moving on

```markdown
# ATLARIX_PLAN.md

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
- **Google OAuth** - Secure sign-in with your Google account
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
- **Project Memory** – `.atlarix/memory.md` (Claude Code style) persists across sessions; compaction writes there
- **Task Breakdown** – `.atlarix/spec.md` (model-created) for task breakdown; AI reads both when present
- **ATLARIX_PLAN.md** – Version-controllable implementation plan
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
- **Node.js 20+**
- **macOS / Windows / Linux**

### Development Setup

**Important — Schema changes:** Any update that modifies the database schema (adding columns, tables, indexes, or relations) must include a corresponding migration file so the auto-migrate system runs it correctly on app start. Do not rely on `db:push` alone in production builds. Migration files live in [`drizzle/`](drizzle/) at the project root and must follow the existing naming convention (see [`drizzle/meta/_journal.json`](drizzle/meta/_journal.json)). **v4.0** adds one local SQLite migration (`0030_v40_tool_session_loads`) and two Supabase migrations (`20260316_v40_teams.sql`, `20260316_v40_workforce_connected_services.sql`); the local migration runs automatically on first launch; run the Supabase migrations in your project (e.g. `supabase db push` or via Dashboard) when deploying v4.0.

```bash
git clone https://github.com/norahlabs/atlarix.git
cd atlarix
npm install
cp .env.example .env
npm start
```

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
