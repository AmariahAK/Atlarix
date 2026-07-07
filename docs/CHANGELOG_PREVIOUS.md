# Atlarix Changelog — Previous releases (before 14.0)

**Atlarix 14.0** and newer release notes are in [CHANGELOG.md](CHANGELOG.md).

Everything below covers **13.9.0 down through 8.0.x** and older entries archived from the main changelog.

## [13.9.0] (2026-06-19) — Reliability pass: terminal reuse, live plan preview, steadier long runs, robust sign-in, tidy file tree + accurate diffs, self-review, cross-platform updater

- AI terminal reuses one persistent "Agent" tab for sequential foreground commands (background processes still get their own tab).
- Plan writes stream live, and long turns no longer show a false "stopped/Reconnecting…" (activity pulse on tool start + every ~15s, 20s reconnect window).
- Sign-in survives relaunch: startup session restore retries secure-storage reads and token refresh with backoff.
- Code tab file tree hides `.git`/`.vscode`/`.idea`/`node_modules` and gitignored files.
- PostHog activation-funnel events shipped (`app_opened`, `model_connected`, `first_task_started/completed`, `task_completed`).

## [13.9.0-pre] — Airtight overwrite diffs, on-disk edit self-review, and a real cross-platform auto-updater

- Auto-approved overwrites now render accurate red/green diffs via a display-only `chat:stream:write-preview` event, at zero model tokens.
- Edits self-review against disk after each write; a single consolidated review fires at the `task_complete` gate only if an edit didn't verify.
- Background auto-updater works on all platforms with errors surfaced in a new Settings → Updates diagnostics panel.
- `docs/harness-comparison.md` rewritten (verdict: the open-weight frontier workstation).

## [13.8.1] (unreleased) — Zero-token, accurate file diffs (display-only, never re-sent to the model)

- Write/edit diff cards no longer echo file content into the model transcript (the tool-call args already contain it once).
- Diffs render from a display-only source (tool-call args + full uncapped old/new from the permission preview) that survives reload — including full overwrites — at zero model-token cost.

## [13.8.0] (unreleased) — One file-mutation tool, fewer browser tools, no more false "Reconnecting…"

- `write_file` merged into `edit_file` (`operation:"write"`) — one file-mutation tool for create/overwrite plus surgical ops.
- Browser tools consolidated 6 → 3 (`browser_navigate`/`browser_inspect`/`browser_interact`); net agent surface 24 → 20.
- Live streaming preview for file writes, a visible AI cursor in the browser, and a browser session-record timeline artifact.
- `git init` allowed by default; `glob` and ignore rules now honor `.gitignore` (incl. monorepos) + `.atlarixignore`.
- Fixed false "Reconnecting…" during long writes plus persistent `run_command`/write diff cards.

## [13.7.0] (2026-06-18) — Blueprint becomes the silent grep substrate, `@` mentions as chips, fewer Supabase pings, editable plans, a hardened agent loop + headless CLI

- `get_blueprint` tool removed; the Blueprint index now silently reranks every `grep` and powers edit-time blast-radius.
- `@` file/folder mentions render as removable chips; plans are editable before and during a build.
- `task_complete` completion tool replaces the text sentinel; edit + `run_command` mutation verifiers block a premature finish.
- Headless Electron-free agent CLI + benchmark harness (Terminal-Bench / SWE-bench).
- Fewer Supabase pings (TTL-cached tier/subscription); OAuth tokens no longer logged; MCP env vars encrypted at rest.

## [13.6.0] (2026-06-16) — Surface simplification: scoped `@` mentions, tiers collapsed to Core 1–4, deploy connectors removed, Review absorbs security

