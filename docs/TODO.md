# Atlarix TODO

**Current Version:** v14.8.16 (releasing — on main + tagged) — hotfix over v14.8.15 (CI proxy-url wiring)
**Last Updated:** 2026-07-10

## 🔥 Open — TOP PRIORITY (next session)

- **[HIGH] Sustained high CPU → device heat (fast).** Persists AFTER the v14.8.14 watcher +
  index fixes, so the `@parcel/watcher` swap helped but a hog remains. It's CPU, not memory
  (quit RSS ~200 MB, no leak). **Method:** packaged app on a big repo (`vscode`), drive a chatty
  `run_command` + a first `grep`; in Activity Monitor find the hot process (main `atlarix` vs a
  renderer Helper vs GPU) and take a CPU `sample <pid>`. **Ranked suspects:** (1) **terminal-output
  streaming firehose** — `chat_stream_handlers` `[Build Mode] Terminal output sent … (running)`
  logs + IPCs + re-renders EVERY output chunk (760 log lines in one session); a command with
  continuous output (dev server / build / watch) → sustained main+renderer CPU → **fix: throttle/
  coalesce terminal-output IPC + drop the per-chunk `(running)` log.** (2) ctags/FTS5 index build
  CPU on huge repos (ctags subprocess over the whole code tree). (3) `@parcel/watcher` initial
  crawl on very large code trees. (4) renderer re-render if the Helper is the hot process → wire
  the already-installed `@tanstack/react-virtual`.
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
