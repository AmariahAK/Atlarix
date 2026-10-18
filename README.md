# Atlarix

## The Private AI Workstation

Atlarix is the agent workstation for engineering teams — managed cloud models
via Atlarix Core, your own API keys across <!-- CATALOG:providers:START (generated — run scripts/gen-readme-catalog.mjs) -->220+ providers<!-- CATALOG:providers:END -->, and local models —
all without replacing your editor.

**What "private" means here:** your code stays on your machine. Nothing indexes
your repo, no embeddings are built, no file contents are sent as telemetry, and
nothing changes on disk without your approval. Local models and your own API
keys talk only to the endpoint you chose. **Atlarix Core** routes your request
through our authenticated proxy — we don't log or retain it — to the model
provider that serves it, under their data policy.

Your team writes code in VS Code, IntelliJ, or Vim. Atlarix gives the agent fast
search over your codebase, a terminal, file operations, web search, and external
integrations — no index to build, no background watcher, constant low memory at
any repo size. The agent has a workspace. You have control.

## How it works

**Search** — Atlarix gives the agent fast, **bundled-ripgrep** search over your workspace — `grep` and `glob` with no index to build, no background file-watcher, and constant low memory at any repo size. Retrieval stays purely lexical: the agent reasons over ranked search results rather than a vector index or a structural map. Nothing is scanned until the agent searches.