- Model tiers collapsed to four individual Core models (Core 1–4); every plan can use every model.
- Scoped `@` file/folder mentions in the current workspace replace the whole-codebase dump.
- Deploy connectors (Supabase/Neon/Vercel/GitHub Actions) removed for a terminal-first + MCP-only flow; the `/` slash-command system deleted.
- Review mode absorbs the standalone security-review.
- Live BYOK context limits, a session-resume prompt, and one-click MCP OAuth marketplace connect.

## [13.5.0] (2026-06-13) — Open-weight Core providers, disk-backed FTS5 retrieval, writer sub-agents, real Windows sandbox

- Open-weight Core providers — DeepSeek, Qwen, Kimi, MiniMax — with model lists from the live models.dev catalog.
- Disk-backed SQLite FTS5 lexical index (scales to any repo, kills OOM) plus symbol-aware `grep`.
- Writer sub-agents run in isolated git worktrees (`task({ write: true })`); real Windows AppContainer sandbox helper.
- Microcompact drops stale tool outputs without an LLM call; verifiable browser session-recording + a11y-ref tools.
- Removed the on-device Model2Vec/semantic-embedding lane (−62 MB) and the capability-TRIM stage.

## [13.1.5] (2026-06-12) — Open-weight harness hardening: command sandbox, parallel-research orchestration, Hugging Face, Blueprint-backed grep

- Per-OS write-confining sandbox for `run_command` (macOS Seatbelt, Linux bubblewrap, Windows AppContainer).
- Background sub-agents with wait / work-while-waiting orchestration that folds each result into the turn as it finishes.
- Hugging Face BYOK provider.
- Blueprint is the always-on retrieval substrate behind `grep`; message order preserved after streaming; command/file cards paginate.
- Integration commit "making atlarix a proper harness v1" (tools 38→22, one parallel `task`, background commands).

## [13.0.0] (2026-06-12) — v13 mass simplification (shipped in the 13.1.5 release)

- Tool surface cut opencode-minimal from 38 → 22.
- One `task` tool with up to 5 parallel sub-agents; `plan` collapsed to one tool.
- Removed project templates, the Activity/Agents tabs, the background-agents feature, and ALL LSP (model-facing + editor).
- Background commands (`run_command({ background: true })`) with a visible waiting state and one queued follow-up.
- Tool result cards show the work by default; AGENTS.md/CLAUDE.md interop; a "revert this turn's file changes" checkpoint.

## [12.10.0] (2026-06-09) — streaming-UI crash fixes + runtime Core models + project-check verification

Runtime Core-tier model config via a hosted core-models.json (no repackage), Build/Debug verify with the project's own tooling, and fixes for a plan-panel render loop, vanishing edit cards, and quit-time crashes.

## [12.9.7] (2026-06-09) — ask_user options render correctly + de-hardcoded context-window logic

ask_user option objects render correctly (no more `[object Object]`), proposal token-usage uses the real per-model context window, and stale context-window fallback heuristics were modernized.

## [12.9.6] (2026-06-09) — Terminal actually opens now (correct asar unpack key)

Fixed the packaged Terminal ("posix_spawnp failed") by unpacking node-pty's `spawn-helper` via the correct electron-forge `packagerConfig.asar.unpack` key.

## [12.9.5] (2026-06-09) — Terminal now opens in packaged builds

First attempt to fix the packaged Terminal shell by asarUnpack-ing node-pty's native `spawn-helper` (superseded by 12.9.6's correct key).

## [12.9.0] (2026-06-09) — Fix fatal Terminal crash (removed keytar) + packaged system prompt

Fixed a fatal Terminal crash by replacing keytar with Electron safeStorage, and shipped the full AGENTS system prompt in packaged builds.

## [12.8.0] (2026-06-08) — Stability: graceful token count, delete-session keeps you in the workspace, crash hardening

Graceful token-count for torn-down chats, deleting the active session keeps you in the workspace, and an `uncaughtException` handler prevents fatal native aborts.

## [12.7.0] (2026-06-08) — Tool-schema sanitizer (fixes strict-provider 400s), tidier chat config, quieter Sentry

