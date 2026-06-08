# Atlarix
## The Agent Workstation for Software Development

Atlarix is a desktop environment that gives AI agents the same structural awareness
and tool access that IDEs give human developers — without replacing your editor.

Your team writes code in VS Code, IntelliJ, or Vim. Atlarix gives the agent a live
map of the codebase, a terminal, file operations, web search, and external integrations.
Every destructive action goes through an approval queue. The agent has a workspace.
You have control.

## How it works

**Map** — Atlarix builds a live **Blueprint** per workspace section (Universal Ctags + ast-grep edges). The agent calls `get_blueprint` with a folder path—one monorepo area at a time—with validation, hybrid backfill on thin indexes, and compact Markdown slices—not whole-repo dumps.

**Connect** — Wire in any LLM: local Ollama, OpenAI, Anthropic, OpenRouter, or **Atlarix Core** (managed models with real catalog names, not raw tier ids).

**Execute** — The agent plans, reads, writes, runs commands, searches the web. You approve every destructive action.

**Remember** — Workspace sessions, attachments, task progress, and project context persist across reloads. The agent maintains `.atlarix/memory.md` (stack, architecture, layout) so new sessions skip full re-scans.

**Created by [NorahLabs](https://norahlabs.com)** (Nairobi, Kenya)  
**Website:** [atlarix.dev](https://atlarix.dev)  
**Current release:** **v12.5.0**

**Downloads:** Installers for **macOS**, **Linux**, and **Windows** are on [atlarix.dev](https://atlarix.dev). *(Windows builds are currently unsigned; code signing is coming soon.)*

**Open ecosystem (source / installers / registries):** community **Agent Behaviors** live in [AmariahAK/atlarix-skills](https://github.com/AmariahAK/atlarix-skills); the **MCP marketplace index** is [AmariahAK/atlarix-mcps](https://github.com/AmariahAK/atlarix-mcps); official desktop builds are published from [AmariahAK/atlarix-releases](https://github.com/AmariahAK/atlarix-releases). The Atlarix app itself is proprietary.

Release notes: **[docs/CHANGELOG.md](docs/CHANGELOG.md)** (current: 9.0+). Older entries: **[docs/CHANGELOG_PREVIOUS.md](docs/CHANGELOG_PREVIOUS.md)**.

---

## What makes Atlarix different

- **Live Code Map:** Your repo is parsed into a live graph (rooms, beacons, edges). The agent queries structure first—not just open files. Technical details: [docs/architecture.md](docs/architecture.md).
- **Workspace-first:** Open a folder from the welcome screen. Chat, sessions, MCP, and Skills belong to that workspace—no global chat without a project.
- **Work modes:** **Explore** (read-only), **Plan**, **Build**, **Debug**, **Review**.
- **On-demand file discovery:** Opening a workspace does not scan the whole repo via git. The Code tab loads the file tree when you need it (plus a **Cmd/Ctrl+P** fuzzy file opener); the sidebar stays focused on sessions; the agent uses `list_files`, `search`, `get_blueprint`, and related tools.
- **Attachments:** Paste text, terminal output, and files into chat. After send they appear as chips with preview; content persists across session reload.
- **Agent Behaviors & workspace memory:** Project instructions in `.atlarix/atlarix.md` and behaviors under `.atlarix/skills/` shape the agent without repeating yourself every turn.
- **Sub-agents:** Explore & Review helpers run scoped, read-only passes (up to five per turn) with grouped tool summaries in the Sub-agents panel.
- **Background agents:** Spawn detached agents into their own sessions — read-only, or write-capable with shadow-git capture and an explicit **keep/revert** review of the aggregate diff. Restart-safe, with a dedicated Agents panel tab.
- **User-defined agents & portable config:** `.atlarix/agents/<name>.md` (system prompt + tools + model) shows up in the picker; `.atlarix/permissions.json` deny/ask rules and `.atlarix/hooks/` (blocking pre-tool, advisory post-tool, stop gate) are committable and enforced at the single tool-execution funnel — plus a global `~/.atlarix/` layer.
- **Verified edits:** After each round of writes, LSP diagnostics on the touched files feed back into the loop — the agent cannot claim a task complete on top of broken code.
- **Native tool history:** Tool calls/results ride as provider-native blocks (not flattened text) — weak and local models perform notably better, and multi-step prompt caching holds.
- **Self-correction:** After substantive build turns, optional LSP-based follow-ups can address diagnostics in touched files (no separate TypeScript compiler worker or Problems tab).
- **Approval queue:** File writes and shell commands wait for explicit approval with diff preview — accept or reject **individual hunks**, not just whole files.
- **Interactive questions:** The agent can ask you **up to 5 questions in one inline card** (options + free text) and the stream genuinely pauses until you answer — no invented answers, no missed prompts.
- **Native web search:** On providers with built-in search (Anthropic, OpenAI, Gemini 2+, OpenRouter BYOK) the provider's own search tool runs at dispatch with **inline citations that survive reload**; everywhere else the client chain (SearxNG → public SearxNG → DuckDuckGo) is the universal fallback.
- **Prompt caching:** Dispatches are cache-friendly out of the box — Anthropic BYOK turns place `cache_control` breakpoints over the stable system header and conversation history, cutting repeat-turn input cost and latency.
- **Real terminal:** User terminal tabs are full interactive shells (xterm.js + PTY) — Tab completion, arrows, colors, vim/top. Tabs and scrollback **persist across app restarts**, and tab labels track the shell's live cwd. Agent commands run separately with captured output and approvals.

**Providers:** **Atlarix Core** (managed Model Bridge tiers) and broad **BYOK** support (OpenAI, Anthropic, Gemini, OpenRouter, Ollama, LM Studio, and more).

---

## Features

### Live Code Map & Blueprint

On-demand graph via `get_blueprint` and structural `search`—not whole-repo injection every turn. Parser tiers, Live View, Blueprint canvas, and `.atlarixignore` are documented in **[docs/architecture.md](docs/architecture.md)**.

### AI Agents & Modes

- **Work modes:** Explore, Plan, Build, Debug, Review.
- **Built-in specialists:** Research, Architect, Builder, Reviewer, Debugger (mode-gated tool surfaces).
- **Atlarix Core:** Managed cloud models with catalog display names. Solo: Speed only; Studio and Team: Speed, Standard, and Deep.

### Workspace Tools & Extensions

- **Core tools:** File read/write, unified **`search`**, `get_blueprint`, terminal (including `git` CLI), web search, **`get_diagram`**, and more. Explore uses a read-only allowlist.
- **MCP:** Up to **10** MCP servers per workspace (Studio / Team marketplace + manual; one-click OAuth connect from the marketplace). On-demand **`list_available_mcps`** / **`mcp_call`** in workspace chat.
- **Agent Behaviors:** Install from [atlarix-skills](https://github.com/AmariahAK/atlarix-skills). Optional **`.atlarix/skills/`** in the repo.

### Editor & diagnostics

- **Monaco** in the Code tab with syntax highlighting in packaged builds.
- **LSP:** Bundled TypeScript and JSON language servers; editor markers and self-correction use LSP diagnostics (not `tsc --watch`).
- **Right panel:** Preview, Code, Terminal (interactive PTY), Activity, and Errors (browser/runtime). Diffs and approvals render inline in chat; **Cmd/Ctrl+P** fuzzy-opens any workspace file in the Code tab.
- **Streaming status:** A small inline compass under the **current** response shows a human-readable one-liner of what the agent is doing ("Writing src/auth.ts…"), settling into the Atlarix "A" when the turn completes.

### Context & Session Management

- **Context bar** — Real-time token usage with color-coded warnings.
- **Compaction** — Model-triggered **`compress_context`** when threads get long.
- **Workspace sessions** — Saved chats per workspace; **New chat** starts a fresh thread; background streams continue when switching sessions.
- **Approval queue** — Approve / reject file and command changes before execution.

### Multi-Provider AI

Cloud providers with native model fetch and tool calling: **OpenAI**, **Anthropic**, **Google Gemini**, **OpenRouter**, **Groq**, **Together AI**, **Mistral**, **xAI**. Plus **Ollama** and **LM Studio** for local / offline models.

---

## Deployment & CI/CD

Releases are built from **this repository** via GitHub Actions ([**Atlarix CI**](.github/workflows/release.yml)). Pushes to **`main`** and pull requests run typecheck, lint, and tests; pushing a **version tag** (`v9.1.0`, etc.) runs those checks first, then the full macOS/Linux/Windows build and publish to [atlarix-releases](https://github.com/AmariahAK/atlarix-releases).

1. Bump **`package.json` `version`** and add a section to [`docs/CHANGELOG.md`](docs/CHANGELOG.md) (9.0+). Archive older sections to [`docs/CHANGELOG_PREVIOUS.md`](docs/CHANGELOG_PREVIOUS.md) when the main file grows too long.
2. Commit, tag, and push:
   ```bash
   git tag v9.1.0
   git push origin v9.1.0
   ```
3. **Actions → Release** builds macOS/Linux/Windows assets and publishes when green.

See [`.github/workflows/release.yml`](.github/workflows/release.yml) and [docs/CREDENTIALS_SETUP.md](docs/CREDENTIALS_SETUP.md) for secrets and migration bundling (`npm run db:bundle-sql` after Drizzle changes).

---

## Installation

### Prerequisites

- **Node.js 24+**
- **macOS or Linux** (Windows supported)

### Development Setup

```bash
git clone https://github.com/AmariahAK/Atlarix.git
cd Atlarix
npm install
cp .env.example .env
npm start
```

After `npm install`, **`postinstall`** runs Electron install, **`fetch-ctags`**, and **`build:astgrep-worker`**. Blueprint details: [docs/architecture.md](docs/architecture.md).

**npm registry:** The repo includes [`.npmrc`](.npmrc) so installs use the public npm registry, not a machine-wide private registry (e.g. AWS CodeArtifact from another project). CI runs [`scripts/verify-npm-lock-registry.mjs`](scripts/verify-npm-lock-registry.mjs) before `npm ci` — run `npm run verify:lockfile` locally before committing lockfile changes. If `npm install` / `npm ci` fails with **401** and CodeArtifact URLs in the log, check your user `~/.npmrc` and remove work-registry settings (optional helper at [`../scripts/strip_work_codeartifact.py`](../scripts/strip_work_codeartifact.py) in the parent workspace). Then `rm -rf node_modules && npm ci` from this directory.

**Schema changes:** Drizzle migration under [`drizzle/`](drizzle/), then `npm run db:generate` (bundles SQL). Add matching checks in [`src/db/migration_seed_verification.ts`](src/db/migration_seed_verification.ts).

---

## Pricing

| Tier      | Price   | Workspaces | Highlights |
|-----------|---------|------------|------------|
| **Solo**  | $0      | 1          | Model Bridge **Speed** only; BYOK / local; core tools; **1** global MCP (manual) |
| **Studio**   | $19/mo  | Unlimited  | **Speed / Standard / Deep**; Agent Behaviors + MCP marketplace; **10** per-workspace MCPs |
| **Team** | $79/mo | Unlimited | Studio + seats, team MCP integrations, repo behavior priority, Blueprint commit to git |

Default Model Bridge allowances: [docs/compass-limits.md](docs/compass-limits.md).

---

## License

PROPRIETARY — All Rights Reserved.  
Copyright 2024–2026 NorahLabs.

---

**Built with care by NorahLabs**
