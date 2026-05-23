# Atlarix
## The Agent Workstation for Software Development

Atlarix is a desktop environment that gives AI agents the same structural awareness
and tool access that IDEs give human developers — without replacing your editor.

Your team writes code in VS Code, IntelliJ, or Vim. Atlarix gives the agent a live
map of the codebase, a terminal, file operations, web search, and external integrations.
Every destructive action goes through an approval queue. The agent has a workspace.
You have control.

## How it works

**Map** — Atlarix parses your repo into a live **Blueprint** graph (Universal Ctags symbols + ast-grep import/call/route edges). The agent navigates architecture, not raw text.

**Connect** — Wire in any LLM: local Ollama, OpenAI, Anthropic, or the managed model bridge.

**Execute** — The agent plans, reads, writes, runs commands, searches the web. You approve every destructive action.

**Remember** — Session state, task progress, and project context persist across sessions.

**Created by [NorahLabs](https://norahlabs.com)** (Nairobi, Kenya)  
**Website:** [atlarix.dev](https://atlarix.dev)  
**Current release:** **v8.6.3**

**Downloads:** Installers for **macOS**, **Linux**, and **Windows** are on [atlarix.dev](https://atlarix.dev). *(Windows builds are currently unsigned; code signing is coming soon.)*

**Open ecosystem (source / installers / registries):** community **Agent Behaviors** live in [AmariahAK/atlarix-skills](https://github.com/AmariahAK/atlarix-skills); the **MCP marketplace index** is [AmariahAK/atlarix-mcps](https://github.com/AmariahAK/atlarix-mcps); official desktop builds are published from [AmariahAK/atlarix-releases](https://github.com/AmariahAK/atlarix-releases). The Atlarix app itself is proprietary.

---

## v8.6.2 — Atlarix Core in release builds

- **Atlarix Core:** Fixed release builds showing “Not Setup” — OpenRouter credentials from CI are now embedded correctly in the main process bundle.

See [docs/CHANGELOG.md](docs/CHANGELOG.md) `[8.6.2]`.

---

## v8.6.1 — Packaging hotfix

- **Packaged builds:** ast-grep native bindings now ship correctly on macOS, Windows, and Linux (fixes startup crash in v8.6.0 installers).
- **Release CI:** Windows build stability, Discord forum announce, ctags-win32 download URL.

See [docs/CHANGELOG.md](docs/CHANGELOG.md) `[8.6.1]`.

---

## v8.6.0 — Blueprint / RTE stack (ctags + ast-grep)

- **Live Code Map pipeline:** `get_blueprint` lazy-loads via **Universal Ctags** (symbol index) + **@ast-grep/napi** (import, call, and **HTTP route** edges for Express/Fastify/Next).
- **Incremental updates:** file watcher refreshes per-file ctags + ast-grep edges on save (500ms debounce) instead of full-project rescans.
- **Python + Go:** dynamic ast-grep grammars for import/call/route edges alongside TS/JS/TSX.
- **Search:** `search(auto)` upgrades to BM25 over ctags when `.atlarix/symbols.json` is warm; `search(structural)` BFS over blueprint `flowEdges`.
- **Blast radius:** guided/build approval flow shows edit impact (callers/importers) before `write_file` / `edit_file`; skipped in autonomous auto-approve.
- **Bundled tooling:** `npm install` runs **`fetch-ctags`** (macOS/Linux/Windows nightly or Homebrew) and builds **`astgrep_worker.js`** for isolated structural scans.
- **Removed:** oxc-parser / tree-sitter WASM RTE path — see [docs/architecture.md](docs/architecture.md).

Full technical notes: [docs/CHANGELOG.md](docs/CHANGELOG.md).

---

## v8.5.0 — Questions, terminals, sessions

- **Questions:** Agents use the **`ask_user`** tool only (removed legacy `<questions>` block UI).
- **Terminals:** Multiple You/Agent terminals per chat; panel state persists until you start a new chat.
- **Sessions:** Workspace chats save as resumable sessions in the sidebar.
- **Panel:** Diagram tab removed from the right panel default; Activity/terminal first.
- **Build:** Renderer packaging shims for production `npm run package`.
- **Also:** CLI uninstall elevation, Markmap dark theme + zoom, structured `read_file` errors, viz routing in prompts.

Full technical notes: [docs/CHANGELOG.md](docs/CHANGELOG.md).

---

## v8.4.0 — Terminal, CLI, modes, and session fixes

- **Terminal:** Reliable command completion (exit/close, kill on timeout); interactive terminal in Activity panel (`terminal:run` IPC).
- **CLI:** Install `atlarix` from Settings; open workspaces with `atlarix .`, open-file, and second-instance handling.
- **Modes:** Per-mode system prompt blocks; per-message `work_mode` + resend UI; terminal command classification by work mode.
- **Edit/resend:** Workspace message edit shows **Mode** + **Send** (not **Save** only); no duplicate user rows on resend; session memory replaces last exchange on continue.
- **Git:** Agent commits use **atlarix-agent** `<agent@atlarix.dev>`; co-author trailer respects Settings without restart.
- **Other:** PDF attachment timeout/fallback; `run_command` in Explore; Autonomous terminal auto-approve alignment.

Full technical notes: [docs/CHANGELOG.md](docs/CHANGELOG.md).

---

## v8.3.0 — Agent Workstation reframe

- **Positioning:** Agent Workstation across README, website, and in-app copy (editor stays yours; agent gets its own workspace).
- **Language:** Solo / Studio / Team tiers; Explore / Fix mode labels; **Atlarix Core** included OpenRouter models (e.g. DeepSeek V4 Flash / Pro, Kimi K2.6); Approval Queue, Agent Memory, Checkpoints, Multi-Model Review, Agent Teams.
- **Tools:** Git inspection tools removed from the agent registry — use the terminal for `git` CLI.
- **Fix:** Raw `<task_complete>` tags no longer appear in chat UI.
- **Docs:** Live Code Map / parser deep-dive moved to [docs/architecture.md](docs/architecture.md).

Full technical notes: [docs/CHANGELOG.md](docs/CHANGELOG.md).

---

## v8.1.0 — Pass 6 (restore) + Pass 7 (trim)

*May 2026*

### Pass 6 — shipped in this tree

- **Blueprint restored (lazy):** graph schema, IPC, `get_blueprint`, Blueprint canvas (click-to-load + 500-node cap), pivot stubs, BM25 helper, `search(..., structural)` integration.
- **Unified `search`:** replaces `search_code` / `find_relevant_files` in core flows; manifests + mode smoke test updated.
- **Streaming / UI:** throttled message updates, virtualized `MessagesList`, renderer message cap; right panel no longer auto-opens for diagrams/blueprint; `DevServerProvider` does not auto-start dev server or pin panels.
- **Tool consolidation:** `get_diagram` variants merged; `check_environment`; `get_file_outline({include_stats})` replaces `analyze_context`; `run_tests({path,watch})` replaces `test_changes`; `git_status` includes session summary; `live_preview({port_only})` replaces `get_dev_server_port`; `get_project_history({revert_to})` replaces `revert_to_snapshot`; `request_tools` copy refreshed.
- **Diagram UX:** `get_diagram` `role: main|reference` + reference chips in `DiagramPanel`; diagrams page uses chat-driven `get_diagram` instead of page-local AI generate.
- **PDF:** `pdfjs` attachment extraction uses `GlobalWorkerOptions.workerSrc = ''` (main-thread) to avoid worker resolve failures.

### Pass 7 highlights (still applicable where not superseded by Pass 6)

- **Tool consolidation paths:** `edit_file` / `memory` / `diagnose_issue` / MCP on-demand patterns from Pass 7 remain where they do not conflict with Pass 6 tool names.
- **Mode-aware tool surface:** `<mode_system>` + `modeAllowlist` smoke test.
- **On-demand MCP:** `list_available_mcps` + `mcp_call`.
- **Skills via ToolRegistry:** `get_active_skills` + `list_installed_skills`.

Full technical notes: [docs/CHANGELOG.md](docs/CHANGELOG.md).

---

## v8.0.3

- **OpenRouter BYOK:** bring-your-own-key OpenRouter alongside Compass (settings, model list API, Auto routing shortcut, token budget parity with other cloud APIs).
- **Packaging:** hardened Electron/Vite packaging for native-heavy deps (`tiktoken` wasm, optional `pdfjs-dist`, Forge prune `npm install` roots, elevated Node heap for `npm run package` / `make` / `publish`).
- **Diagnostics:** main-process `[lifecycle]` logging on quit with memory snapshot to trace silent exits (`electron-log`).

Full technical notes: [docs/CHANGELOG.md](docs/CHANGELOG.md).

---

## v8.0.1

- **Tool Contract Layer:** agent never claims a tool is unavailable when it is registered
- **Model-triggered compaction:** `compress_context` tool replaces pre-dispatch auto-summarize
- **Streaming terminal guarantee:** every stream path now emits `chat:response:end` exactly once
- **Macro tools:** `get_workspace_overview` and `read_attachment_summary` added
- **BYOK error banners:** `classifyProviderError` surfaces actionable fixes for 401/429/404/network
- **Skills Marketplace:** Settings → Skills panel, browse 30 community skills from registry, 5 global + 5 per-workspace slots, Apache 2.0 registry at [AmariahAK/atlarix-skills](https://github.com/AmariahAK/atlarix-skills)
- **Context cleanup:** 6 pre-dispatch injections removed/gated, ~50% reduction in input tokens per turn (blueprint, installedSkills, Supabase, diagram-first prefix, workspaceAnalysis, SQLite projectMemory now tool-driven or mode-gated)
- **Explore subagent:** dedicated read-only codebase exploration agent via `delegate_to_agent`
- **OpenRouter app identification:** `X-Title` and `HTTP-Referer` headers added
- **Tool spinner reconciliation:** no more stuck running indicators after stream ends
- **Debug instrumentation removed:** `hypothesisId` and `debugLog` cleanup

---

## v7.1.1 — No-workspace banner respects chat-only sessions (patch)

*May 2026*

### What changed

- **Composer:** If you start chatting **without** picking a workspace, the **Open workspace** onboarding strip hides after your **first message** in that thread so the composer stays clean for pure chat. Opening a folder still dismisses it immediately.

---

## v7.1.0 — Agent bus oversight, counsel reliability, diagram & first-run polish (minor)

*May 2026*

### Highlights

- **Agent bus — DelegationMonitor:** Detects **cyclic** and **runaway** `delegate_to_agent` patterns within a sliding window; emits corrective bus traffic at warning thresholds and exposes **`delegation_abort`** for the autonomous loop when critical thresholds are hit.
- **Agent bus — timing metadata:** Bus / IPC / Thinking UI can carry optional **`modelId`** and **`responseMs`** per agent turn (delegation completions instrumented for visibility).
- **Counsel pipeline:** **Completion-driven** resolution — participants run without the old fixed short per-model race; a single **7-minute** wall-clock cap (`COUNSEL_TIMEOUT_MS`) replaces the prior ~30s-style shutdown layer; on timeout, partial results are preserved and the activity event includes completed vs expected counts.
- **Diagrams (Mermaid):** Shared **CRITICAL** node-label rules in generation prompts reduce invalid bracket labels; the renderer shows a **friendly error card** instead of raw parser tokens, with a one-shot repair retry when safe.
- **Sign-in:** OAuth in progress shows **step labels** over time (connecting / verifying / finishing) plus the marquee loading bar where applicable.
- **Workspace empty state:** The no-workspace strip is styled as **onboarding** with an **Open workspace** action instead of a harsh warning.

See [docs/CHANGELOG.md](docs/CHANGELOG.md) for full notes.

---

## v7.0.4 — Chat config panel + env file safety (patch)

*April 2026*

### What changed

- **Mid-chat Config panel:** The dropdown (MCP, model, Auto, deep think, delegation, Blueprint) opens **below** the config control so it does not sit over the prompt; it stays **fully on screen** in fullscreen, windowed, and any window size—content **scrolls inside** the menu when it does not fit; Radix collision + available-height clamp replaces a fixed `70vh` cap that could clip edges.
- **Agent cannot read env secret files:** The `read_file` tool **blocks** paths whose basename matches `.env`, `.env.*`, `*.env`, etc., with a clear user-facing message. Codebase context assembly uses the **same rules** so those files are omitted from LLM context (not only `.env` / `.env.local`).

---

## v7.0.5 — Auto-updates fixed on macOS + clearer Linux update path (patch)

*April 2026*

### What changed

- **macOS auto-update fixed:** Atlarix releases now include a notarized **`.zip`** of the app alongside the `.dmg`, which `electron-updater` uses for silent updates.
- **Linux auto-update clarity:** AppImage continues to **auto-update silently**. `.deb` / `.rpm` installs now show a **desktop notification** when a new version is available, with a one-click download link.

---

## v7.0.3 — Sign-in reliability + clearer dark mode (patch)

*April 2026*

### What changed

- **Sign-in (system browser):** OAuth opens in your default browser, with a clear **60-second fallback** if the callback doesn’t return.
- **Dark mode clarity:** Buttons and toggles are easier to spot—controls read as clickable, not plain text.
- **Free tier copy:** The sign-in screen now matches the pricing page (one workspace + starter included usage + optional BYOK/local models).

---

## v7.0.2 — Chat strip, counsel & deep-think polish (patch)

*April 2026*

### What changed

- **Working strip:** Labels are **provider-agnostic** (read / modify / web / MCP / default) and stay visible **from send until the stream fully ends**. Autonomous delegation and **Counsel** pre-pass get clear status text; tools send stable **`toolId`** for correct grouping.
- **Deep think:** If you use **one-shot deep thinking** and the **current model cannot use native extended reasoning**, Atlarix **runs Counsel instead** for that turn—no error toast—then continues the main reply without asking the provider for unsupported reasoning APIs.
- **Chat without a workspace:** Counsel **auto-trigger** and the same deep-think / Counsel behavior apply in **ephemeral chat-only** mode (web tools only when no project is open).
- **After each reply:** Optional **Counsel** and **Agentic-Bus** cards (collapsed by default) keep a short **snapshot** of that turn’s counsel session and agent-bus lines.

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
- **Tiered RTE parsers (v8.2):** oxc-parser (worker pool) for TS/JS/JSX/TSX; tree-sitter WASM for Python, Go, and Rust; regex heuristics for routes and framework-specific patterns. See parser tier table below.
- **Self-correction**: TypeScript errors, dev server failures, and test failures trigger automatic fix attempts after each build.
- **Hooks and custom commands**: Shell hooks around file writes and terminal commands. Custom `/commands` for repeatable workflows.
- **Per-model compaction**: Context compression uses each model's actual context window size dynamically.

---

## What makes Atlarix different

- **Live Code Map:** Your repo is parsed into a live graph (rooms, beacons, edges). The agent queries structure first—not just open files. Technical details: [docs/architecture.md](docs/architecture.md).
- **Agent Behaviors & workspace memory:** Project instructions and behaviors shape the agent without repeating yourself every turn.
- **Agent Memory:** Multi-step work persists across compaction—clear pending steps, progress, and file touch lists.
- **Multi-Model Review:** Optional Speed / Standard / Deep perspectives run ahead of the main reply, then synthesize—useful for hard design questions.
- **Agent Teams:** Research and architect-style parallel prefetch and post-task verification (reviewer + debugger) with safe depth rules.
- **Self-correction:** Capped synthetic follow-ups can address test or diagnostics output after substantive build turns.
- **Living plan:** **`.atlarix/ATLARIX_PLAN.md`** tracks execution with checkboxes; previous versions archive under **`.atlarix/plans/archive/`**.
- **Hooks & custom commands:** Advisory hooks around file and command operations; slash commands expand prompts with optional mode overrides.
- **Auto memory:** High-signal turn summaries can append under **`.atlarix/ATLARIX.md`**.

**Providers:** Managed **Model Bridge** tiers and broad **BYOK** support (OpenAI, Anthropic, Gemini, OpenRouter, Ollama, LM Studio, and more). Core behaviors are not tied to a single provider.

For detailed release notes see **[docs/CHANGELOG.md](docs/CHANGELOG.md)**.

## Features

### Live Code Map & Blueprint (in-app)

On-demand graph via `get_blueprint` and structural `search`—not whole-repo injection every turn. Parser tiers, Live View, Blueprint canvas, and `.atlarixignore` are documented in **[docs/architecture.md](docs/architecture.md)**.

### AI Agents & Modes

- **Work modes:** Explore (read-only), Plan, Build, Fix, Review — plus **Auto** routing (Speed / Standard / Deep via Groq classifier when uncertain).
- **Built-in specialists:** Research, Architect, Builder, Reviewer, Debugger.
- **Agent Teams:** Guided (flat) or Autonomous (nested sub-agents, depth-limited).
- **Atlarix Core:** Managed OpenRouter models (no API key). One included model on Solo; all three routing slots on Studio and Team.

### Workspace Tools & Extensions

- **Core tools (all tiers):** File read/write, unified **`search`**, `get_blueprint`, terminal (including `git` CLI), web search, **`get_diagram`**, and more. **Explore** mode uses a read-only allowlist.
- **MCP:** **Solo:** 1 global MCP (manual). **Studio / Team:** marketplace plus up to **5** global and **5** per-workspace servers; on-demand **`list_available_mcps`** / **`mcp_call`** in workspace chat.
- **Agent Behaviors:** **Studio / Team** — install from [atlarix-skills](https://github.com/AmariahAK/atlarix-skills) (5 global + 5 per workspace). Optional **`.atlarix/skills/`** in the repo; **Team** honors **`priority: true`** on manifests.
- **Team tier:** MCP-based integrations (Slack, Jira, Linear, Sentry, CI, etc.); session-scoped service context; **`commit_blueprint`** to git; workforce-only MCP registry rows in [atlarix-mcps](https://github.com/AmariahAK/atlarix-mcps).
- **Database extension:** PostgreSQL, MySQL, SQLite — read/write with approval where enabled.

### Live Preview & Error Detection

- Auto-starts dev server for frontend projects (Vite, Next.js, CRA, Nuxt, Astro).
- Hybrid error detection: terminal parser + TypeScript watcher (`tsc --watch`) + CDP browser debugger.
- Monaco editor in the Code tab with error underlines and Cmd/Ctrl+S save.

### Context & Session Management

- **Context bar** — Real-time token usage with color-coded warnings.
- **Compaction** — Model-triggered **`compress_context`** when threads get long.
- **Project memory** — `.atlarix/ATLARIX.md` for persistent workspace instructions.
- **Conversation revert** — Revert workspace files and diagram while keeping the transcript (`is_reverted` markers).
- **Approval queue** — Approve / reject file and command changes before execution, with diff preview.

### Multi-Provider AI

8 cloud providers with native model fetch and tool calling: **OpenAI**, **Anthropic**, **Google Gemini**, **OpenRouter**, **Groq**, **Together AI**, **Mistral**, **xAI**. Plus **Ollama** and **LM Studio** for local / offline models.

---

## Deployment & CI/CD

Releases are built and published from **this repository** ([`AmariahAK/Atlarix`](https://github.com/AmariahAK/Atlarix)) via GitHub Actions—**no separate deploy repo step**. Pushing a **version tag** is the supported way to run the full pipeline and **publish** the release.

### Cut a release (Atlarix repo only)

1. Land your changes on the branch you release from (usually `main`) and bump **`package.json` `version`** so it matches the tag you will push.
2. Add a **technical** release section at the top of [`docs/CHANGELOG.md`](docs/CHANGELOG.md), e.g. `## [8.5.2] (2026-05-21) — Title` (or legacy `## v8.5.2 — Title`). The **`announce-release`** job copies this section to the GitHub release on `atlarix-releases` and to Discord (same technical text).
3. Commit the version bump and changelog section.
4. Create and push a tag whose name matches the app version with a **`v` prefix**, e.g. **`v7.0.2`**:
   ```bash
   git tag v7.0.2
   git push origin v7.0.2
   ```
5. In GitHub: **Actions** → **Release** should show a run for that tag. When builds succeed, **`publish-release`** makes the release public; **`announce-release`** (tag pushes only) updates release notes from `docs/CHANGELOG.md` and optionally posts to Discord.

**Manual run (`workflow_dispatch`):** You can trigger **Actions → Release → Run workflow** for a test build; set the **version** input when prompted. **Publishing** the release to users still follows the **tag push** path in [`.github/workflows/release.yml`](.github/workflows/release.yml) (`publish-release` is gated on `refs/tags/v*`).

- **Workflow:** [`.github/workflows/release.yml`](.github/workflows/release.yml) — creates a draft release on `AmariahAK/atlarix-releases`, builds macOS (arm64 + x64) with notarization and Linux (`.deb`, `.rpm`, `.AppImage`), uploads assets and `latest-mac.yml` / `latest-linux.yml` feed files for `electron-updater`, then publishes the release.
- **SQLite migrations:** Migration SQL is embedded in the main process bundle at build time (see [`src/db/migrations/bundled.generated.ts`](src/db/migrations/bundled.generated.ts)). Run `npm run db:bundle-sql` after any new Drizzle migration.
- **Secrets:** Go to **Settings → Secrets and variables → Actions** and add the variables from [.env.example](.env.example). See [docs/CREDENTIALS_SETUP.md](docs/CREDENTIALS_SETUP.md) for setup instructions. Required:

  `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANT_ID`, `LEMONSQUEEZY_WORKFORCE_VARIANT_ID`, `LEMONSQUEEZY_EXTRA_SEAT_VARIANT_ID`, `LEMONSQUEEZY_WEBHOOK_SECRET`,  
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`,  
  `SENTRY_DSN`, `POSTHOG_API_KEY`, `RESEND_API_KEY`, `EMAIL_SOURCE`,  
  `COMPASS_OPENROUTER_API_KEY`, `COMPASS_MODEL_FAST`, `COMPASS_MODEL_BALANCED`, `COMPASS_MODEL_THINKING`,  
  `GROQ_CLASSIFIER_API_KEY`, `GROQ_CLASSIFIER_MODEL`,  
  `TEMPLATE_TOKEN` (optional — higher GitHub API rate limits for the in-app template catalog),  
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_CERT_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`,  
  `RELEASES_TOKEN` (PAT with `repo` scope for `atlarix-releases` — draft create, asset upload, publish, changelog body via `announce-release`).  
  `DISCORD_WEBHOOK_URL` (optional — webhook for the **atlarix-releases** Discord channel; add it on this repo’s Actions secrets when you want tag pushes to post there).

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

After `npm install`, root **`postinstall`** runs:

1. **`electron/install.js`** — Electron binary (avoids **`spawn …/Electron ENOENT`** on **`npm start`**). See [docs/CHANGELOG.md](docs/CHANGELOG.md) **[8.0.4]**.
2. **`fetch-ctags`** — downloads or copies **Universal Ctags** into `assets/ctags/{platform}/` (gitignored; required for symbol index + Blueprint). Fallback: `brew install universal-ctags` then `npm run fetch-ctags`.
3. **`build:astgrep-worker`** — compiles `.vite/build/astgrep_worker.js` so ast-grep structural scans run off the main process in dev (`npm start` also runs this via **`prestart`**).

Blueprint / RTE deep-dive: [docs/architecture.md](docs/architecture.md).

**Schema changes:** Any update that modifies the database schema must include a Drizzle migration under [`drizzle/`](drizzle/) and regenerate [`bundled.generated.ts`](src/db/migrations/bundled.generated.ts) via `npm run db:generate` (which runs `db:bundle-sql` via `postdb:generate`). Every new migration also needs a matching `isJournalMigrationApplied` case in [`src/db/migration_seed_verification.ts`](src/db/migration_seed_verification.ts) (e.g. `0035_unified_snapshots_revert` checks `diagram_versions.chat_turn_id`, `diagrams.last_snapshot_hashes`, and `messages.is_reverted`).

---

## Pricing

| Tier      | Price   | Workspaces | Highlights |
|-----------|---------|------------|------------|
| **Solo**  | $0      | 1          | Model Bridge **Speed** only; BYOK / local models; core tools; **1** global MCP (manual); Agent Behaviors & MCP marketplace locked |
| **Studio**   | $19/mo  | Unlimited  | Model Bridge **Speed / Standard / Deep**; higher included usage; **Agent Behaviors** + **MCP marketplace**; up to **5** global + **5** per-workspace MCPs; priority support |
| **Team** | $79/mo | Unlimited | Everything in **Studio** + team **seats** (default 5) and high-pool Model Bridge usage; team MCP integrations; priority repo behaviors; Blueprint commit to git; Team-only MCP registry rows |

Default **Compass token allowances** (server-side, adjustable): see [docs/compass-limits.md](docs/compass-limits.md).

---

## License

PROPRIETARY — All Rights Reserved.  
Copyright 2024–2026 NorahLabs.

---

**Built with care by NorahLabs**