A tool-schema sanitizer fixes strict-provider 400s, tools with hand-written parameter maps send their real params, and benign empty-output stream errors are dropped from Sentry.

## [12.6.0] (2026-06-08) — Sign-in fix: Google & GitHub buttons everywhere, log out/in from the welcome screen

Restored real "Continue with Google/GitHub" sign-in buttons everywhere and added log out / sign in directly from the welcome screen.

## [12.5.0] (2026-06-08) — Concurrency & stability: run sessions in parallel, never lose work, keep going while the screen sleeps

First tagged release: concurrent session tabs, interrupted-turn recovery with Continue, keep-working-while-the-display-sleeps, and a switch-provider prompt on Core exhaustion.

## [12.0.0] — Unreleased (pending manual test): The engine release — one agent loop, native tool history, verified edits, background agents

The engine release: one unified `runAgentTurn` loop, native tool-call history, in-loop edit verification, per-model capability profiles, portable permissions/hooks, user-defined agents, background agents, and Blueprint v2.

## v11.0.0 work — included in 12.0.0 above (never tagged separately): In-app browser, WebMCP, Atlarix Core, document readers, much lighter app

The v11 batch folded into 12.0.0: an in-app Chromium browser (WebContentsView) the agent can drive, WebMCP page tools, Compass renamed to Atlarix Core (four token-metered models, no tier gating), more document readers, system git instead of bundled dugite, and a much lighter package.

## [10.1.0] (2026-06-04) — Inline streaming indicator, native web search, prompt caching, interactive questions, lighter app

Inline streaming compass indicator, provider-native web search, prompt caching, interactive ask_user question cards, Cmd/Ctrl+P quick-open, and a much lighter app (~28 deps removed).

## [10.0.0] (2026-06-04) — Interactive terminal, live plan progress, per-hunk approvals, memory.md

Interactive PTY terminal, live plan step progress, per-hunk diff accept/reject, `.atlarix/memory.md`, a first-run setup wizard, and content-addressed shadow-git snapshots.

## [9.1.1] (2026-05-29) — Inline chat tools, permissions, build fixes

Inline chat tool cards and diffs via the IPC stream thread, workspace command/file permission stores with a Settings UI, and merge/build regression repairs.

## [9.1.0] (2026-05-28) — Streamline, attachments, LSP

Workspace file/command permissions with approval scopes, post-send attachment chips with persistence, bundled LSP servers, and folder-required GitHub clone.

## [9.0.0] (2026-05-28) — Welcome launcher hotfix

Fixed the renderer `node:path` import on Open-folder and hid panel chrome until a workspace is selected.

## [8.9.0] (2026-05-27) — Workspace-first product & release polish

Workspace-first product: removed global chat/MCP/skills and the Prompt Library, added the welcome launcher, background sessions, and Explore/Review-only sub-agents.

## [8.8.0] (2026-05-26) — Plan artifacts, session titles, folder picker

Plans stored as SQLite artifacts with a plan→building→built lifecycle, AI-generated session titles, and an immediate native folder picker on add-workspace.

## [8.7.5] (2026-05-24) — Polish & UX

Renderer IPC bridge dedupe, packaged-logo asset fix, workspace-delete cleanup, on-demand file-tree loading, and diagram/Mermaid render polish.

## [8.7.4] (2026-05-24) — Packaged ast-grep native binding hotfix

Stopped a post-install prune from stripping `@ast-grep/napi` platform bindings and staged Python/Go grammars via `extraResource`.

## [8.7.3] (2026-05-24) — Packaged Blueprint crash fix & smaller asar

Fixed a packaged Blueprint crash by unpacking ast-grep `parser.so` grammars, and shrank the asar (production source maps and dev deps stripped).

## [8.7.2] (2026-05-24) — Stability & package size

Enforced section-scoped Blueprint (reject workspace-root `focus_path`), added crash diagnostics, and shipped smaller installs via system git and pruned duplicate trees.