**Connect** — Wire in any LLM: local **Ollama / LM Studio**, **<!-- CATALOG:providers-and-models:START (generated — run scripts/gen-readme-catalog.mjs) -->220+ cloud providers and 6,500+ tool-capable models<!-- CATALOG:providers-and-models:END -->** read live from the [models.dev](https://models.dev) catalog (OpenAI, Anthropic, Google Gemini, and every OpenAI-compatible endpoint), or **Atlarix Core** (managed models with real catalog names, not raw tier ids — the Core tiers are configured remotely, so the underlying models stay current without an app update). The catalog refreshes hourly and ships with an offline snapshot, so new models appear without an app update and the picker is never empty.

**Execute** — The agent plans, reads, writes, runs commands (inside a per-OS write-confining sandbox — writes confined to your workspace plus any folder you explicitly grant, network on), and searches the web. You approve every destructive action.

**Remember** — Workspace sessions, attachments, task progress, and project context persist across reloads. The agent keeps per-note project memory under `~/.atlarix/projects/<slug>/memory/` (outside your repo, never committed) and carries only its one-line index into context, so new sessions start with project context instead of re-deriving it — and the cost stays flat as it learns more.

**Created by [NorahLabs](https://norahlabs.com)** (Nairobi, Kenya)  
**Website:** [atlarix.dev](https://atlarix.dev)  
**Current release:** **v15.9.2**

**Downloads:** Installers for **macOS**, **Linux**, and **Windows** are on [atlarix.dev](https://atlarix.dev). _(Windows builds are currently unsigned; code signing is coming soon.)_

**In your terminal:** `curl -fsSL https://atlarix.dev/install | sh` (macOS, Linux), `irm https://atlarix.dev/install.ps1 | iex` (Windows), `brew install amariahak/atlarix/atlarix`, or `npm i -g atlarix`.

**In VS Code, Cursor, Kiro and Windsurf:** install **Atlarix** from the VS Code Marketplace or Open VSX — it carries its own copy of the CLI. Chat, modes, models (your own keys too), edits in the editor's diff, plans, your Chrome, your other sessions, and an Account panel. Guide: [atlarix.dev/docs/guides/editors](https://atlarix.dev/docs/guides/editors).

**In Zed and JetBrains IDEs:** the CLI is also an [Agent Client Protocol](https://agentclientprotocol.com) agent: `atlarix acp`. The editor draws the chat, the diffs and the Allow/Deny prompts, and Atlarix does the work with your account, models and settings. Sign in once with `atlarix login`.

- **Zed** (`~/.config/zed/settings.json`): `"agent_servers": { "Atlarix": { "type": "custom", "command": "atlarix", "args": ["acp"] } }`
- **JetBrains** (AI Assistant → Agents → Add Custom Agent, or `~/.jetbrains/acp.json`): `"agent_servers": { "Atlarix": { "command": "/full/path/to/atlarix", "args": ["acp"] } }`

**Open ecosystem (source / installers / registries):** the **MCP marketplace** is the official [MCP Registry](https://registry.modelcontextprotocol.io); official desktop builds are published from [AmariahAK/atlarix-releases](https://github.com/AmariahAK/atlarix-releases). The Atlarix app itself is proprietary.

Release notes: **[docs/CHANGELOG.md](docs/CHANGELOG.md)** — the current major (15.x) in full. Everything older is one line per version in **[docs/CHANGELOG_PREVIOUS.md](docs/CHANGELOG_PREVIOUS.md)**; the prose is in git history.

---

## What makes Atlarix different

- **Fast search, no index:** The agent searches your repo with **bundled ripgrep** (`grep` + `glob`) — no structural index to build, no background file-watcher, constant low memory at any size. Retrieval stays lexical; the agent reasons over ranked results rather than a vector index or a structural map.
- **Workspace-first:** Open a folder from the welcome screen. Chat, sessions, MCP, and Skills belong to that workspace—no global chat without a project.
- **Work modes:** **Explore** (read-only), **Plan**, **Build**, **Debug**, **Review**.
- **No whole-repo scan:** Opening a workspace doesn't index or scan the repo. The agent discovers files on demand with `glob` and `grep` (ripgrep); the sidebar stays focused on sessions.
- **Attachments:** Paste text, terminal output, and files into chat. After send they appear as chips with preview; content persists across session reload.
- **`@` file & folder mentions:** Type `@` in the composer to point the agent at part of the current workspace. Mentioning a **file** injects its contents (capped); mentioning a **folder** injects just its file listing, so the agent then `grep`s/reads within that scope instead of dumping a whole tree — precise context, low token cost.
- **Project rules & skills:** Project instructions in `.atlarix/rules/*.md` (with `.atlarix/atlarix.md`, then `AGENTS.md`, then `CLAUDE.md` as fallbacks — rules are plural, so they are a directory) and skills under `.atlarix/skills/` shape the agent without repeating yourself every turn. Both are **pointers, not payloads** — the agent sees a one-line index of what exists and reads the full file when it applies, so adding a tenth behavior costs a line rather than a page.
- **Parallel workers:** The `task` tool spawns scoped workers — a read-only **explore** agent (code recon and web research) and a writer **build** agent whose edits never touch disk and come back as per-file **proposals** the main agent reviews and accepts — up to five run **concurrently** per turn, with their live thinking, narration, and tool activity streaming into per-worker cards. Long-running workers move to the background automatically and can be listed, watched, or cancelled.
- **Background commands:** A foreground command still running after **~15s auto-promotes to the background** (kept alive, not killed) so the agent keeps working; the exit result is delivered back automatically. The agent can also detach explicitly (`run_command background:true`), and a still-foreground command surfaces a **"Waiting on command"** state where you can queue a message that sends when the turn resumes.
- **User-defined agents & portable config:** `.atlarix/agents/<name>.md` (system prompt + tools + model) shows up in the picker; `.atlarix/permissions.json` deny rules are committable and enforced at the single tool-execution funnel — plus a global `~/.atlarix/` layer.
- **Verified edits:** In **Build** and **Debug** the agent discovers and runs the project's _own_ checks (package.json scripts, `tsc`/`eslint`, `ruff`/`mypy`/`pytest`) through the terminal — every command run inside the per-OS sandbox — and writes tests for non-trivial logic. It is held to not declaring a task complete while those checks report errors. Verification uses the project's real tooling, so it works on any machine with the language runtime installed.
- **Native tool history:** Tool calls/results ride as provider-native blocks (not flattened text) — weak and local models perform notably better, and multi-step prompt caching holds.
- **Approvals & command sandbox:** File writes wait for explicit approval with a diff preview — accept or reject **individual hunks**, not just whole files, all **inline in chat** (no separate panel). Shell commands run inside a per-OS write-confining sandbox and only the genuinely dangerous ones ask; Explore/Plan/Review are read-only. Allow-once / always-allow decisions are **scoped to the workspace** — approvals saved in one project never carry to another.
- **Work beyond one folder:** The workspace is the default scope, not a wall. The agent reads and searches another project by absolute path with no ceremony; the first _write_ to a folder outside the workspace asks you once for that folder, and the grant then covers both file edits and shell commands. Cross-repo edits are snapshotted like any other, so **Revert covers them too**.
- **Voice-to-text:** Dictate to the composer — with your own provider key (OpenAI / Groq / Gemini, never billed to Atlarix Core), or straight through the model you're on when it accepts audio. The mic only appears when one of the two is available.
- **Automations:** Schedule unattended runs on a cron or MCP trigger from the Automations tab, with a triage feed of past runs — up to **10 per workspace**.
- **Interactive questions:** The agent can ask you **up to 5 questions in one inline card** (options + free text) and the stream genuinely pauses until you answer — no invented answers, no missed prompts.
- **Native web search:** On providers with built-in search (Anthropic, OpenAI, Gemini 2+) the provider's own search tool runs at dispatch with **inline citations that survive reload**; everywhere else a built-in search chain provides a universal fallback, with optional local private search via Docker.
- **Prompt caching:** Dispatches are cache-friendly out of the box — Anthropic API key turns place `cache_control` breakpoints over the stable system header and conversation history, cutting repeat-turn input cost and latency.
- **Real terminal:** User terminal tabs are full interactive shells (xterm.js + PTY) — Tab completion, arrows, colors, vim/top. Tabs and scrollback **persist across app restarts**, and tab labels track the shell's live cwd. Agent commands run separately with captured output and approvals.

**Providers:** **Atlarix Core** (managed models, configured remotely rather than pinned to a release) plus your own API keys across <!-- CATALOG:providers:START (generated — run scripts/gen-readme-catalog.mjs) -->220+ providers<!-- CATALOG:providers:END --> (OpenAI, Anthropic, Gemini, and more) and local models (Ollama, LM Studio).

---

## Features

### Search (ripgrep)

Retrieval is **purely lexical — no index, no embeddings, no map tool, no background watcher.** `grep` and `glob` run on **bundled ripgrep** (`@vscode/ripgrep`, shipped inside the app so search works even where `rg` isn't on `PATH`), honoring `.gitignore` and `.atlarixignore`. The agent reasons over ranked search results rather than a vector index or a structural map — which keeps memory flat and startup instant at any repo size. There's nothing to build on workspace open and nothing running in the background between searches.

### AI Agents & Modes

- **Work modes:** Explore, Plan, Build, Debug, Review.
- **Atlarix Core:** Managed cloud models, named in the picker by what they actually are. The lineup is configured remotely ([`core-models.json`](https://github.com/AmariahAK/atlarix-releases/blob/main/core-models.json)) rather than fixed in a release, so it changes without an app update. **This file therefore does not name the models** — it ships with a release and the lineup does not, which is how the README once advertised four Core models while two were configured. The current lineup, with each model's context window, is on [atlarix.dev/docs/guides/core-models](https://www.atlarix.dev/docs/guides/core-models) (derived from that JSON and CI-checked against it). Every plan can use every Core model; there is no tier gating and no model is reserved for a paid plan. Pro includes Core for everyday work and draws on a prepaid credit balance beyond that; Free draws on that balance from the start (top up from $10).

### Workspace Tools & Extensions

- **Core tools:** A deliberately minimal tool surface — `read_file`, a single `edit_file` (one tool for create/overwrite via `operation:"write"` plus surgical `operation:"replace"` with self-healing match), **`glob`** + **`grep`** (bundled ripgrep), `run_command` (incl. `git` CLI and background commands), web search/read, `task` parallel workers, `plan`, MCP, attachments, and the in-app browser tools (`browser_inspect` to read a page, `browser` to act on it). Explore/Plan/Review run a read-only sandbox profile.
- **MCP:** MCP servers are configured **per workspace** — up to **10** each, added manually or in one click from the marketplace (including OAuth connectors). On-demand **`list_available_mcps`** / **`mcp_call`** in workspace chat.
- **Skills:** Markdown files in **`.atlarix/skills/`** that teach Atlarix a repeatable job — write one, or ask Atlarix to. Their names and descriptions are in the prompt; the file itself is read only when it is relevant, so the count costs you nothing.

### Diagnostics & panels

- **Shiki-highlighted code in chat:** code blocks, write proposals, and diffs render with full syntax highlighting — Atlarix works beside your IDE rather than replacing it, so file editing stays in your editor of choice.
- **Right panel:** Browser (multi-tab, with visible cursor, element finding, and full keyboard/hover/scroll control), Terminal (interactive PTY), Plan (when a session plan is active), Automations (scheduled unattended runs), and Errors (dev-server/runtime). Diffs and approvals render inline in chat.
- **Streaming status:** A small inline compass under the **current** response shows a human-readable one-liner of what the agent is doing ("Writing src/auth.ts…"), settling into the Atlarix "A" when the turn completes.

### Context & Session Management

- **Context bar** — Real-time token usage with color-coded warnings.
- **Compaction** — One summariser, three triggers: automatically before a request that would exceed the window, mid-task when a long tool loop would, and on demand via **`compress_context`**. The summary is **durable** — it survives quitting and reopening, so the next message doesn't pay to summarise the same history again.
- **`session_search`** — Search or re-read this conversation's earlier turns, or an earlier conversation in the workspace, **including turns a summary has already replaced**. Scoped to the open workspace; a deleted session is unfindable.
- **Workspace sessions** — Saved chats per workspace; **New chat** starts a fresh thread; background streams continue when switching sessions.
- **Approval queue** — Approve / reject file and command changes before execution.

### Multi-Provider AI

Cloud providers with native model fetch and tool calling: **OpenAI**, **Anthropic**, **Google Gemini**, **Groq**, **Together AI**, **Mistral**, **xAI**. Plus **Ollama** and **LM Studio** for local / offline models.

---

## Benchmarks

> **Preliminary, self-run — not an official leaderboard result.** We're working toward a place on the [Terminal-Bench leaderboard](https://www.tbench.ai/); we're not there yet, and the route runs through Harbor: community submissions to Terminal-Bench 4.0 are currently closed, so a listed run has to be executed by the maintainers, which in turn means Atlarix has to be a pre-integrated Harbor agent first.

A coding harness should let an open model express its full ability. As a first controlled test, we ran Atlarix head-to-head with **[opencode](https://github.com/sst/opencode)** on **Terminal-Bench 2.0** (all 89 tasks), holding the **model, pinned provider, and infrastructure** constant:

| Harness  | Resolved | Score |
| -------- | -------- | ----- |
| Atlarix  | 42 / 89  | 47%   |
| opencode | 39 / 89  | 44%   |

_MiniMax-M3 (fp8) · **single attempt (k=1)** · native function-calling · matched timeouts · Modal._

> **Measured 2026-08 on Atlarix v14.36-era, and superseded in two ways.** Terminal-Bench has
> since moved to **4.0** (2.x scores are not comparable to it — 4.0 recalibrated task
> resources, dropped saturated tasks and standardised an 8-hour agent timeout), and the
> headless runner that produced these numbers dispatched reasoning one notch **below** each
> model's declared ceiling, while every published leaderboard entry runs the ceiling. Both are
> fixed; the run has not been repeated yet. Treat the table as a historical data point, not a
> current claim.

**This does not prove Atlarix is ahead.** The official leaderboard requires 5 attempts (k=5); we ran one. A 3-task difference at k=1 is within run-to-run noise — at most this says Atlarix is **competitive with a leading harness** on this model (absolute scores sit below the ~66% tuned-scaffold ceiling, as expected at fp8 / single-attempt). The only deviation from the app's default behavior was granting command approval up-front (`ATLARIX_AUTONOMOUS_DANGER=1`) so the agent can run unattended — every agent does this to run a benchmark. Raw result files, full reproduction steps, and roadmap (more models, an official k=5 run): **[atlarix.dev/benchmark](https://atlarix.dev/benchmark)**.

---

## Deployment & CI/CD

Releases are built from **this repository** via GitHub Actions ([**Atlarix CI**](.github/workflows/release.yml)). Pushes to **`main`** or **`dev`** and pull requests run typecheck, lint, and tests; pushing a **version tag** (`vX.Y.Z`) runs those checks first, then the full macOS/Linux/Windows build and publish to [atlarix-releases](https://github.com/AmariahAK/atlarix-releases).

### Branches

**`dev` is the working branch; `main` is the release branch.** Day-to-day work lands on `dev`, which runs
the same quality gate as `main` — typecheck, lint, the Rust sandbox cross-target check, tests, and the
dead-code report. When a release is ready, merge `dev` into `main`, **wait for CI to go green**, and only
then tag. Nothing else can fire from a branch push: every build and publish job is gated on a `v*` tag.

`main` remains GitHub's default branch, because the release tooling, the [atlarix-releases](https://github.com/AmariahAK/atlarix-releases) repo, and clone URLs all assume it — so new pull requests open against `main` and want retargeting to `dev`. This split is a **convention held by CI and discipline, not an enforced gate**: branch protection needs GitHub Pro on a private repository, and this one is on the free plan.

1. Bump **`package.json` `version`** and add a section to [`docs/CHANGELOG.md`](docs/CHANGELOG.md), keeping roughly the last **ten** releases there. Older ones get **one line** each in [`docs/CHANGELOG_PREVIOUS.md`](docs/CHANGELOG_PREVIOUS.md) — not their prose, which stays in git history. Only the CURRENT version's section is read by the release tooling, so archiving is safe. This policy existed and was ignored until the file held 26 releases; trim on the way past ten, not later.
2. Refresh the bundled model catalog: `npm run models:snapshot` (writes `build/models-snapshot.json.gz`) and commit it. This is the offline floor for the model picker — a stale snapshot self-heals on first successful refresh, so this is a nice-to-have, not a blocker.
3. Merge `dev` into `main`, push, and **wait for the `quality` run to go green** — then tag:
   ```bash
   git checkout main && git merge --no-ff dev && git push origin main
   # wait for Actions -> Atlarix CI to pass on main
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
4. **Actions → Release** builds macOS/Linux/Windows assets and publishes when green.

See [`.github/workflows/release.yml`](.github/workflows/release.yml) for the secrets each job needs, and run `npm run db:bundle-sql` after any Drizzle change so the migration bundle ships.

### Headless agent (benchmarking / CI)

The **Electron-free CLI** (`src/headless/`) drives the real agent loop in plain Node — for benchmarks, CI and unattended runs. Install it with one command:

```bash
npm i -g atlarix          # requires Node >=20
atlarix run --workspace /path/to/repo --prompt-file task.md \
  --provider-id deepseek --model deepseek-v4-flash \
  --deep-thinking --trajectory-file trajectory.jsonl
```

The API key comes from `ATLARIX_HEADLESS_API_KEY` (or `--api-key`, though the env var keeps it out of the process command line). `--deep-thinking` selects the model's own declared reasoning ceiling. `--trajectory-file` writes a JSONL trace — tool calls with their arguments and results, real token and cost totals — streamed as the run happens, so a run that is killed still leaves everything up to that point. Credentials are stripped from every line.

Published from [`packages/headless`](packages/headless) by the [Atlarix Headless workflow](.github/workflows/headless.yml) on any `v*` or `headless-v*` tag, over OIDC with no stored token.

**Prebuilt tarball (fallback).** A `linux/amd64` bundle carrying a compiled `better-sqlite3` is also attached to the [`headless-bench`](https://github.com/AmariahAK/atlarix-releases/releases/tag/headless-bench) prerelease. Prefer npm; this exists for images where npm can neither find a `better-sqlite3` prebuild nor compile one (musl/Alpine, an unusual Node ABI). Stable URL, always newest:

```
https://github.com/AmariahAK/atlarix-releases/releases/download/headless-bench/atlarix-headless-linux-amd64.tar.gz
```

Build either locally with `npm run build:headless` (bundle) or `npm run build:headless:npm` (bundle + staged npm package).

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

**The app is free.** Every feature is on every plan — unlimited workspaces, the MCP
marketplace, one-click OAuth connectors, automations, workspace
snapshots, the full tool surface. Your own API keys and local models (Ollama, LM Studio)
cost nothing, on any plan, forever.

What you pay for is **Atlarix Core** — the managed models we host and meter. Top up a
prepaid balance from **$10** and it is billed as you use it, with the exact cost of every
call shown in the app.

|          | Price  | What it is                                                                                                                    |
| -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **Free** | $0     | The whole app. Atlarix Auto free (a fair daily share); Core models on pay-as-you-go credit.                                   |
| **Pro**  | $19/mo | The whole app, plus **Atlarix Reviewer**, plus Atlarix Core included for everyday work. Heavier use draws on the same credit. |

**One subscription, one balance.** Pro covers the desktop app and Atlarix Reviewer from a
single monthly Core allowance — they are not billed separately and they do not hold
separate balances. See [docs/CORE_BILLING.md](docs/CORE_BILLING.md).

### Atlarix Reviewer

A GitHub App that reviews every pull request on the repositories you choose and posts its
findings as review comments — file, line, what is wrong, and the fix. It never writes to
your code, and it never executes, builds or tests it.

Reviews run on Atlarix Core, so they need a funded balance: either the allowance that
comes with Pro, or pay-as-you-go credit. Your account page itemises what reviewing has
spent separately from the app.

---

## License

PROPRIETARY — All Rights Reserved.  
Copyright 2024–2026 NorahLabs.

---

**Built with care by NorahLabs**
