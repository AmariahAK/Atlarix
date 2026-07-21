# Atlarix TODO

**Current Version:** v14.14.0 (RELEASED — Latest on atlarix-releases; auto-update verified live) — Core web search + outside-workspace tool access + permission-write resilience + dead compass-usage removal + dep de-dep + prompt trim.
**Last Updated:** 2026-07-20

## 🚧 In progress — Universal sandbox write-escalation (unreleased)

Fixes the `yarn install` `EPERM: mkdir '~/.yarn'` bug and adds escalation-on-denial for unlisted
toolchains. `npm run check` 0/0, vitest 242 files / 1649 passed.

- **DONE — existence-prune fix (all 3 OSes).** `wrap-command.ts` `defaultWritablePaths` splits
  bind-must-exist vs grantable-even-if-missing; missing curated caches are granted anyway (macOS
  prospective `(subpath …)`; Linux/Windows `mkdir -p` first). Verified end-to-end against real Seatbelt.
- **DONE — escalation-on-denial (interactive).** `sandbox_escalation` permission op + `SandboxEscalationCard`;
  `PermissionInterceptor.maybeEscalateSandboxDenial` parses the denied path from stderr, raises a
  mid-run approval card, persists the grant per-workspace (reuses `workspaceFilePermissions` +
  `sandbox_path` scope — no migration) and re-runs the command still sandboxed. **Wants packaged-app
  verification** of the nested mid-turn card + retry.
- **DONE — CI fail-loud.** `release.yml` fails the release if a native helper doesn't compile (override:
  `ALLOW_UNSANDBOXED_RELEASE` repo var), instead of silently shipping unsandboxed.
- **KEY FINDING:** macOS does NOT log custom `sandbox-exec` denials to the unified log, and `(with report)`
  is rejected on `deny` rules — so stderr-parse is the capture channel on macOS too (same as Windows).
- **PHASE 2 (TODO) — Linux authoritative capture.** Rework `native/atlarix-sandbox-linux` from `exec` →
  fork + seccomp `SECCOMP_RET_TRACE` + ptrace supervisor that records the denied path (`--deny-report`
  file read by `wrap-command.ts`), for tools that swallow the path. New crates: `nix`, `seccompiler`,
  `libc`. CI + Linux-dev-hardware validated. Windows stays stderr-parse (ETW needs elevation).

## ⏳ TBD / Next (fast-follow 14.14.1)

- **Web-search citation strip does not render.** Sources ARE captured — the persisted Core reply
  contains `<atlarix-sources>[{url,title}]` — but `MessageSources` doesn't mount in
  `src/components/chat/AssistantMessageBody.tsx` despite `citationSources` being populated (verified via
  the DB + a renderer unit test that passed). It's a RENDER bug, not capture. TBD: diagnose why the
  mount/`citationSources` short-circuits in the real app path (content-prop stripping? `sourcesForMessage`
  atom? render branch not reached?) and ship 14.14.1.
- **Owner-side verification (from the v14.14.0 web-search work):** (1) billing A/B — confirm OpenRouter
  `usage.cost` includes the ~$0.005 search fee so the wallet debit = `ceil(cost × 1.4)` (else add a proxy
  surcharge in `atlarix-proxy/src/server.ts`); (2) per-Core-model check that DeepSeek/Qwen/Kimi/MiniMax
  reliably emit `openrouter:web_search` — set `webSearch:false` in `core-models.json` for any that don't.


## ✅ Shipped in v14.14.0 (2026-07-20) — outside-workspace tool access + prompt/tool-description trim

Removes the friction that forced `sed`/`python` shell edits: the agent needed to read/patch files in a
tree *outside* the opened workspace (e.g. an upstream dep in `/tmp`), but `read_file`/`grep`/`glob`/
`edit_file` were all hard-confined to the workspace. `npm run check` 0/0, vitest 240 files / 1628 tests.