## [8.7.0] (2026-05-24) — Section-scoped Blueprint

Section-scoped Blueprint: `get_blueprint` requires a `focus_path` with did-you-mean suggestions, plus a slice layer and a richness-gated hybrid merge.

## [8.6.5] (2026-05-23) — Windows file-discovery path fix

Normalized `fd`/`rg --files` paths to workspace-relative posix so ctags indexing no longer returns 0 symbols on Windows.

## [8.6.4] (2026-05-23) — Windows ctags index fix

Fall back to a recursive scan when discovery returns no paths and normalize ctags `-L` file-list paths to forward slashes.

## [8.6.3] (2026-05-23) — Windows CI ripgrep

Install ripgrep via Chocolatey in Windows CI so blueprint indexing uses `rg --files` instead of the legacy recursive scan.

## [8.6.2] (2026-05-23) — Atlarix Core build embed fix

Fixed Atlarix Core "Not Setup" in release builds by using static `process.env.COMPASS_*` reads so Vite inlines the CI secrets.

## [8.6.1] (2026-05-23) — Packaging & release hotfix

Stopped `packageAfterPrune` from skipping `@ast-grep/napi` platform optionalDependencies (fixed the "Cannot find native binding" startup crash) plus Windows/Discord CI fixes.

## [8.6.0] (2026-05-22) — ctags + ast-grep Blueprint stack

New ctags + ast-grep Blueprint stack: lazy-load generation, route/structural edges, a worker pool, incremental per-file refresh, and blast-radius.

## [8.5.2] (2026-05-21) — Agentic stream completion

The Build loop no longer ends on prose-only replies, completion requires an explicit `<task_complete>`, and the 60s pending-tool stall abort was removed.

## [8.5.1] (2026-05-21) — Hotfix

Removed a stale `useStreamChat` dependency causing a startup ReferenceError and restored long-form `</think>` reasoning dedup.

## [8.5.0] (2026-05-20) — Single ask path, terminals, sessions, packaging

Single `ask_user` question path, a multi-terminal Activity panel with persistence, workspace sessions, and renderer packaging shims.

## [8.4.2] (2026-05-19) — Patch

Renderer Vite shims in progress toward the 8.5.0 packaging fixes.

## [8.4.0] (2026-05-17) — Terminal, CLI, modes, and session fixes

Terminal reliability, an `atlarix` CLI open flow, per-mode system prompts with terminal permissions, PDF attachments, and per-message work mode.

## [8.3.1] (2026-05-17) — Chat config dropdown placement

Chat config/model/work-mode menus open above the composer with Radix collision avoidance so they no longer clip below the viewport.

## [8.3.0] (2026-05-17) — Agent Workstation reframe

Agent Workstation reframe across product copy; removed `git_status`/`git_diff`/`git_log` tools in favor of the terminal, and strip raw `<task_complete>` tags before render.

## [8.2.0] (2026-05-15) — Parser worker pool, WASM tree-sitter, packaging fix

A parser worker pool, WASM tree-sitter for Python/Go/Rust, and an oxc packaging fix that keeps `@oxc-parser` bindings.

## [8.1.1] (2026-05-15) — oxc-parser, repo overview, secret path hardening

oxc-parser for TS/JS/JSX/TSX, a `get_repo_overview` orientation tool, and an extended secret-path denylist with workspace-escape blocking.

## [8.1.0] (2026-05-11) — Pass 6: Blueprint restoration, unified search, streaming, tool merge

Restored the Blueprint lazy-parse graph, a unified `search` tool, throttled/virtualized streaming chat, and consolidated several tools.

## [8.1.0] (2026-05-09) — Pass 7: Blueprint removal + tool consolidation

Intermediate branch (superseded by Pass 6): removed the Blueprint subsystem, consolidated tools ~60→28, MCP on-demand scoping, and migration 0043.

