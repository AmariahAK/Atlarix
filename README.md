# Atlarix

**Atlas + Axis + Intelligence**

Atlarix is your premium AI coding copilot — a powerful desktop application that combines intelligent code understanding with visual architecture design.

**Created by:** [NorahLabs](https://norahlabs.com)  
**Website:** [atlarix.dev](https://atlarix.dev)

*Current: v6.2.0*

**Downloads:** The latest installers (macOS and Linux) are on [atlarix.dev](https://atlarix.dev). The **Windows** build is currently in development and not yet available; once EV/OV code signing is in place, Windows will be added to releases.

---

### What's New in v6.2.0

- **Unified workspace snapshots:** Revert files and diagram from `.atlarix/snapshots/` without internal git; **non-destructive** chat revert (`is_reverted` styling, no message deletion). See [docs/CHANGELOG.md](docs/CHANGELOG.md).

### What's New in v6.1.16

- **Diagrams stability:** Reduced noisy `/diagram` issues by normalizing unhandled promise rejections (so telemetry reports actionable details rather than `[object Event]`). Blueprint canvas now uses a **file-tree** layout (top→bottom) for clearer hierarchy; restoring a diagram version refreshes the view immediately.
- **Long-running commands UX:** Terminal output now streams into the persistent tool indicator (with capped views for Errors / Progress / Raw) so you can follow builds and installs without overwhelming the UI.
- **Compass large-context safety:** When Compass prompts approach the context limit, OpenRouter **context compression** may be enabled as a fallback, with a final “last 7 exchanges” safety cap.

### What's New in v6.1.15

- **Safer chat and SQL:** Chat input is normalized at the IPC boundary; model-driven **Supabase SQL** runs through guards (length, dangerous patterns, single-statement) before execution. User messages can be blocked by a **local profanity filter**; assistant replies are sanitized before persistence (code inside \`\`\` fences is left unchanged). **Compass** usage checks treat transient network failures as offline reachability instead of firing high-priority error telemetry. See [docs/CHANGELOG.md](docs/CHANGELOG.md) for detail.

### What's New in v6.1.14

- **Smarter Auto routing:** When you use **Auto** model routing, Atlarix calls an external **Groq** classifier (with your configured model id) to pick **Fast / Balanced / Thinking** per message. If Groq is unavailable or rate-limited, the app falls back to a one-word classification on **your** fast model, then defaults to **Balanced** (never silently defaulting to Fast). See [docs/CHANGELOG.md](docs/CHANGELOG.md) for technical detail.

For full history see [docs/CHANGELOG.md](docs/CHANGELOG.md).

---

### What's New in v6.1.13

- **Linux OAuth fallback:** If the `atlarix://auth/callback` deep link never fires after the browser opens (common on minimal distros / VMs), a 60-second countdown triggers a dialog with the OAuth URL and a **Copy Link** button. Linux users also see a dismissable tip in the sidebar with the `xdg-mime` commands to register the handler. See [Troubleshooting — Linux OAuth](#troubleshooting--linux-oauth) below.
- **Theme toggle:** Settings → General now has an **Appearance** selector (System / Light / Dark) backed by `localStorage`.
- **UI fixes:** Hero glow no longer bleeds amber behind amber gradient text (WCAG AA). The right-panel expand/collapse button is no longer clipped by the rounded container corner.
- **Silent auto-update (in-app UI):** `electron-updater` replaces `update-electron-app`. A subtle "Downloading update…" strip appears while the update fetches; a **Restart Now / Remind me later** banner replaces the old native dialog when the update is ready. "Remind me later" defers install to the next cold start.
- **AppImage target:** Linux builds now produce an `.AppImage` in addition to `.deb` and `.rpm`, enabling `electron-updater`'s built-in auto-update on AppImage installs.
- **GitHub Actions — Node 24 migration:** CI uses `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`, `softprops/action-gh-release@v2`, and generates `latest-mac.yml` / `latest-linux.yml` feed files for `electron-updater`.

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
