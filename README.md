# Atlarix
## The Open-Weight Frontier Harness

Atlarix is the agent workstation built for the open-weight frontier labs —
**DeepSeek, Qwen, Kimi, MiniMax** — with any-model BYOK and local-first
execution, without replacing your editor.

Atlarix Core ships the frontier open-weight labs; everything runs through your
approval, on your machine, over your files. Your team writes code in VS Code,
IntelliJ, or Vim. Atlarix gives the agent fast search over your codebase, a
terminal, file operations, web search, and external integrations — no index to
build, no background watcher, constant low memory at any repo size. The agent
has a workspace. You have control.

## How it works

**Search** — Atlarix gives the agent fast, **bundled-ripgrep** search over your workspace — `grep` and `glob` with no index to build, no background file-watcher, and constant low memory at any repo size. Like **Claude Code** and **opencode**, retrieval stays purely lexical: the agent reasons over ranked search results rather than a vector index or a structural map. Nothing is scanned until the agent searches.

**Connect** — Wire in any LLM: local **Ollama / LM Studio**, OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Mistral, xAI, **Hugging Face**, Azure, Bedrock, or **Atlarix Core** (managed models with real catalog names, not raw tier ids — the Core tiers are configured remotely, so the underlying models stay current without an app update).

**Execute** — The agent plans, reads, writes, runs commands (inside a per-OS write-confining sandbox — workspace writes only, network on), and searches the web. You approve every destructive action.

**Remember** — Workspace sessions, attachments, task progress, and project context persist across reloads. The agent maintains `.atlarix/memory.md` (stack, architecture, layout) so new sessions start with project context instead of re-deriving it.