## [8.0.4] (2026-05-07)

Windows/symlink permission-safe file discovery (skip EACCES/EPERM), renderer memory-pressure guards (V8 old-space + serialized scans), and RSS logging.

## [8.0.3] (2026-05-07)

First-class OpenRouter BYOK provider plus Electron packaging robustness (externalized tokenizer/pdfjs, node-pty rebuild, larger Vite heap).

## [8.0.1] (2026-05-07)

Tool Contract Layer, model-triggered `compress_context`, an idempotent stream terminal, macro tools, BYOK error banners, a Skills Marketplace, and heavy context cleanup (~50% lower baseline tokens).

## v7.1.4 — Stepped compaction, exact tokenizer, icon fix (2026-05-06)

Stepped OpenCode-pattern context compaction, exact `@anthropic-ai/tokenizer` token counting, an all-modes `compress_context` tool, and DMG/Windows/Linux installer icon fixes.

## v8.0.0 — Model-driven exploration, LSP diagnostics, OpenCode parity (2026-05-06)

Model-driven workspace-exploration tools, LSP diagnostics injection across 15+ languages with `apply_lsp_fix`, and a lazy 4-strategy file-discovery architecture.

## v7.1.2 — Token efficiency, architecture improvements, terminal enhancements (2026-05-05)

OpenCode-parity cache-aware token management and turn-based compaction, new logging/error/context/plugin services, doom-loop detection, and PTY support.

## v7.1.1 — No-workspace CTA hides after first message in chat-only threads (2026-05-03)

The no-workspace "Open workspace" CTA now hides after the first user message in chat-only threads.

## v7.1.0 — Agent bus oversight, counsel completion-driven flow, diagram polish, first-run UX (2026-05-03)

Agent-bus delegation oversight (cyclic/runaway detection), completion-driven counsel via `Promise.allSettled` with a 7-minute cap, Mermaid prompt rules, and sign-in/onboarding UX polish.

## v7.0.9 — ask_user ordering, quieter IPC logs, stream while question pending (2026-05-01)

Fixed ask_user Q/A bubble ordering, kept assistant continuation streaming while a question is pending, and made IPC success traces opt-in.

## v7.0.8 — Sentry hygiene, bundled TSC worker, clarifying questions (2026-04-30)

Sentry auth-noise hygiene, an external TSC worker that resolves the project's compiler first, and clarifying `<questions>` support across chat-only/ephemeral paths.

## v7.0.7 — Windows release upload URL encoding (2026-04-30)

URL-encode the `name=` param on Windows release-asset uploads so filenames with spaces upload correctly.

## v7.0.6 — New providers, Windows CI, remove Auto button (2026-04-30)

Added NVIDIA NIM, Cohere, Perplexity, and Cerebras providers with model browsing, enabled the Windows CI build, and removed the Auto mode button.

## v7.0.5 — Auto-updater: macOS ZIP feed + Linux deb/rpm update notification (2026-04-27)

Auto-updater support: a macOS stapled-ZIP feed and Linux deb/rpm update notifications (AppImage stays on electron-updater).

## v7.0.4 — Chat config panel never clips + agent cannot read .env* files (2026-04-26)

The chat config dropdown always opens below the trigger without clipping, and `read_file` now blocks `.env*` secret basenames.

## v7.0.3 — Sign-in reliability + clearer dark mode (2026-04-24)

Restored external-browser Supabase OAuth with a 60s timeout/Copy-Link fallback, aligned free-tier copy, and improved dark-mode contrast.

## v7.0.2 — Chat strip labels, counsel/deep-think UX, turn artifacts (2026-04-20)

Provider-agnostic tool/working strip labels from a stable `toolId`, a counsel deep-think substitute for models without native reasoning, and per-message Counsel/agent-bus turn artifacts.

## v7.0.1 — Deep research ledger + web relevance (2026-04-17)

