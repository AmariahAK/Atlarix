# Atlarix
## The Open-Weight Frontier Harness

Atlarix is the agent workstation built for the open-weight frontier labs —
**DeepSeek, Qwen, Kimi, MiniMax** — with any-model BYOK and local-first
execution, without replacing your editor.

Atlarix Core ships the frontier open-weight labs; **Blueprint** — the local
structural index — silently sharpens every `grep` so any model performs like it
knows your codebase; and everything runs through your approval, on your machine.
Your team writes code in VS Code, IntelliJ, or Vim. Atlarix gives the agent a
fast, relevance-ranked view of the codebase, a terminal, file operations, web
search, and external integrations. The agent has a workspace. You have control.

## How it works

**Map** — Atlarix builds a live **Blueprint** per workspace (Universal Ctags + ast-grep edges) into a disk-backed SQLite **FTS5** index. There's no map tool to call: Blueprint silently reranks every `grep` by structural relevance (most relevant files first, each annotated with its enclosing function/class) and powers edit-time blast-radius — no whole-repo dumps, no embeddings, constant low memory at any size.

**Connect** — Wire in any LLM: local **Ollama / LM Studio**, OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Mistral, xAI, **Hugging Face**, Azure, Bedrock, or **Atlarix Core** (managed models with real catalog names, not raw tier ids — the Core tiers are configured remotely, so the underlying models stay current without an app update).

**Execute** — The agent plans, reads, writes, runs commands (inside a per-OS write-confining sandbox — workspace writes only, network on), and searches the web. You approve every destructive action.

**Remember** — Workspace sessions, attachments, task progress, and project context persist across reloads. The agent maintains `.atlarix/memory.md` (stack, architecture, layout) so new sessions skip full re-scans.