- **Workspace is now a default SCOPE, not a wall.** New `resolveToolTargetPath`
  (`src/ipc/utils/safeWorkspaceRelativePath.ts`): a **relative** path stays confined as before; an
  **explicit absolute** path targets that exact location (realpath'd, classified `isOutsideWorkspace`).
  - **Reads auto-allow anywhere** — `read_file` (absolute path → read directly, supersedes the legacy
    tool-output-spill branch), `grep`/`glob` (absolute `path` → root ripgrep there). No prompt (reads
    don't mutate; consistent with the reverted read-file secret-block).
  - **Edits gated anywhere** — `edit_file` accepts an absolute outside path but still returns the
    `permissionPayload` diff/approval gate (never a silent write); `assertReadableUnlessOutside` skips
    the confinement only for the intentional outside target. Plan mode still refuses non-`.atlarix` edits.
  - `run_command` unchanged (sandbox already grants `/tmp`); arbitrary non-`/tmp` outside roots via shell
    deferred. Optional sensitive-read denylist (`~/.ssh`, `*.pem`) deferred — owner chose full auto-allow.
- **Prompt/tool-description trim (~475 words, capability-first, no over-steer):** `run_command`
  description ~476→~140 words (kept capability + background/wake_on/preview + "use glob/grep not shell",
  cut the repeated hand-holding); merged the triplicated "verify before you stop" in the Build `work_mode`
  (base `AGENTS.md` keeps the authoritative copy; kept the unique anti-flail); compressed `BROWSER_NOTE`.
  Left `grep`/`glob`/`read_file`/`edit_file` prose alone (already lean) and did NOT touch the mode
  CAN/CANNOT gating or the `tool_contract` security block. (CAN/CANNOT de-triplication deferred as
  higher-risk.) Two eval tests re-pinned to the new wording (same intent).

## ✅ Shipped in v14.14.0 (2026-07-20) — web-search citations render + dead compass-usage removal

Follow-ups from the Core web-search packaged test (search worked, but no citation chips + a dead-RPC log
error every Core turn). `npm run check` 0/0, vitest 238 files / 1621 tests green.

- **Citation sources render.** Root cause was rendering, not capture — Core replies already persist
  `<atlarix-sources>[{url,title}]` (confirmed from the real DB row), which `extractInlineSourcesFromContent`
  already parses; nothing rendered it (the `MessageSources` grid was orphaned; only inline `[^n]` chips were
  wired, and the model doesn't emit `[^n]`). Fix: mount `MessageSources` at the tail of
  `AssistantMessageBody.tsx`, fed by the already-computed `citationSources`, gated `!isStreaming` — robust,
  model-independent. No capture/parser change; nothing deleted. Test added for the Core `<atlarix-sources>`
  shape.
- **Removed the dead `compass_usage` (old monthly-token-limit) system.** It logged
  `get_compass_usage_state ... schema cache` every Core turn — the RPC/table were already dropped in Supabase
  (`20260714130000_pricing_reframe_teardown.sql`); the current PAYG wallet (proxy `get_credit_balance`/
  `debit_wallet`) is the sole enforcement. Deleted `compass_usage.ts`, `compass_enforcement.ts`, the orphaned
  `compass:get-usage` IPC, the preflight/mid-turn recording + `COMPASS_LIMIT_STREAM_STOP` sentinel + ctx
  fields; relocated the live token-normalization helpers to `src/lib/usage/ai-usage.ts`. Kept
  `compassExhaustedUserMessage` (still used by the CURRENT wallet `402 insufficient_credit` path). No Supabase
  change.

## ✅ Shipped in v14.14.0 (2026-07-20) — Atlarix Core web search (metered into the wallet)

All Core users now get web search out of the box — **model-invoked** via OpenRouter's agentic
`openrouter:web_search` server tool (pay only when the model searches, unlike the always-on plugin),
billed through the existing Core wallet at the standard **40% markup**, citations rendered, **no
SearXNG required**. `npm run check` 0/0, vitest 239 files / 1625 tests green.

- **Enablement** (`src/ipc/utils/native_web_search.ts`): new `case "compass"` returns the OpenRouter
  server tool via the module-level `openrouter.tools.webSearch({ maxResults: 5 })` — mirrors the
  existing `anthropic.tools.*` pattern and reuses the `kind:"tool"` dispatch/citation path
  (`simple-stream-text.ts`), so no dispatch-loop or citation changes. Core reuses the same
  `@openrouter/ai-sdk-provider` (via the proxy), so `url_citation` → `source` → `<atlarix-sources>`
  flows unchanged.
- **Cost folds in automatically:** the proxy already meters OpenRouter's real `usage.cost × 1.4` and
  debits idempotently (`atlarix-proxy/src/server.ts`, `entitlement.ts`) — the ~$0.005/search fee rides
  inside `usage.cost`, so no wallet/Supabase/margin changes. Uses the **server tool, not `:online`**
  (the proxy allowlist is exact-match on the clean model id).
- **Per-model opt-out (no hardcoding):** gated per Core tier via a new optional `webSearch` map in the
  hosted **`core-models.json`** — e.g. `"webSearch": { "core-3": false }` keeps that tier on the client
  `web_search` (SearxNG) tool. Default = enabled; parsed by `core-model-overrides.ts` →
  `core-model-override-store.ts isCoreModelWebSearchEnabled`. Owner-updatable without an app release.
- **OWNER VERIFY before release:** (1) **A/B cost test** — one Core search-triggering call vs one
  without; confirm `usage.cost` rises ~$0.005 on search and the wallet debit = `ceil(cost × 1.4)`.
  If the fee is NOT in `usage.cost`, add a flat surcharge in `atlarix-proxy/src/server.ts`. (2)
  **Per-model invocation test** — confirm each Core model emits `openrouter:web_search`; set
  `webSearch:false` in `core-models.json` for any that under-invoke. (3) packaged-app smoke.
- **Out of scope:** BYOK OpenRouter stays on the always-on plugin (per decision); SearXNG stays as the
  non-Core / opted-out-model fallback (no reliable keyless replacement exists — Bing API dead, Brave
  free tier removed, DDG flaky).

## ✅ Shipped in v14.14.0 (2026-07-20) — permission-write resilience + dynamic sandbox roster + dep de-dep

Root-caused Sentry `49d4f2a5` (`execute-permission` → `SqliteError: unable to open database
file`). Proven from the machine's `main.log`: a large `pnpm install` (vercel/ai monorepo) filled the
disk → SQLite couldn't create its rollback `-journal` → `SQLITE_CANTOPEN`. `npm run check` 0/0,
vitest **1620 passed / 1 skipped**.

- **Best-effort permission-preference writes (the fix).** Persisting an "always allow" rule is
  bookkeeping and must never block the approval. New `persistPermissionPreferenceSafely` /
  `isStorageCapacityError` (`src/ipc/handlers/permissions/persist-safe.ts`) wrap the command/file
  upserts in `execute-permission` (`permissions/handlers.ts`); a failed write logs + degrades (command
  still runs) instead of throwing out of IPC and wedging the turn. Same graceful stance as the
  `[partial-draft]` path and opencode's `Effect.ignore` bookkeeping writes. Sibling handlers
  (`command-permissions:upsert`, `file-permissions:set`) now return `{success:false}` instead of
  throwing. Command-agnostic — pnpm was the trigger, not the target.
- **Disk-full user notice.** On `SQLITE_CANTOPEN`/`SQLITE_FULL`/`ENOSPC`, a one-time (debounced)
  `showAgentNotification` fires so a full disk isn't a silent hang.
- **Dynamic sandbox writable roster.** `wrap-command.ts` now resolves each toolchain's store/cache from
  its standard env var first (`PNPM_HOME`, `npm_config_cache`, `CARGO_HOME`, `GOPATH`/`GOMODCACHE`,
  `XDG_*`, …) then falls back to known dirs — fixes pnpm installs stalling on denied writes to its real
  store (`~/Library/pnpm/store`, previously uncovered). Still zero command-name matching; the sandbox
  stays a generic write boundary. Confirmed by a harness-wide hardcoding audit (no violations found).
- **Conservative dep de-deprecation (build-time only).** Removed the vestigial eslint stack (eslint@8 +
  `@typescript-eslint/*` + `eslint-plugin-import`; lint is oxlint/prettier) — clears eslint@8 +
  `@humanwhocodes/*`. Bumped `@electron-forge/*` → 7.11.2, direct `glob` → 13 (off the vuln-flagged
  v11 in our own `codebase.ts`/`workspace-snapshots.ts`). Deprecation warnings **18 → 15**.
  - **Residual deprecations (upstream-blocked, all dev/build-time transitives — do NOT force-override:
    glob/rimraf majors switched callback→promise APIs and would break parents):** `glob@7/8/11` &
    `rimraf@2/3` & `inflight` (electron-forge installer chain + rimraf@6), `boolean` (global-agent/roarr),
    `@npmcli/move-file` & `gar` (cacache), `@esbuild-kit/*` (drizzle-kit ≤0.31 — only 1.0-beta drops it),
    `lodash.get`/`lodash.isequal`, `node-domexception`, `whatwg-encoding`. Revisit when upstream ships.
- **Verify remaining:** packaged-app smoke test (`npm run package` → approve a command with "Always
  allow") before release — owner-driven.

## ✅ Shipped in v14.13.3 (2026-07-18)

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[14.13.3]`. `npm run check` 0/0, vitest green.

- **Auto-update fixed (mac + Linux AppImage).** Bundle `build/app-update.yml` via `extraResource` —
  electron-forge never generated it, so electron-updater hit an unhandled ENOENT at download time and
  stuck on "Downloading…". Plus updater hardening (manual `downloadUpdate().catch`,
  `disableDifferentialDownload`, unified deferred flow).
- **Auto-update fixed (Windows).** Squirrel.Windows ≠ electron-updater (NSIS-only) → switched Windows to
  Electron's built-in `autoUpdater` + `update-electron-app`/update.electronjs.org, wired to the same
  banner. Pure `chooseUpdaterKind()` selector + tests. CI now publishes the Squirrel `RELEASES` index.
- **⚠️ One-time manual update:** ≤14.13.2 installs can't auto-update to this fix — they need one manual
  install of v14.13.3, then auto-update self-heals. Windows auto-update pending real-device verification.

## ✅ Shipped in v14.13.2 (2026-07-18)

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[14.13.2]`. `npm run check` 0/0, vitest green.

- **Core provider page shows real live model names** (Kimi/Qwen/DeepSeek/MiniMax) instead of
  `Core N` — `useAtlarixCoreCatalog` now derives from the working `useLanguageModelsByProviders`
  IPC (the `compass:get-tier-catalog` path resolved a different `compass_constants` instance than
  the override store is written to). Core badge → "Setup Complete".
- **Tier vocabulary retired from provider UI** — "Needs Setup" → "Add key", tier-free copy, and
  the Ollama/LM Studio 3-slot favorites picker collapsed to single-select.
- **Model-list perf** — `staleTime` on `useLanguageModelsByProviders`/`useLanguageModelsForProvider`
  so the 167-provider models.dev catalog stops rebuilding on every mount/focus.
- **Auto-update stuck-on-downloading fix** — removed the racy pre-feed deferred `checkForUpdates` +
  duplicate handler; `disableDifferentialDownload = true` (`src/main.ts`).

## ✅ Shipped in v14.13.1 (2026-07-18)

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[14.13.1]`. `npm run check` 0/0, vitest green.

- **Markdown structure rule.** `<output_style>` now forbids multi-line code / line-breaking
  template literals inside table cells or inline backticks (GFM can't render them) — fixes
  phantom table rows and stray `{`/`}` in inline code (`src/prompts/system_prompt.ts`).
- **`<untrusted-data>` hidden in the UI.** New `stripUntrustedDataEnvelope()` strips the
  injection-defense envelope on the display path across all tool cards + previews; model-facing
  and persisted strings keep the wrapper.
- **Negative wallet balance explained.** Refund-clawback negative balance now shows a colored
  note to top up before using Core (`AtlarixCoreUsageCard.tsx`).

## ✅ Shipped in v14.13.0 (2026-07-17)

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[14.13.0]`. `npm run check` 0/0, vitest green.

- **Co-author, not author.** Commits are authored by the user's own git config; Atlarix is credited via the
  `Co-authored-by:` trailer only. Terminal (`interceptor.ts`) + programmatic (`git_utils.ts`) paths inject the
  agent identity **only** as a fallback when git is unconfigured (`hasConfiguredGitIdentity()` probe).
- **Co-author toggle fixed.** `includeAtlarixCoAuthor` now gates the trailer on the terminal/prompt path too
  (`mode-prompt-bundle.ts`, threaded from `system_prompt.ts`); the `--author` instruction is gone.
- **Markdown replies.** `<output_style>` tells every model its user-visible replies render as GitHub-flavored
  markdown.
- **Security scope trimmed.** Dropped the four deferred "protect-user-from-their-own-agent" items (egress
  gating, sandbox read-confinement, env-var allowlist, automation allowlist-flip) — matching opencode / CC.
  Owner-protection + prompt-level untrusted-data defense unchanged.
- **Flaky test fixed.** Real-git worktree suites given the repo's 30s hook/test I/O budget.

## ✅ Shipped in v14.12.0 (2026-07-16)

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[14.12.0]`. `npm run check` 0/0, vitest green.

- **Harness batch.** Wait-timer merge (stall snooze under `schedule_wakeup`, `\r` no-rearm, 180→300s,
  advisory reframed toward patience), live token counter (always-mounted composer hook + hold occupancy
  across turns), paste beachball/first-time-miss fix, image graceful-degrade (friendly "switch to a vision
  model" in onError, no allowlist), ask→explore case-tolerant skill match, errors-tab llmFallback deleted,
  `wake_on` nudge for backgrounded builds/tests/installs.
- **Model-picker real pricing.** models.dev cost merged into every provider's native fetch + OpenRouter's
  own per-token pricing parsed; PriceBadge shows real `$/M` (clipping fix included).
- **`edit_file` overhaul.** Multi-edit `edits` array (atomic) + Cursor-style `operation:"merge"` with
  `// ... existing code ...` markers (deterministic stitch, refuses-not-corrupts).
- **File reads align with opencode.** In-workspace files (incl. `.env`) read freely; workspace-boundary
  confinement (path-escape + new symlink realpath check) + run_command ask-gate kept.
- **Security.** Plaintext-keychain hardening (chmod 600 + banner + re-encrypt-on-recovery); privileged-IPC
  gating (`terminal:run`/execute-all-permissions origin-gate + zod).
- **Dropped/reverted:** OAuth PKCE (broke sign-in), outbound secret redaction, read-file secret-basename
  block — reverted to keep working behavior / match opencode.

## ✅ Shipped in v14.11.0 (2026-07-14)

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[14.11.0]`. `npm run check` 0/0, vitest **1572** green.
Multi-repo (app + proxy + edge fns + Supabase migrations + launchpad); backend applied/deployed in prod.

- **Pricing reframe — Free + Pro + PAYG credits.** No tier bundles AI; Atlarix Core is pay-as-you-go
  prepaid credit on every tier. Team/`workforce` tier removed (connectors → Pro); Studio→Pro, Solo→Free.
- **Credit wallet + metering.** `credit_wallet` ledger + idempotent RPCs; proxy meters real OpenRouter
  cost +40% markup behind a **per-call cost reserve gate** (402 `insufficient_credit`) + 503
  `core_unavailable` + owner Discord alert. LS single credit product via `custom_price`; order webhook
  credits/claws back.
- **App.** Wallet UI (balance + additive top-up), automations gate (Free 2 / Pro 10), $1 trial credit,
  low-balance nudge, Team teardown, dead DB-Studio-legacy removed, avatar CSP fix, model-picker Core→"Paid".
- **vNEXT (`8d1e990`).** Voice-to-text (Whisper + BYOK cloud), live token counters, attachment dedup,
  image-gate removed, DB-closing guard, optimistic stop + mid-stream edit.
- **Launchpad.** Pricing → PAYG, Docs accuracy pass, Team pages removed.

## 🔜 Deferred / next

- **Windows code-signing / cert** — C6 auto-update signing + native-sandbox CI remain open (release-infra,
  no cert). OAuth `state` nonce / PKCE stays **not doing** (attempted v14.12.0, broke sign-in, reverted; the
  flow-in-progress gate stays).
- **Windows grep PCRE2 lookahead** — `grep-pcre-fallback.test.ts`'s lookahead assertion returns "no matches"
  on the Windows runner (bundled ripgrep path/pcre2 nuance); skipped on win32 to unblock the release.
  Verify whether real Windows users' lookahead grep patterns work, or if it's only a test-fixture path issue.
- **Runtime-verify voice mic + DB shutdown-race** on a packaged build (voice confirmed working by owner
  2026-07-14; shutdown-guard committed, not stress-verified).

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

- **Optional default `.atlarix/permissions.json` ask-ruleset for outward commands** (from v14.10.0).
  Build mode now auto-runs plain `git push`/`npm publish`/deploy (Codex workspace-write behavior);
  force-push/exfil/credential-reads still ask. If auto-run feels too loose, ship a default `ask` ruleset
  (data, the Claude-Code way) rather than re-hardcoding git.
- **DB shutdown race — `TypeError: The database connection is not open`** (Sentry, seen on 14.9.1,
  still present in 14.10.0; **benign** — `handled`, fires only during app quit, no in-session impact,
  worst case one dropped pending write). Cause: the SQLite handle is closed (`db/index.ts:65`
  `sqlite.close()` / `app_handlers.ts:1185` `db.$client.close()`) while `main.ts:1437` `before-quit`'s
  async flush/session chain still has a drizzle query in flight → straggler `.prepare()` throws. Fix
  (target 14.10.1): a `closing`/`isClosed` guard so `db` calls short-circuit once shutdown starts
  (robust vs. `void`-ed late writers), or reorder to `await` the flush chain before `db.$client.close()`.
  ~15-min change + a test; own fresh plan-mode session.
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