`deep_research` gains a research-ledger agentic loop with semantic stop conditions and tuned web-relevance thresholds.

## v7.0.0 — Atlarix v7 (Project Vanguard) (2026-04-11)

Atlarix v7: skills-driven mode/specialist behavior, a disk-backed task ledger, living plan sync/archive, and a renderer plan viewer built on the Blueprint foundation.

## v6.5.0 — Project Vanguard (2026-04-09)

Living `.atlarix/ATLARIX_PLAN.md` aligned to the task ledger with plan archiving, counsel IPC (start/cancel/update), and audited provider-agnostic task flow.

## v6.2.2 — Tier-aware Compass context + pre-dispatch budgeting (2026-04-09)

Tier-aware Compass context using dynamic OpenRouter `context_length` limits and pre-dispatch budgeting for the Balanced and Thinking tiers.

## v6.2.1 — Autonomous session polish + Thinking UI + snapshot hash path (2026-04-08)

Autonomous Build agent-mesh polish (auto-approve, agent bus, review panel), a Thinking card + activity stream, and a canonical `snapshot_hashes.json` layout.

## v6.2.0 — Unified workspace snapshots + non-destructive revert (2026-04-08)

Unified workspace snapshots with non-destructive revert (`is_reverted` markers), removed the internal diagram git, and Blueprint-canvas performance work.

## v6.1.16 — Diagram stability + Compass context safety (2026-04-08)

Diagram stability (deterministic file-tree layout, history restore), Compass/OpenRouter context safety near the limit, and streaming long-running-command terminal output.

## v6.1.15 — Safety: Compass network noise, SQL guards, prompt hygiene, profanity filter (2026-04-07)

Safety pass: transient Compass network-failure handling, SQL execution guards, entry-point prompt hygiene, and a list-based profanity filter.

## v6.1.14 — Groq external auto-router classifier, balanced baseline, tier floors (2026-04-07)

An external Groq auto-router classifier with a confidence chain, a balanced (never-fast) baseline, and tier floors for main-agent plan/build/debug work.

## v6.1.13 — Linux OAuth fallback, theme toggle, contrast fixes, auto-updater in-app UI (2026-04-05)

Linux OAuth timeout/Copy-Link fallback, a Settings theme toggle, WCAG contrast fixes, an AppImage target, and an in-app auto-updater banner.

## v6.1.12 — Mermaid normalize (diagram page + AI output) (2026-04-04)

Mermaid normalization for the diagram page and AI output (fixes "No diagram type detected") with clean remounts on diagram switch.

## v6.1.1 — Diagram git ignore, blueprint ELK first paint, dev-server preview (2026-04-04)

Diagram-git ignore fix for `userData`/`.cursor`, Blueprint ELK first-paint dedupe, and a dev-server preview URL fallback.

## v6.1.0 — Main `raw-sql` transform, pivot + prompts migrations (2026-04-02)

A Vite `raw-sql` transform plugin for embedded migrations, plus new pivot-tables and prompts-schema Drizzle migrations.

## v6.0.3 — Main Vite `?raw` SQL for embedded migrations (2026-04-02)