**Created by [NorahLabs](https://norahlabs.com)** (Nairobi, Kenya)  
**Website:** [atlarix.dev](https://atlarix.dev)  
**Current release:** **v13.7.0**

**Downloads:** Installers for **macOS**, **Linux**, and **Windows** are on [atlarix.dev](https://atlarix.dev). *(Windows builds are currently unsigned; code signing is coming soon.)*

**Open ecosystem (source / installers / registries):** community **Agent Behaviors** live in [AmariahAK/atlarix-skills](https://github.com/AmariahAK/atlarix-skills); the **MCP marketplace index** is [AmariahAK/atlarix-mcps](https://github.com/AmariahAK/atlarix-mcps); official desktop builds are published from [AmariahAK/atlarix-releases](https://github.com/AmariahAK/atlarix-releases). The Atlarix app itself is proprietary.

Release notes: **[docs/CHANGELOG.md](docs/CHANGELOG.md)** (current: 13.0+). Older entries: **[docs/CHANGELOG_PREVIOUS.md](docs/CHANGELOG_PREVIOUS.md)**.

---

## What makes Atlarix different

- **Live Code Map:** Your repo is parsed into a live structural index (Ctags symbols + ast-grep edges) that reranks `grep` and drives edit-time blast-radius — the agent gets relevance-ranked, symbol-annotated results without a separate map tool. Technical details: [docs/architecture.md](docs/architecture.md).
- **Workspace-first:** Open a folder from the welcome screen. Chat, sessions, MCP, and Skills belong to that workspace—no global chat without a project.
- **Work modes:** **Explore** (read-only), **Plan**, **Build**, **Debug**, **Review**.
- **On-demand file discovery:** Opening a workspace does not scan the whole repo via git. The Code tab loads the file tree when you need it (plus a **Cmd/Ctrl+P** fuzzy file opener); the sidebar stays focused on sessions; the agent uses `glob` and `grep` (Blueprint-reranked).
- **Attachments:** Paste text, terminal output, and files into chat. After send they appear as chips with preview; content persists across session reload.
- **`@` file & folder mentions:** Type `@` in the composer to point the agent at part of the current workspace. Mentioning a **file** injects its contents (capped); mentioning a **folder** injects just its file listing, so the agent then `grep`s/reads within that scope instead of dumping a whole tree — precise context, low token cost.
- **Agent Behaviors & workspace memory:** Project instructions in `.atlarix/atlarix.md` and behaviors under `.atlarix/skills/` shape the agent without repeating yourself every turn.
- **Parallel sub-agents:** The `task` tool spawns scoped read-only scouts — up to five run **concurrently** per turn, with their live thinking, narration, and tool activity streaming into per-agent cards.
- **Background commands:** The agent can run long commands detached (`run_command background:true`) and keep working; the exit result is delivered back automatically. Foreground commands that run long flip the chat into a visible **"Waiting on command"** state with a timer — you can queue a message that sends when the turn resumes.
- **User-defined agents & portable config:** `.atlarix/agents/<name>.md` (system prompt + tools + model) shows up in the picker; `.atlarix/permissions.json` deny/ask rules and `.atlarix/hooks/` (blocking pre-tool, advisory post-tool, stop gate) are committable and enforced at the single tool-execution funnel — plus a global `~/.atlarix/` layer.
- **Verified edits:** In **Build** and **Debug** the agent discovers and runs the project's *own* checks (package.json scripts, `tsc`/`eslint`, `ruff`/`mypy`/`pytest`) through the terminal — every command routed through the approval queue — and writes tests for non-trivial logic. It is held to not declaring a task complete while those checks report errors. Verification uses the project's real tooling, so it works on any machine with the language runtime installed.
- **Native tool history:** Tool calls/results ride as provider-native blocks (not flattened text) — weak and local models perform notably better, and multi-step prompt caching holds.
- **Approval queue:** File writes and shell commands wait for explicit approval with diff preview — accept or reject **individual hunks**, not just whole files. Allow-once / always-allow decisions are **scoped to the workspace** — approvals saved in one project never carry to another.
- **Interactive questions:** The agent can ask you **up to 5 questions in one inline card** (options + free text) and the stream genuinely pauses until you answer — no invented answers, no missed prompts.
- **Native web search:** On providers with built-in search (Anthropic, OpenAI, Gemini 2+, OpenRouter BYOK) the provider's own search tool runs at dispatch with **inline citations that survive reload**; everywhere else the client chain (SearxNG → public SearxNG → DuckDuckGo) is the universal fallback.
- **Prompt caching:** Dispatches are cache-friendly out of the box — Anthropic BYOK turns place `cache_control` breakpoints over the stable system header and conversation history, cutting repeat-turn input cost and latency.
- **Real terminal:** User terminal tabs are full interactive shells (xterm.js + PTY) — Tab completion, arrows, colors, vim/top. Tabs and scrollback **persist across app restarts**, and tab labels track the shell's live cwd. Agent commands run separately with captured output and approvals.

**Providers:** **Atlarix Core** (managed open-weight models, Core 1–4) and broad **BYOK** support (OpenAI, Anthropic, Gemini, OpenRouter, Ollama, LM Studio, and more).

---

## Features

### Live Code Map & Blueprint

Retrieval is **structural + lexical, no embeddings, no map tool**. Blueprint (Universal Ctags + ast-grep edges) feeds a disk-backed SQLite **FTS5** index that reranks `grep` by relevance and scales to any repo size at constant low memory. `grep` returns sharp, low-token results: the most relevant files first, each annotated with its enclosing function/class (zoekt-style) so the model jumps straight to the symbol — and the same index drives edit-time blast-radius. There's no separate structural tool for the agent to call; like **Claude Code** and **opencode**, retrieval stays lexical and the agent reasons over ranked results rather than a vector index. `.atlarixignore` and parser tiers are documented in **[docs/architecture.md](docs/architecture.md)**.

### AI Agents & Modes

- **Work modes:** Explore, Plan, Build, Debug, Review.
- **Atlarix Core:** Four managed open-weight models — **Core 1** (fastest) through **Core 4** (most capable). Every plan gets all four; plans differ by monthly allowance.

### Workspace Tools & Extensions

- **Core tools:** A deliberately minimal tool surface — `read_file`/`write_file`/`edit_file`, **`glob`** + **`grep`** (Blueprint-reranked), `run_command` (incl. `git` CLI and background commands), web search/read, `task` sub-agents, `plan`, MCP, attachments, and the in-app browser tools. Explore/Plan/Review use read-only allowlists.
- **MCP:** MCP servers are configured **per workspace** — Solo connects **1** (manual config); Studio / Team get the marketplace plus up to **10** per workspace (one-click OAuth connect from the marketplace). On-demand **`list_available_mcps`** / **`mcp_call`** in workspace chat.
- **Agent Behaviors:** Install from [atlarix-skills](https://github.com/AmariahAK/atlarix-skills). Optional **`.atlarix/skills/`** in the repo.

### Editor & diagnostics

- **Monaco** in the Code tab with syntax highlighting in packaged builds.
- **Right panel:** Preview, Code, Browser, Terminal (interactive PTY), Plan (when a session plan is active), and Errors (dev-server/runtime). Diffs and approvals render inline in chat; **Cmd/Ctrl+P** fuzzy-opens any workspace file in the Code tab.
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

### Headless agent (benchmarking / CI)

`npm run build:headless` bundles an **Electron-free CLI** (`src/headless/`) that drives the real agent loop in plain Node — used by the Terminal-Bench (Harbor) and SWE-bench adapters under [`benchmarks/`](benchmarks/). A prebuilt `linux/amd64` bundle is published as the [`headless-bench`](https://github.com/AmariahAK/atlarix-releases/releases/tag/headless-bench) release on atlarix-releases.

```bash
node dist-headless/atlarix-headless.mjs \
  --workspace /path/to/repo --prompt-file task.md \
  --provider-id openrouter --model deepseek/deepseek-v4-pro \
  --api-key "$OPENROUTER_API_KEY" \
  --openrouter-provider '{"order":["deepinfra"],"allow_fallbacks":false}'
```

All flags have `ATLARIX_HEADLESS_*` env-var equivalents; `--mode build|ask`; exit `0` = completed. Custom OpenAI-compatible endpoints via `--provider-url`.

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
| **Solo**  | $0      | 1          | All four Core models (**starter allowance**); BYOK / local; core tools; **1** MCP server per workspace (manual config) |
| **Studio**   | $19/mo  | Unlimited  | All four Core models (**higher allowance**); Agent Behaviors + MCP marketplace; **10** MCP servers per workspace |
| **Team** | $79/mo | Unlimited | Studio + seats, **team allowance pool**, team MCP integrations, repo behavior priority |

Every plan gets all four **Atlarix Core** models (Core 1 fastest → Core 4 most capable) — only the monthly allowance differs by tier. Default allowances: [docs/compass-limits.md](docs/compass-limits.md).

---

## License

PROPRIETARY — All Rights Reserved.  
Copyright 2024–2026 NorahLabs.

---

**Built with care by NorahLabs**
