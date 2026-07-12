# Atlarix TODO

**Current Version:** v14.10.0 (RELEASED — Latest on atlarix-releases) — command permissions rebuilt + accuracy skills + streaming/UI overhaul over v14.9.1
**Last Updated:** 2026-07-12

## ✅ Shipped in v14.10.0 (2026-07-12)

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[14.10.0]`. Net **−362 lines**;
`npm run check` 0/0, vitest 1566 green, knip clean, packaged self-test 4/4. Owner-smoke-tested.

- **Command permissions rebuilt on the Codex sandbox + Claude Code ask model.** Deleted the hardcoded
  read/mutate/git command taxonomies that false-blocked valid commands (`git fetch`, `docker build`)
  in read-only modes. Enforcement = OS sandbox (read-only profile for Explore/Plan/Review; workspace-write
  for Build/Debug; native helpers gained `--read-only`); commands auto-run, only the danger gate +
  `.atlarix/permissions.json` rules prompt. CPU-throttle experiment stripped.
- **Accuracy prompt-skills** (`mode-prompt-bundle.ts`) — red-green ("a test must be red against the
  un-fixed code before it's trusted green"), test-connection ("assert the real code path, not a mock of
  the unit under test"), anti-flail ("switch verification approach after ~2–3 repeats"), reuse-before-build.
- **UI heat + streaming/virtualization overhaul** — react-virtuoso message virtualization (default-on,
  kill-switch), adaptive flush cadence, tail-bounded markdown re-parse, atom-fanout narrowing, one-time
  stale-index cleanup (~1.4 GB), grep/glob search labels. Calm/cool main process on large repos + long streams.
- **Fixes:** reconnect no longer shows a fake "user said continue" turn (out-of-band `<system-reminder>`
  continuation via new `continueInterrupted` flag); "Jump to latest" lands at the live generating edge
  (`align:"end"`). Dead task-ledger/completion-detector code removed.

## ✅ Recent shipped (detail in [`docs/CHANGELOG.md`](./CHANGELOG.md))

- **v14.9.1 (2026-07-10)** — bundled ripgrep via `@vscode/ripgrep` so `grep`/`glob` no longer need `rg`
  on PATH.
- **v14.9.0 (2026-07-10)** — retrieval teardown (fd-leak + heat root cause; −5,246 lines), opencode-parity
  multi-provider (full models.dev catalog), per-sub-agent token badge. **Post-release owner actions
  (done):** rotated OpenRouter master + app Supabase service-role keys; cleaned GH Actions vars.

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

- **Stale removed-tool references in the prompt (from v14.10.0).** `system_prompt.ts:290` +
  `workspace-capabilities.ts:85` still tell the model to call `get_active_skills` /
  `list_installed_skills`, which were deleted. 2-line fix (drop or repoint the guidance); the
  Visual Artifacts guide is still injected always-on so no capability is lost.
- **Optional default `.atlarix/permissions.json` ask-ruleset for outward commands** (from v14.10.0).
  Build mode now auto-runs plain `git push`/`npm publish`/deploy (Codex workspace-write behavior);
  force-push/exfil/credential-reads still ask. If auto-run feels too loose, ship a default `ask` ruleset
  (data, the Claude-Code way) rather than re-hardcoding git.
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
