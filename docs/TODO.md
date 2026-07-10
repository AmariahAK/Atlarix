# Atlarix TODO

**Current Version:** v14.8.16 (RELEASED — Latest on atlarix-releases) — hotfix over v14.8.15 (CI proxy-url wiring)
**Last Updated:** 2026-07-10

## 🔥 Open — TOP PRIORITY (next session)

- **[HIGH] Retrieval simplification — kills the fd leak + high-CPU/heat (ROOT CAUSE CONFIRMED 2026-07-10).**
  **Diagnosis (from live logs/lsof/sample on the packaged 14.8.16 over big repos jenkins/moby/traefik):**
  the `search-index-watcher` uses **chokidar 4 (dropped fsevents) → Node `fs.watch` → macOS kqueue,
  which opens ONE fd per watched file**. On the 12,365-file Jenkins repo that's **12,365 open REG fds**
  → process hits its fd budget → **`spawn EBADF` on every child process** (`run_command`, sub-agent
  shells, ripgrep — file reads survive since they don't spawn). Same root drives the heat (CPU sample
  under load dominated by `read()` + FTS5 sqlite). **NOT the security release** (only 1 socket open).
  The v14.8.14 `@parcel/watcher`→chokidar swap (to fix Windows compile) reintroduced it as a macOS
  kqueue/fd blowup. **Agreed plan (see this session's research):**
  (1) **Remove the chokidar filesystem watcher** entirely (`search-index-watcher.ts` + its
  `ensureSearchIndexWatcher` registration in `chat_stream_handlers.ts:1180` + `stopSearchIndexWatcher`).
  (2) **Keep `symbols.json`** (ctags cache in `userData/ctags-index/`; saves the ~3s cold-start ctags run).
  (3) **Incremental freshness goes INTERNAL** — instead of watching the OS, hook `updateSymbolIndexForFile`
  to Atlarix's OWN edit events (`edit_file`/`write`/git mutations): the app already knows what it changed,
  so re-index just those files (same cheap single-file ctags update, ZERO fs-watch, zero fd leak).
  (4) **Keep the lazy staleness check** (`ensureSymbolIndex` git-HEAD + mtimes) — catches external/IDE edits on next grep.
  (5) **Remove FTS5 + SQLite** — the rerank is candidate-set (`restrictToFiles` = grep hits only), and the
  ctags symbols are ALREADY in memory (`memoryByPath`), so replace `searchBlueprintBm25`/FTS5 with an
  **in-memory BM25 over the candidate files' symbols** (optionally a small global term→docfreq map to keep
  FTS5-equal IDF). FTS5's disk index only existed to avoid whole-repo in-memory OOM — moot once reranking
  is candidate-set. Zero-hit "closest symbol" suggestion → drop or light in-memory name-match.
  **Keep ctags** (powers symbols + `findEnclosingSymbol` annotations + blast-radius). Net end state:
  `ripgrep` → on-demand ctags (symbols.json, refreshed by internal edit-hook + lazy staleness) →
  in-memory candidate BM25 rerank. No chokidar, no FTS5/SQLite, no fd leak, no heat. Optional first step:
  benchmark in-memory candidate BM25 vs FTS5 ranking on jenkins/moby to prove parity before deleting FTS5.
- **C-1 secrets — RESOLVED in v14.8.15.** `COMPASS_OPENROUTER_API_KEY` / `LEMONSQUEEZY_API_KEY` /
  `LEMONSQUEEZY_WEBHOOK_SECRET` / `RESEND_API_KEY` removed from `MAIN_KEYS`; Core routes through the
  new `atlarix-proxy`, and checkout/cancel/email moved to Supabase edge functions. Client now ships
  **zero server secrets**. Remaining owner action: rotate the OpenRouter master key (Railway) + the
  app Supabase service-role key (both were in prior shipped builds). See `docs/SUPABASE_SECURITY_AUDIT.md`.
- **Deferred perf follow-ups:** fts5 handle eviction shipped; renderer virtualization deferred
  (measure-first — see the heat item). Full `@parcel/watcher` Win/Linux packaged smoke-test.

## 🔐 Security follow-ups (from `docs/SECURITY_REVIEW_v14.8.12.md`, owner-triaged)

Fixed by v14.8.13: compound-command danger gate, exfil taxonomy, deep-link auth-CSRF +
pro-return confirmation, MCP consent gate, `.atlarix` authority-file approval, MCP
description wrapping + OAuth-URL validation, the **universal write-confining sandbox**
(Win AppContainer + Linux Landlock bundled), and the **system-scope approval gate** (which
also closed M1 — cwd `allowedRoots` widening is now gated on interactive approval).
**Deferred (tracked):**

- **C6 — auto-update signature verification (Windows/Linux).** Highest blast radius, but
  release-infra (code-signing certs + `app-update.yml` for NsisUpdater; out-of-band
  signature for AppImage), not app code. Owner chose NOT to gate the public release on it.
  (Windows helper sign step is already wired — set the cert secret to enable.)
- **Native sandbox validation in CI.** The Windows/Linux helpers can't compile on macOS; they
  build (non-blocking) in the first Windows/Linux CI job — watch those `cargo build` steps and
  budget one small fix-up iteration if the Linux `landlock` 0.4 API drifted.
- **Unattended read-only allowlist-flip** (positive allowlist for Automation runs) — the
  denylist taxonomy is done; the flip needs per-automation design to not break legit builds/tests.
- **Round-tripped auth `state` nonce** — needs confirming the Supabase redirect-URL
  allowlist permits a query param (current gate = flow-must-be-in-progress).