Briefly used `assetsInclude` + `?raw` path-checked SQL for embedded migrations (superseded by v6.1.0's transform).

## v6.0.2 — Workforce workspace UI, FallbackModel doGenerate (2026-04-02)

Workforce is treated like Pro for the add-workspace affordance, and `FallbackModel.doGenerate` fixes Auto-wrapped AI diagram generation.

## v6.0.1 — Reasoning stream closure, thinking-tag hygiene, agent docs (2026-04-02)

Reasoning-stream closure on `reasoning-end`, thinking-tag hygiene/dedup, an 8192 max-output-tokens floor, and updated AGENTS prompt bundles.

## v6.0.0 — Workforce session scope, autonomous agents, UX hardening, Thoughts & routing (2026-04-02)

In-memory-per-chat Workforce session scope with a tool gate, auto-executing nested autonomous sub-agents, onboarding/UX hardening, and a Thoughts panel with an async auto-router.

## v5.2.3 — Linux launch, OAuth, and local-model reliability (2026-04-01)

Linux launch reliability (disabled Chromium sandbox, scheme-handler parity), tighter deep-link OAuth handling, and centralized PATH refresh for local models.

## v5.2.2 — Rename reserved `type` columns in SQLite graph tables (2026-04-01)

Renamed reserved `type` columns in the SQLite pivot/diagram tables to `node_type`/`edge_type`/`diagram_type`, fixing packaged-build query crashes.

## v5.2.1 — Supabase OAuth browser-open fallback (2026-03-31)

Wrapped Supabase OAuth `shell.openExternal` in try/catch with a Linux Copy-Link fallback dialog to avoid silent sign-in failure.

## v5.2.0 — Embedded SQLite migrations (2026-03-31)

Replaced filesystem Drizzle migrations with embedded SQL bundled into the main process, with a SHA-256 bridge for legacy `__drizzle_migrations` rows.

## v5.1.5 — Move ensure* safety nets after migrate() (2026-03-31)

Moved all `ensure*` table-bootstrap calls to run after `migrate()` so fresh-DB migrations don't collide with pre-created tables.

## v5.1.4 — SQLite auto-recovery on bad local DB (2026-03-31)

SQLite auto-recovery: verify core tables after `migrate()` and wipe/retry initialization once on a corrupt or partial local DB.

## v5.1.3 — Packaged app: Drizzle migrations path (2026-03-30)

Bundle `drizzle/` via `extraResource` and resolve the migrations folder across candidate paths so packaged builds actually run migrations.

## v5.1.2 — Verified Drizzle journal seed + maintainer docs (2026-03-30)

Seed `__drizzle_migrations` rows only when each journal migration's effects are detectable, preventing partial-schema installs from skipping migrations.

## v5.1.1 — SQLite MCP tables bootstrap (2026-03-30)

Bootstrap the missing `mcp_servers` and `mcp_tool_consents` tables when a seeded journal caused Drizzle to skip migration 0012.

## v5.1.0 – Compass, usage limits, onboarding (2026-03-29)

Introduced the Compass managed cloud provider (OpenRouter-backed) with Supabase monthly token accounting, a usage strip/exhausted state, and post-login onboarding.

## v5.0.0 – Blueprint context & memory (2026-03-26)

Tiered Blueprint prompt injection, project snapshots/memory tables, end-to-end `.atlarixignore`, Ask/Plan/Build/Debug/Review work modes, and Auto routing.

For detailed historical notes (v1.x–v4.x) and implementation phases, see [`docs/previous-versions.md`](previous-versions.md) and the v5.0 tables in [`docs/TODO.md`](TODO.md).

## Atlarix product summary (for model and blueprint accuracy)

Reference: PIVOT (Code↔Canvas via Containers and Beacons), the Blueprint living diagram (RTE + RAG), Ask/Build modes with an approval flow, Research/Architect/Builder/Reviewer agents with Guided/Autonomous delegation, Fast/Balanced/Thinking tiers, and per-provider workspace token budgeting.

## v4.3.0 — UX and workflow update (2026-03-23)

Batch workforce-permissions panel, an Ollama recommender, stricter read-only Ask vs Build separation, and session-persistence/subscription fixes.

## v4.2.0 — Bug fixes and security (2026-03-18)

Bug fixes and security: fully visible onboarding buttons, a simpler more secure sign-in flow, and broad stability/compatibility improvements.

## v4.0.0 — Workforce (2026-03-16)

Workforce tier ($79/mo): teams and seats, MCP-configured integrations with agent auth, Workspace Context, Workforce extensions (Slack/Jira/Linear/Sentry/GitLab/Bitbucket/…), and progressive tool reveal.