**Created by [NorahLabs](https://norahlabs.com)** (Nairobi, Kenya)  
**Website:** [atlarix.dev](https://atlarix.dev)  
**Current release:** **v14.13.0**

**Downloads:** Installers for **macOS**, **Linux**, and **Windows** are on [atlarix.dev](https://atlarix.dev). *(Windows builds are currently unsigned; code signing is coming soon.)*

**Open ecosystem (source / installers / registries):** community **Agent Behaviors** live in [AmariahAK/atlarix-skills](https://github.com/AmariahAK/atlarix-skills); the **MCP marketplace index** is [AmariahAK/atlarix-mcps](https://github.com/AmariahAK/atlarix-mcps); official desktop builds are published from [AmariahAK/atlarix-releases](https://github.com/AmariahAK/atlarix-releases). The Atlarix app itself is proprietary.

Release notes: **[docs/CHANGELOG.md](docs/CHANGELOG.md)** (current: 14.0+). Older entries: **[docs/CHANGELOG_PREVIOUS.md](docs/CHANGELOG_PREVIOUS.md)**.

---

## What makes Atlarix different

- **Fast search, no index:** The agent searches your repo with **bundled ripgrep** (`grep` + `glob`) — no structural index to build, no background file-watcher, constant low memory at any size. Like **Claude Code** and **opencode**, retrieval stays lexical; the agent reasons over ranked results rather than a vector index or a structural map.
- **Workspace-first:** Open a folder from the welcome screen. Chat, sessions, MCP, and Skills belong to that workspace—no global chat without a project.
- **Work modes:** **Explore** (read-only), **Plan**, **Build**, **Debug**, **Review**.
- **No whole-repo scan:** Opening a workspace doesn't index or scan the repo. The agent discovers files on demand with `glob` and `grep` (ripgrep); the sidebar stays focused on sessions.
- **Attachments:** Paste text, terminal output, and files into chat. After send they appear as chips with preview; content persists across session reload.
- **`@` file & folder mentions:** Type `@` in the composer to point the agent at part of the current workspace. Mentioning a **file** injects its contents (capped); mentioning a **folder** injects just its file listing, so the agent then `grep`s/reads within that scope instead of dumping a whole tree — precise context, low token cost.
- **Agent Behaviors & workspace memory:** Project instructions in `.atlarix/atlarix.md` and behaviors under `.atlarix/skills/` shape the agent without repeating yourself every turn.
- **Parallel sub-agents:** The `task` tool spawns scoped sub-agents — read-only **explorer** and **architect** (recon, planning, web search) plus writer **implementer** agents that edit inside a throwaway git worktree and hand back a reviewable diff — up to five run **concurrently** per turn, with their live thinking, narration, and tool activity streaming into per-agent cards.
- **Background commands:** A foreground command still running after **~15s auto-promotes to the background** (kept alive, not killed) so the agent keeps working; the exit result is delivered back automatically. The agent can also detach explicitly (`run_command background:true`), and a still-foreground command surfaces a **"Waiting on command"** state where you can queue a message that sends when the turn resumes.
- **User-defined agents & portable config:** `.atlarix/agents/<name>.md` (system prompt + tools + model) shows up in the picker; `.atlarix/permissions.json` deny/ask rules and `.atlarix/hooks/` (blocking pre-tool, advisory post-tool, stop gate) are committable and enforced at the single tool-execution funnel — plus a global `~/.atlarix/` layer.
- **Verified edits:** In **Build** and **Debug** the agent discovers and runs the project's *own* checks (package.json scripts, `tsc`/`eslint`, `ruff`/`mypy`/`pytest`) through the terminal — every command run inside the per-OS sandbox — and writes tests for non-trivial logic. It is held to not declaring a task complete while those checks report errors. Verification uses the project's real tooling, so it works on any machine with the language runtime installed.
- **Native tool history:** Tool calls/results ride as provider-native blocks (not flattened text) — weak and local models perform notably better, and multi-step prompt caching holds.
- **Approvals & command sandbox:** File writes wait for explicit approval with a diff preview — accept or reject **individual hunks**, not just whole files, all **inline in chat** (no separate panel). Shell commands run inside a per-OS write-confining sandbox and only the genuinely dangerous ones ask; Explore/Plan/Review are read-only. Allow-once / always-allow decisions are **scoped to the workspace** — approvals saved in one project never carry to another. The same stance as Codex and Claude Code.
- **Voice-to-text:** Dictate to the composer — free on-device **Whisper** by default (private, no key), or **BYOK cloud** (OpenAI / Groq / Gemini with your own key, never billed to Atlarix Core).
- **Automations:** Schedule unattended runs on a cron, GitHub event, or MCP trigger from the Automations tab, with a triage feed of past runs — **2 per workspace on Free, 10 on Pro**.
- **Interactive questions:** The agent can ask you **up to 5 questions in one inline card** (options + free text) and the stream genuinely pauses until you answer — no invented answers, no missed prompts.
- **Native web search:** On providers with built-in search (Anthropic, OpenAI, Gemini 2+, OpenRouter BYOK) the provider's own search tool runs at dispatch with **inline citations that survive reload**; everywhere else the client chain (SearxNG → public SearxNG → DuckDuckGo) is the universal fallback.
- **Prompt caching:** Dispatches are cache-friendly out of the box — Anthropic BYOK turns place `cache_control` breakpoints over the stable system header and conversation history, cutting repeat-turn input cost and latency.
- **Real terminal:** User terminal tabs are full interactive shells (xterm.js + PTY) — Tab completion, arrows, colors, vim/top. Tabs and scrollback **persist across app restarts**, and tab labels track the shell's live cwd. Agent commands run separately with captured output and approvals.

**Providers:** **Atlarix Core** (managed open-weight models, Core 1–4) and broad **BYOK** support (OpenAI, Anthropic, Gemini, OpenRouter, Ollama, LM Studio, and more).

---

## Features

### Search (ripgrep)

Retrieval is **purely lexical — no index, no embeddings, no map tool, no background watcher.** `grep` and `glob` run on **bundled ripgrep** (`@vscode/ripgrep`, shipped inside the app so search works even where `rg` isn't on `PATH`), honoring `.gitignore` and `.atlarixignore`. Like **Claude Code** and **opencode**, the agent reasons over ranked search results rather than a vector index or a structural map — which keeps memory flat and startup instant at any repo size. There's nothing to build on workspace open and nothing running in the background between searches.

### AI Agents & Modes

- **Work modes:** Explore, Plan, Build, Debug, Review.
- **Atlarix Core:** Four managed open-weight models — **Core 1** (fastest) through **Core 4** (most capable). Every plan gets all four; Core is **pay-as-you-go** from a prepaid credit balance (top up from $10), the same on Free and Pro.

### Workspace Tools & Extensions

- **Core tools:** A deliberately minimal tool surface — `read_file`, a single `edit_file` (one tool for create/overwrite via `operation:"write"` plus surgical `operation:"replace"` with self-healing match), **`glob`** + **`grep`** (bundled ripgrep), `run_command` (incl. `git` CLI and background commands), web search/read, `task` sub-agents, `plan`, MCP, attachments, and three in-app browser tools (`browser_navigate`/`browser_inspect`/`browser_interact`). Explore/Plan/Review run a read-only sandbox profile.
- **MCP:** MCP servers are configured **per workspace** — **Free** connects **1** (manual config); **Pro** gets the marketplace plus up to **10** per workspace (one-click OAuth connect from the marketplace). On-demand **`list_available_mcps`** / **`mcp_call`** in workspace chat.
- **Agent Behaviors:** Install from [atlarix-skills](https://github.com/AmariahAK/atlarix-skills). Optional **`.atlarix/skills/`** in the repo.

### Diagnostics & panels

- **Shiki-highlighted code in chat:** code blocks, write proposals, and diffs render with full syntax highlighting — Atlarix works beside your IDE rather than replacing it, so file editing stays in your editor of choice.
- **Right panel:** Preview, Browser, Terminal (interactive PTY), Plan (when a session plan is active), Automations (scheduled unattended runs), and Errors (dev-server/runtime). Diffs and approvals render inline in chat.
- **Streaming status:** A small inline compass under the **current** response shows a human-readable one-liner of what the agent is doing ("Writing src/auth.ts…"), settling into the Atlarix "A" when the turn completes.

### Context & Session Management

- **Context bar** — Real-time token usage with color-coded warnings.
- **Compaction** — Model-triggered **`compress_context`** when threads get long.
- **Workspace sessions** — Saved chats per workspace; **New chat** starts a fresh thread; background streams continue when switching sessions.
- **Approval queue** — Approve / reject file and command changes before execution.

### Multi-Provider AI

Cloud providers with native model fetch and tool calling: **OpenAI**, **Anthropic**, **Google Gemini**, **OpenRouter**, **Groq**, **Together AI**, **Mistral**, **xAI**. Plus **Ollama** and **LM Studio** for local / offline models.

---

## Benchmarks

> **Preliminary, self-run — not an official leaderboard result.** We're working toward a verified place on the [Terminal-Bench leaderboard](https://www.tbench.ai/leaderboard/terminal-bench/2.0); we're not there yet.

A coding harness should let an open model express its full ability. As a first controlled test, we ran Atlarix head-to-head with **[opencode](https://github.com/sst/opencode)** on **Terminal-Bench 2.0** (all 89 tasks), holding the **model, pinned provider, and infrastructure** constant:

| Harness  | Resolved | Score |
| -------- | -------- | ----- |
| Atlarix  | 42 / 89  | 47%   |
| opencode | 39 / 89  | 44%   |

_MiniMax-M3 (fp8) · **single attempt (k=1)** · native function-calling · matched timeouts · Modal._

**This does not prove Atlarix is ahead.** The official leaderboard requires 5 attempts (k=5); we ran one. A 3-task difference at k=1 is within run-to-run noise — at most this says Atlarix is **competitive with a leading harness** on this model (absolute scores sit below the ~66% tuned-scaffold ceiling, as expected at fp8 / single-attempt). The only deviation from the app's default behavior was granting command approval up-front (`ATLARIX_AUTONOMOUS_DANGER=1`) so the agent can run unattended — every agent does this to run a benchmark. Raw result files, full reproduction steps, and roadmap (more models, an official k=5 run): **[atlarix.dev/benchmark](https://atlarix.dev/benchmark)**.

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

`npm run build:headless` bundles an **Electron-free CLI** (`src/headless/`) that drives the real agent loop in plain Node — used by the Terminal-Bench (Harbor) and SWE-bench adapters under [`benchmarks/`](benchmarks/). A prebuilt `linux/amd64` bundle is published as the [`headless-bench`](https://github.com/AmariahAK/atlarix-releases/releases/tag/headless-bench) **prerelease** on atlarix-releases, rebuilt by the [Atlarix Headless workflow](.github/workflows/headless.yml) (run it from **Actions → Atlarix Headless**, or push a `headless-v*` tag). Stable download URL (always newest):

```
https://github.com/AmariahAK/atlarix-releases/releases/download/headless-bench/atlarix-headless-linux-amd64.tar.gz
```

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

After `npm install`, **`postinstall`** runs `patch-package` and the Electron install. `grep`/`glob` use **bundled ripgrep** (`@vscode/ripgrep`), so there's no separate index, parser, or symbol database to fetch or build.

**npm registry:** The repo includes [`.npmrc`](.npmrc) so installs use the public npm registry, not a machine-wide private registry (e.g. AWS CodeArtifact from another project). CI runs [`scripts/verify-npm-lock-registry.mjs`](scripts/verify-npm-lock-registry.mjs) before `npm ci` — run `npm run verify:lockfile` locally before committing lockfile changes. If `npm install` / `npm ci` fails with **401** and CodeArtifact URLs in the log, check your user `~/.npmrc` and remove work-registry settings (optional helper at [`../scripts/strip_work_codeartifact.py`](../scripts/strip_work_codeartifact.py) in the parent workspace). Then `rm -rf node_modules && npm ci` from this directory.

**Schema changes:** Drizzle migration under [`drizzle/`](drizzle/), then `npm run db:generate` (bundles SQL). Add matching checks in [`src/db/migration_seed_verification.ts`](src/db/migration_seed_verification.ts).

---

## Pricing

| Tier      | Price   | Workspaces | Highlights |
|-----------|---------|------------|------------|
| **Free**  | $0      | 1          | All four Core models (pay-as-you-go credits); BYOK / local free; core tools; **1** MCP server per workspace (manual config); **2** automations per workspace |
| **Pro**   | $19/mo  | Unlimited  | Everything in Free + Agent Behaviors + MCP marketplace + one-click OAuth connectors; **10** MCP servers and **10** automations per workspace |

No plan bundles AI. **Atlarix Core is pay-as-you-go on every plan** — top up a prepaid credit balance (from **$10**) and it's metered as you go (each new account gets a one-time **$1** trial credit); **BYOK and local models are free on every plan**. Only the harness features differ by tier. See [docs/compass-limits.md](docs/compass-limits.md).

---

## License

PROPRIETARY — All Rights Reserved.  
Copyright 2024–2026 NorahLabs.

---

**Built with care by NorahLabs**