- **XSS-gated privileged IPC** (`terminal:run`, `mcp:create-server`, `execute-all-permissions`)
  + preload arg-validation — safe today (markdown rendering is XSS-free); structural pass.
- Sandbox **read**-confinement, model-context **secret redaction**, **egress** gating, and the
  remaining Medium items (env-var key inheritance, secret-basename list, cross-workspace file
  scope, plaintext-keychain fallback).

## ✅ Shipped in v14.8.13 (2026-07-07)

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[14.8.13]`.

- **Universal sandbox + system-scope gate + done-responding notification (2026-07-07).** Bundled
  Windows AppContainer + Linux Landlock write-confining helpers (macOS Seatbelt already built-in;
  non-blocking CI, sign-ready); the system-scope approval gate (distinct "System change" prompt,
  runs approved installs unsandboxed, closes M1); the OS notification now also fires when a turn
  finishes responding (unfocused). Native helpers validate in Windows/Linux CI.
- **Harness + security + feature pass (2026-07-07).** Shift+Tab global, streaming scroll-lock,
  attachment vision cold-cache, indefinite MCP auth waits, terminal mode-block message; the
  security fixes above; notification sound (+ unfocused OS notification); prompt refinement
  (harvest + Debug reasoning_extraction reframe + read-only branch-nav). B4 (bg-command "done"
  while running) confirmed a model-behavior quirk — harness re-injects the exit result via
  auto-wake; mitigated by the prompt lines.

- **Native-git reads + Code-tab removal + universal language (2026-07-06).** Local git ops are
  native-git-only (production Sentry `null.slice` fix; `enableNativeGit` deleted); Code tab + Monaco +
  QuickFileOpen deleted; ctags allowlist → auto-detect + 2 MB guard (ctags-only blueprint, no null
  cliff); ast-grep / blast-radius / dead-blueprint-chain pruned (−7851 lines, watcher →
  `search-index-watcher.ts`). vitest 1578.
- **Automations SHIPPED (2026-07-06).** Migration 0066; cron (node-cron) + GitHub-poll + MCP-poll
  triggers (deterministic, no LLM in loops); unattended runs via the headless spine (dangerous always
  denied, 10-min budget, concurrency 1); read-only default + opt-in worktree-write proposals; triage
  feed tab. vitest 1600.
- **`chat_stream_handlers.ts` decomposition COMPLETE (2026-07-07).** God-file **7984 → 2364 lines
  (−70%)**; `runStream` is now a thin orchestrator over 8 `chat_stream/turn-runner/*.ts` modules
  (simple-stream-text, round-retry, response-chunk-update, context-assembly, ask-branch, build-branch,
  finalize, prompt-bundle). Every extraction body-verbatim + separately gated (ts + oxlint +
  per-project agent-evals 73 / node 1484 / renderer 58). **Smoke focus:** the context-overflow →
  `handleTurnError` rerun recursion path is NOT eval-covered — force a mid-turn overflow-compaction retry.

---

## Open follow-ups

- **DONE in v14.8.12:** approval-wait audit (MCP auth waits now indefinite + Stop-cancellable),
  Shift+Tab global, attachment vision cold-cache, notification sound. **B4 (bg-command "done" while
  running)** resolved as model behavior — the harness DOES re-inject the exit result via auto-wake
  (`recordBackgroundCommandResult`); mitigated by the new prompt lines (ground-claims / finish-the-turn).
- **CONSIDER (evaluated → CLOSED): `browser-use`.** Not adopted — Python/Playwright (bad Electron fit),
  it's its own agent loop, and its one good idea (stable element refs) Atlarix already has via
  `browser_inspect` snapshot `ref`s. No capability gap. [[atlarix-preview-webcontentsview]]
- Small / carried: `.gitignore`-render profiler (v14.8.10 §3.4); Atlarix GitHub account for contributor
  credit (owner action; code done); user-message multimodal parts for HISTORICAL turns (current/edited
  turns embed since v14.8.11; history round-trips via read_attachment).
- **Dependency deprecation triage (own session).** Scoped, not a blanket "zero warnings" chase
  (@ai-sdk/anthropic MUST stay 2.x w/ ai@5 [[atlarix-ai-sdk-version-trap]]; zod mid-v4; 3 patch-package
  patches; ABI-pinned better-sqlite3/node-pty/keytar). Worklist = `npm outdated` (direct) + `npm audit`
  + own deprecated-API usage + CI action EOLs; leave pinned/transitive with a note.

## 🔭 Long-term / far-off (not soon)

- **Collaborative agent (the "team + @atlarix" direction).** NOT a Slack/Discord clone — real-time
  chat + calls is a money pit and teams already have those. Two pieces instead: (a) **`@atlarix`
  bots inside the tools teams already use** — Slack / Discord / GitHub issues — extending the existing
  `@atlarix review` GitHub bot: mention it, it picks up the task, works in a real Atlarix workspace,
  and posts the PR/result back (near-zero switching cost, big reach; how Devin / Copilot-in-Slack win).
  (b) A **shared, observable agent session** — a "war room" where several teammates watch one Atlarix
  run live, drop steering comments, approve actions, and hand off — tied to the Workforce tier. The
  chat shell is not the differentiator; the shared *agent* session is. Far-off; capture, don't build yet.

> Open work + the current release only. **Full shipped-version history lives in
> [`docs/CHANGELOG.md`](./CHANGELOG.md)** (and `docs/CHANGELOG_PREVIOUS.md`).
