# Atlarix

**Atlas + Axis + Intelligence**

Atlarix is a desktop AI coding copilot that pairs **structural codebase understanding** with **visual architecture** and **controlled execution**: you see what the model plans, approve writes and commands, and keep context across long sessions without drowning in raw tokens.

**Created by [NorahLabs](https://norahlabs.com)** (Nairobi, Kenya)  
**Website:** [atlarix.dev](https://atlarix.dev)
**Current release:** **v7.0.1**

**Downloads:** Installers for **macOS** and **Linux** are on [atlarix.dev](https://atlarix.dev). **Windows** is still in progress pending code signing.

---

## v7.0.1 — Deep research ledger + web relevance (patch)

*April 2026*

### What changed

- **`deep_research` tool ([`src/lib/tools/web-tools.ts`](src/lib/tools/web-tools.ts)):** Replaced the fixed per-sub-question loop with a **ResearchLedger**-driven agentic loop: sub-questions (`pending` / `partial` / `answered` / `no_data`), per-iteration coverage, consecutive-empty and max-iteration stops, internal quick-style search via **`WebSearchAggregator`** (same stack as `web_search`, no duplicate SearxNG wiring), fetch + unchanged **`extractRelevantSection`** BM25 extraction, structured **`formatResultForModel`** output (coverage %, completion reason, per-source relevance). Constants: `maxIterations` 8, `sufficientCoverageThreshold` 0.75, `maxAttemptsPerSubQ` 3, `maxSourcesPerSubQ` 3, `maxCharsPerSource` 2000, `fetchTimeoutMs` 10000, `consecutiveEmptyStop` 3. Added minimal **`decomposeQuery`** when the model omits `aspects`. Removed **`max_iterations`** from the tool schema (ceiling is fixed in code).
- **Chat-only ([`src/ipc/handlers/chat_only_handlers.ts`](src/ipc/handlers/chat_only_handlers.ts)):** Removed the external gate that capped or skipped supplementary **`web_search`** calls when **`deep_research`** had run in the same turn; **`deep_research`** now owns completion internally.
- **Relevance tuning:** `filterRelevantResults` cutoff **0.15 → 0.25** (fewer generic-title junk URLs in ranked results). Sub-question **answered** threshold on excerpt token-overlap score **0.6 → 0.35** so coverage can reach the stop threshold when BM25 returns useful but not keyword-dense text.

---

## v7.0.0 — Atlarix v7 (Project Vanguard)

*April 2026*

Atlarix v7 is a complete rebuild of the agent and context systems on top of the Blueprint foundation.

### What changed

- **Skills system**: Every agent (Architect, Builder, Reviewer, Debugger, Researcher) now operates from a readable skill file. Override any skill per workspace in `.atlarix/skills/`.
- **Task ledger**: Tasks survive context resets. Agents always know what is done and what remains, regardless of session length.
- **Parallel agents**: Research and Architect run simultaneously in Autonomous mode. Reviewer and Debugger verify after Builder completes.
- **Counsel**: Complex questions run Fast, Balanced, and Thinking models in parallel. Works with every provider including local Ollama.
- **Visual git**: Every code change creates a snapshot with the architecture diagram at that moment. See how your system evolved. Stored in `.atlarix/` and travels with your repo.
- **Plan viewer**: When Atlarix creates a plan, it is shown as a live card with step-by-step progress — not buried in text.
- **Tree-sitter RTE**: Blueprint now uses AST-level parsing for TypeScript, JavaScript, and Python with regex fallback. More accurate node/edge extraction.
- **Self-correction**: TypeScript errors, dev server failures, and test failures trigger automatic fix attempts after each build.
- **Hooks and custom commands**: Shell hooks around file writes and terminal commands. Custom `/commands` for repeatable workflows.
- **Per-model compaction**: Context compression uses each model's actual context window size dynamically.

---

## What makes Atlarix different

- **Blueprint (RTE + graph):** Your repo is parsed into a live graph (rooms, beacons, edges). The AI queries structure first, not just open files—so context stays focused on the architecture that matters.
- **Skills & workspace memory:** Project instructions and skills shape behavior without repeating yourself every turn.
- **Task ledger:** Multi-step work gets an external **task ledger** that survives compaction—clear pending steps, progress, and file touch lists for the model.
- **Counsel:** Optional **fast / balanced / thinking** perspectives run ahead of the main reply (or via IPC for UI-triggered runs), then synthesize—useful for hard design questions.
- **Parallel agents:** Research and architect-style **parallel prefetch** and **post-task verification** (reviewer + debugger) run with safe depth and ledger rules so sub-runs do not fight the parent turn.
- **Self-correction:** Capped synthetic follow-ups can address test or diagnostics output after substantive build turns.
- **Living plan:** **`.atlarix/ATLARIX_PLAN.md`** can track execution with checkboxes and a completion section; previous versions are archived under **`.atlarix/plans/archive/`** when the plan is replaced.
- **Hooks & custom commands:** Advisory **hooks** around file and command operations; **slash commands** expand prompts with optional mode overrides.
- **Auto memory:** High-signal turn summaries can append under **`.atlarix/ATLARIX.md`** (optional **`writeToFile`** toggle), with tool names reflected when available.

**Providers:** Compass (managed tiers) and broad **BYOK** support (OpenAI, Anthropic, Gemini, OpenRouter, local via Ollama / LM Studio, and more). Core product behaviors—ledger, continuation, verification, compaction—are **not** tied to a single provider; tier limits and billing remain provider-specific where applicable.

For detailed release notes see **[docs/CHANGELOG.md](docs/CHANGELOG.md)**.

---

### Troubleshooting — Linux OAuth

If you sign in on Linux and the app stays on the loading screen after the browser opens:

1. **Wait 60 seconds** — Atlarix will show a dialog with the OAuth URL and a **Copy Link** button. Paste that URL in your browser to complete login.
2. **Register the deep link handler** (run once in Terminal, then sign in again):

   ```bash
   xdg-mime default atlarix.desktop x-scheme-handler/atlarix
   update-desktop-database ~/.local/share/applications
   ```

The sidebar also shows these commands inline whenever a sign-in attempt fails on Linux.

---

## Features

### Blueprint (RTE + RAG)

**Parse once, query forever.** Atlarix parses your codebase via Round-Trip Engineering (TypeScript, Python), generates a Blueprint graph, and uses it as a RAG knowledge base so the AI answers from the graph and loads only the relevant code — typically 5K tokens instead of 100K.

- **Live View** — Diagram extracted from your codebase (Mermaid). Read-only architecture visualization.
- **Blueprint Mode** — Add containers, beacons, and edges; compare desired vs actual; generate `.atlarix/ATLARIX_PLAN.md`.
- **Incremental Updates** — File watcher updates affected Blueprint nodes automatically.
- **Combined Blueprints** — Polyrepo / monorepo: one view with cross-project edges.
- **`.atlarixignore`** — Gitignore-syntax exclusions from RTE parsing, Blueprint nodes, and prompt injection.

### AI Agents & Modes

- **Work modes:** Ask (read-only), Plan, Build, Debug, Review — plus **Auto** routing that picks Fast / Balanced / Thinking using an external **Groq** classifier (with fallback to your fast model and a **Balanced** baseline when classification is uncertain).
- **Built-in specialists:** Research, Architect, Builder, Reviewer, Debugger — each with a dedicated tool set.
- **Delegation:** Guided (flat) or Autonomous (nested sub-agents, depth-limited).
- **Compass:** Managed cloud provider (OpenRouter-backed, no user-facing API key). Fast / Balanced / Thinking tiers. Free tier: Fast only; Pro / Workforce: all three.

### Workspace Tools & Extensions

- **Core tools (all tiers):** File read/write, code search, Blueprint queries, git, terminal, web search, and more. Ask mode auto-filters to read-only tools.
- **MCP tools:** Add MCP servers in Settings → Tools → MCP. Mention with `@mcp:ServerName` in chat.
- **Workforce tools:** Slack, Jira, Linear, GitHub, GitLab CI, Bitbucket, Sentry, Notion, Google Calendar — connected via Auth0 Token Vault. Per-chat session scope; resets on New Chat.
- **Database extension:** PostgreSQL, MySQL, SQLite. Read (`db_query`, `db_schema`) and write (`db_mutate`, requires approval) tools.

### Live Preview & Error Detection

- Auto-starts dev server for frontend projects (Vite, Next.js, CRA, Nuxt, Astro).
- Hybrid error detection: terminal parser + TypeScript watcher (`tsc --watch`) + CDP browser debugger.
- Monaco editor in the Code tab with error underlines and Cmd/Ctrl+S save.

### Context & Session Management

- **Context bar** — Real-time token usage with color-coded warnings.
- **Auto-summarize** — Long conversations compressed automatically.
- **Project memory** — `.atlarix/ATLARIX.md` for persistent workspace instructions.
- **Conversation revert** — Revert workspace files and diagram to before a turn while keeping the full transcript (`is_reverted` markers).
- **Permission queue** — Approve / reject AI file and command changes before execution, with diff preview.

### Multi-Provider AI

8 cloud providers with native model fetch and tool calling: **OpenAI**, **Anthropic**, **Google Gemini**, **OpenRouter**, **Groq**, **Together AI**, **Mistral**, **xAI**. Plus **Ollama** and **LM Studio** for local / offline models.

---

## Deployment & CI/CD

Releases are built and published via GitHub Actions on every version tag push (`v*`).

- **Workflow:** [`.github/workflows/release.yml`](.github/workflows/release.yml) — creates a draft release on `AmariahAK/atlarix-releases`, builds macOS (arm64 + x64) with notarization and Linux (`.deb`, `.rpm`, `.AppImage`), uploads assets and `latest-mac.yml` / `latest-linux.yml` feed files for `electron-updater`, then publishes the release.
- **SQLite migrations:** Migration SQL is embedded in the main process bundle at build time (see [`src/db/migrations/bundled.generated.ts`](src/db/migrations/bundled.generated.ts)). Run `npm run db:bundle-sql` after any new Drizzle migration.
- **Secrets:** Go to **Settings → Secrets and variables → Actions** and add the variables from [.env.example](.env.example). See [docs/CREDENTIALS_SETUP.md](docs/CREDENTIALS_SETUP.md) for setup instructions. Required:

  `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANT_ID`, `LEMONSQUEEZY_WORKFORCE_VARIANT_ID`, `LEMONSQUEEZY_EXTRA_SEAT_VARIANT_ID`, `LEMONSQUEEZY_WEBHOOK_SECRET`,  
  `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_TOKEN_VAULT_ID`, `AUTH0_AUDIENCE`,  
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`,  
  `SENTRY_DSN`, `POSTHOG_API_KEY`, `RESEND_API_KEY`, `EMAIL_SOURCE`,  
  `COMPASS_OPENROUTER_API_KEY`, `COMPASS_MODEL_FAST`, `COMPASS_MODEL_BALANCED`, `COMPASS_MODEL_THINKING`,  
  `GROQ_CLASSIFIER_API_KEY`, `GROQ_CLASSIFIER_MODEL`,  
  `TEMPLATE_TOKEN` (optional — higher GitHub API rate limits for the in-app template catalog),  
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_CERT_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`,  
  `RELEASES_TOKEN` (PAT with `repo` scope for publishing to `atlarix-releases`).

---

## Installation

### Prerequisites

- **Node.js 24+**
- **macOS or Linux** (Windows in development)

### Development Setup

```bash
git clone https://github.com/AmariahAK/Atlarix.git
cd Atlarix
npm install
cp .env.example .env
npm start
```

**Schema changes:** Any update that modifies the database schema must include a Drizzle migration under [`drizzle/`](drizzle/) and regenerate [`bundled.generated.ts`](src/db/migrations/bundled.generated.ts) via `npm run db:generate` (which runs `db:bundle-sql` via `postdb:generate`). Every new migration also needs a matching `isJournalMigrationApplied` case in [`src/db/migration_seed_verification.ts`](src/db/migration_seed_verification.ts) (e.g. `0035_unified_snapshots_revert` checks `diagram_versions.chat_turn_id`, `diagrams.last_snapshot_hashes`, and `messages.is_reverted`).

---

## Pricing

| Tier      | Price   | Workspaces       | Notes                                                                     |
|-----------|---------|------------------|---------------------------------------------------------------------------|
| Free      | $0      | 1 workspace chat | Full tool access, BYOK                                                    |
| Pro       | $19/mo  | Unlimited        | Priority support, GitHub Actions extension, Compass Balanced + Thinking   |
| Workforce | $79/mo  | Unlimited        | Teams (up to 20 seats), Token Vault, Workforce extensions                 |

---

## License

PROPRIETARY — All Rights Reserved.  
Copyright 2024–2026 NorahLabs.

---

**Built with care by NorahLabs**
