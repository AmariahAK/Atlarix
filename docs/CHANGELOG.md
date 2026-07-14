# Atlarix Changelog

> Entries are condensed to the shipped changes per version. Full prose, rationale, and
> file-level detail live in the git history.

## [14.11.0] (2026-07-14) — Pricing reframe: Free + Pro + PAYG credits

`npm run check` 0/0, vitest **1572** green. Multi-repo refactor (app + proxy + edge functions +
Supabase migrations + launchpad). Backend migrations applied to prod; proxy + edge functions deployed.

### Changed
- **Pricing reframe — no tier bundles AI.** Atlarix is a harness, not an AI provider: **Atlarix Core is
  pay-as-you-go prepaid credit on every tier**. The **Team/`workforce` tier is removed** (its one-click
  OAuth connectors fold into Pro); "Studio"→"Pro", "Solo"→"Free". Free = full harness on BYOK/local +
  bounded scale (1 workspace, 1 MCP/ws, 2 automations); Pro ($19/mo) = unlimited workspaces, 10 MCP/ws,
  10 automations, marketplace + connectors.
- **Metering → credit wallet.** The monthly token *allowance* (`compass_tokens`) is replaced by a dollar
  *balance* (`credit_wallet` + append-only `credit_transactions`, idempotent SECURITY DEFINER RPCs). The
  proxy meters the **real OpenRouter cost + 40% markup**, and **gates each call on a per-call cost
  reserve** (est input + max output × price × markup) — a user always affords the call they start; it
  never aborts mid-stream. Two exhaustion cases split cleanly: user out of credit → **402
  `insufficient_credit`** (top-up message); managed key fails → **503 `core_unavailable`** + neutral
  "overloaded" message + owner Discord alert (`CORE_ALERT_WEBHOOK_URL`).

### Added
- **PAYG wallet UI** — credit balance + **additive top-up tally** ($10/$20/$50/custom, running total +
  reset + confirm, $10 min) via a single LemonSqueezy "Atlarix Core Credit" product with per-checkout
  `custom_price`; `order_created`/`order_refunded` webhook credits/claws back. Balance shown in the token
  bar and account menu.
- **Automations gate** (net-new): Free 2 / Pro 10 per workspace. **One-time $1 signup trial credit**
  (`claim_signup_credit`, fired on sign-in). **Low-balance nudge** (one-time toast under $1).
- **vNEXT (commit `8d1e990`).** Voice-to-text (on-device Whisper + BYOK cloud), live provider-usage token
  counters (main + per-sub-agent), unified content-hash attachment dedup, image-gate removed (user images
  → any model), DB-closing guard, optimistic stop + mid-stream edit.

### Fixed
- OAuth **avatar CSP** (GitHub/Google profile pictures were blocked → placeholder).
- Model picker labels Atlarix Core as **"Paid"** (was "Free").
- Wallet RPC idempotency index (`ON CONFLICT (kind, ref)` needs a non-partial unique index — the partial
  index silently failed every wallet write, incl. debits).
- Two chat nits: empty state reads "What are we building?"; the duplicate New-chat header removed.

### Removed
- Team/`workforce` tier surface (team-service, team handlers, invite banner, upgrade-choice dialog,
  workforce checkout/IPC). Dead **DB-Studio-legacy** plumbing. Launchpad Team pages + stale allowance/
  Blueprint docs claims.

### Migrations (Supabase `oubgrpkqyyjwytspycpd`, applied to prod)
- `20260714120000_credit_wallet` (wallet + RPCs) · `20260714140000_fix_credit_conflict_index` (index fix)
  · `20260714130000_pricing_reframe_teardown` (drop teams + compass allowance, tiers → `free|pro`, rewrite
  the users guard trigger).

## [14.10.0] (2026-07-12) — Command permissions rebuilt + accuracy skills + streaming/UI overhaul

Net **−362 lines**; `npm run check` 0/0, vitest 1566 green, knip clean, packaged self-test 4/4.

### Changed
- **Command permissions rebuilt on the Codex sandbox + Claude Code ask model.** Deleted the
  hardcoded read/mutate/git command taxonomies (`command-mutation.ts`, `command-default-allow.ts`,
  `git-init-command-guard.ts`) that false-blocked valid commands (`git fetch`, `docker build`) in
  read-only modes. Enforcement is now the OS sandbox: Explore/Plan/Review get a **read-only**
  profile (workspace source not writable), Build/Debug keep workspace-write (`work-mode.ts`,
  `sandbox/wrap-command.ts`, native `atlarix-sandbox`/`atlarix-sandbox-linux` gained `--read-only`).
  Commands **auto-run** in the sandbox; only the danger gate (`dangerous-commands.ts`) and user
  `.atlarix/permissions.json` rules prompt. The CPU-throttle experiment was fully stripped.
- **Accuracy prompt-skills** (`lib/tools/mode-prompt-bundle.ts`) — Build/Debug now require a test
  to be **red against the un-fixed code before it's trusted green** (kills tests that pass without
  exercising the code), to **assert on the real code path not a mock of the unit under test**, to
  **switch verification approach after ~2–3 repeats** instead of flailing, and to **reuse existing
  utils/deps before writing new code**.
- **Dead-code removal** — trimmed the orphaned task-ledger/plan-step helpers and deleted
  `completion-detector.ts`.

### Fixed
- **UI heat + streaming render overhaul** — react-virtuoso message virtualization (default-on,
  kill-switch), adaptive flush cadence, tail-bounded markdown re-parse, atom-fanout narrowing,
  one-time stale-index cleanup (`main/startup/cleanup-legacy-index-dirs.ts`), and a grep/glob
  search label. Keeps the main process calm and cool on large repos and during long streams.
- **Reconnect no longer shows a fake "user said continue" turn.** Resuming an interrupted turn
  (`SimpleInlineChat` continue) now sends an out-of-band `<system-reminder>` continuation
  (`buildInterruptedContinuePrompt` in `lib/chat/stream-transport.ts`, threaded via a new
  `continueInterrupted` flag) instead of a persisted user message.
- **"Jump to latest" lands at the live generating edge** — `VirtualizedMessageList` scrolls with
  `align:"end"` so a tall streaming message pins to the bottom, not its top (mid-screen).

## [14.9.1] (2026-07-10) — Bundle ripgrep (self-contained grep/glob)

### Fixed
- **`grep`/`glob` no longer depend on the user having `rg` on their PATH.** They
  now use a bundled ripgrep binary via `@vscode/ripgrep` (the same package VS
  Code / Claude Code ship), resolved through `lib/tools/resolve-ripgrep.ts` with
  a PATH fallback. The binary ships unpacked from the asar
  (`@vscode/ripgrep-<platform>-<arch>/bin/rg`, forge `asar.unpack`); the packaged
  `--self-test` confirms it resolves the bundled binary, not PATH. Also installs
  ripgrep in the CI quality/linux jobs (belt-and-suspenders) and removes a stale
  `chokidar` entry from the Vite main externals so it isn't re-installed into the
  package.

## [14.9.0] (2026-07-10) — Lightweight retrieval teardown + opencode-parity providers

The harness gets dramatically lighter and cooler on large repos, and gains full
multi-provider parity. Net **−5,246 lines**; vitest 1621 green, oxlint 0, ts/knip clean,
packaged self-test 4/4.

### Fixed
- **fd-leak + high CPU/heat on large repos (root cause).** The `search-index-watcher`
  (chokidar 4) on macOS used `fs.watch`/kqueue = **one open fd per watched file** → ~12,365
  fds on a Jenkins-scale repo → `spawn EBADF` on every child process, plus sustained heat
  from FTS5 rebuilds reading every file. The entire watcher + index apparatus is deleted;
  the main process now stays calm and fd count stays flat (~113) under real load.

### Changed
- **Retrieval collapsed to pure ripgrep** — same shape as Claude Code / opencode / codex.
  Deleted `search-index-watcher` (chokidar), FTS5/SQLite/BM25 (`fts5-index`, `fts5-core`,
  `bm25_semantic_index`, `retrieval-common`, `package-boundaries`), the grep reranker
  (`grep-blueprint-reranker`), ctags/symbols (`lib/index/*`), and the dead
  `lib/analysis/*` workspace-analyzer→diagram→context chain (ran a full-repo ctags scan
  that nothing consumed). `lib/tools/grep.ts` + `lib/tools/glob.ts` now both run on ripgrep;
  `--no-require-git` + optional `--ignore-file` (`lib/tools/ripgrep-ignore.ts`) honor
  `.gitignore`/`.ignore`/`.atlarixignore` even outside a git tree. Removed the
  `atlarix-ignore` module, the bundled ctags binary, and the `fetch-ctags` machinery
  (postinstall + CI steps + assets).
- **Dependency diet** — removed 4 extraneous deps (`dompurify`, `marked`,
  `@tanstack/react-virtual`, `wink-bm25-text-search`) + `chokidar`. Removed 11 retrieval
  test files.

### Added
- **opencode-parity multi-provider.** `getLanguageModelProviders`
  (`ipc/shared/language_model_helpers.ts`) now merges a third source — the full models.dev
  catalog (`getModelsDevProviderCatalog`, `lib/models_dev.ts`): every provider carrying a
  base URL (~124 net-new) is connectable via the shared OpenAI-compatible `default:` path in
  `ipc/utils/get_model_client.ts`; hardcoded/custom providers still win by id. Models +
  context limits stay live (provider-native `/models` first, models.dev fallback) with an
  hourly auto-refresh and last-good-cache fallback.
- **Per-sub-agent token usage.** Each sub-agent's total tokens (`lib/agents/run-subagent.ts`)
  now show as a badge on its run card (`components/chat/subagent/SubAgentRunCard.tsx`),
  alongside the existing session total + "Sub-agents (last turn)" readout in `TokenBar`.
- **Terminal background-tab auto-close** (`components/panels/TerminalPanel.tsx`) — a
  background command's dedicated tab auto-closes ~6s after it exits successfully; failed
  commands and long-running servers stay, and foreground commands keep sharing the one
  persistent "Agent" tab.

## [14.8.16] (2026-07-10) — Hotfix: wire the Core proxy URL into release builds

v14.8.15 stripped `COMPASS_OPENROUTER_API_KEY` from the client and moved Core behind
`atlarix-proxy`, but the release workflow never passed the new `ATLARIX_CORE_PROXY_URL`
into the build env — so the shipped 14.8.15 binary embedded no proxy endpoint and Core
failed with "Atlarix Core is not configured for this build." This wires
`ATLARIX_CORE_PROXY_URL` into `release.yml`'s env block (covers mac/linux/windows) and
drops the now-dead `COMPASS_OPENROUTER_API_KEY` env. No app-code change; Core works again.

## [14.8.15] (2026-07-10) — Atlarix Core moves server-side: zero client secrets, hardened entitlement

tsc + oxlint clean; vitest **1681** green. A security-architecture release that **closes the
embedded-secrets item (C-1) left open in 14.8.14** — the client now ships with **no server
secrets at all**. From a 20-agent audit of the Supabase backend + Core-key handling
(`docs/SUPABASE_SECURITY_AUDIT.md`, kept local). **Known-open (tracked in `docs/TODO.md`):**
residual high CPU/heat under a hot suspect (terminal-output streaming).

### Atlarix Core → hosted proxy (SB-02 / SB-06)
- The managed OpenRouter key **no longer ships in the app**. Core requests now route through a
  new server-side proxy (`atlarix-proxy`, Hono on Railway): it verifies the caller's Supabase
  JWT, enforces the monthly Compass quota, forwards on the master key (server-only), and meters
  usage server-side (the client can no longer skip metering).
- `get_model_client.ts` `compass` case authenticates with the user's `session.access_token` and
  a public `ATLARIX_CORE_PROXY_URL` (new `core_proxy.ts`); a local dev key is the only fallback
  and is never present in a release. Client-side usage recording is now dev-only to avoid
  double-counting. The proxy's Core-model allowlist syncs from the hosted `core-models.json`, so
  switching Core models stays a one-file edit — no redeploy.

### No server secrets in the client bundle (A1 / A2 / A3)
- `vite.main.config.mts` `define` **stripped of** `COMPASS_OPENROUTER_API_KEY`,
  `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_WEBHOOK_SECRET`, `RESEND_API_KEY`.
- Checkout, subscription-cancel, and transactional email moved to Supabase edge functions
  (`create-checkout`, `cancel-subscription`, `send-email`) authenticated by the user's JWT;
  `lemonsqueezy.ts`, `auth_handlers.ts` cancel, and `email/resend.ts` now call those functions.

### Entitlement + billing hardening (SB-01 / SB-03 / SB-04 / SB-07 / SB-10)
- Migration `20260710120000`: authoritative `teams.tier`, guard triggers that block client team
  creation, membership `team_id` redirects, and self-inserted active memberships, plus a rewritten
  `guard_users_sensitive_columns` that validates `effective_tier` **independently** against the
  team's real tier — closing $0 self-escalation to Workforce.
- `handle-lemon-webhook` keys account mutations off the verified `custom_data.supabase_user_id`
  (never the payload email) and uses a constant-time signature compare.

## [14.8.14] (2026-07-09) — Security fixes, reference-grade command permissions, cross-platform performance overhaul

tsc + oxlint clean; vitest **1682** green (+ knip no new orphans). A large hardening + performance
release. **Known-open (tracked in `docs/TODO.md`):** residual high CPU/heat under a hot suspect
(terminal-output streaming), and the embedded-secrets rotation (C-1) still pending a backend.

### Security (from a full 5-agent audit)
- **grep tool no longer shell-injectable** — `src/lib/tools/grep.ts` builds an `execFile` argv (no shell).
- **Egress + SSRF** — `read_url` and `browser_navigate` both route through `assertUrlAllowed`, which now
  also blocks URLs carrying a secret shape (`src/lib/security/url-policy.ts`); web-search fetches use `safeFetch`.
- **IPC trust boundary** — main-frame `will-navigate`/`will-redirect` lockdown (`src/main.ts`) + a
  production-only sender-frame guard (`src/ipc/handlers/safe_handle.ts`).
- **Danger taxonomy** — generic interpreter-eval + reader-agnostic credential-path detection
  (`src/lib/dangerous-commands.ts`); automations deny on `systemScope`; single-`&` is now a command separator.
- **Symlink write-escape guard** (`interceptor.ts` realpath check), browser untrusted-content envelope hardened,
  Sentry `beforeSend` secret redaction, fail-closed workspace limits, OAuth loopback path guard, `chromiumSandbox: true`,
  a packaged-only CSP, and glob `..` rejection.

### Command permissions — reference-grade per-segment model (opencode / Claude Code)
- The gate now evaluates **per segment**: a command auto-runs only if EVERY segment is allowed (a user rule OR
  a built-in default read); **deny wins**; dangerous segments still key on `danger:<id>`; system-scope never
  silently auto-allows. A user "always allow npm" now composes inside `npm test && ls`.
  (`src/lib/command-default-allow.ts`, `src/ipc/handlers/command_permission_handlers.ts`.)
- Built-in read-only defaults (`ls/grep/find/cat/…` + pipelines of them) are visible + deny-overridable in
  Settings → Terminal permissions (`WorkspaceTerminalPermissions.tsx`).

### UX
- **Paste from any source** — a large paste now becomes an attachment chip even from rich-text apps (Notes/TextEdit):
  `text/plain` falls back to stripped `text/html` (`src/lib/chat/text-paste-attachment.ts`, `useAttachments.ts`).
- **One completion sound** — task-done no longer double-plays the in-app chime alongside the OS notification (`useStreamChat.ts`).
- **Chat render-cap** — only the last 120 messages mount, with a "Show earlier messages" button, so long sessions
  stay light (`SimpleInlineChat.tsx`). Streaming scroll-follow hardened against the "scroll fight" (`useStickToBottom.ts`).

### Performance (cross-platform)
- **File watcher → `chokidar`** (pure-JS; no native compile) with the composed `.gitignore`/`.atlarixignore` ignorer
  applied as chokidar's `ignored` so node_modules/.git are PRUNED at traversal and never watched — replaces the
  recursive `fs.watch` firehose (which flooded the main thread and threw on Linux). (`src/lib/search/search-index-watcher.ts`;
  graceful-degrades if chokidar is absent; torn down on quit.)
- **First-grep unblock** — sampled path validation instead of `existsSync` over every file (`ctags-index.ts`);
  FTS5 rebuild reads bounded to 64-concurrent (`fts5-index.ts`).
- **Memory** — ctags symbol cache LRU-capped (3 workspaces); FTS5 DB handles LRU-capped (4, safe close).

### Cleanup
- Removed the dead legacy `/chat` page + its orphan chain (~12 files; `ChatInterface`, `InputBar`, `ChatHandler`,
  legacy providers).

## [14.8.13] (2026-07-07) — Universal sandbox, system-scope gate, security hardening, notifications

tsc + oxlint clean; vitest **1635** (node 1504 / renderer 58 / agent-evals 73). The first release
since **v14.8.11**, so this is a large cumulative update — it rolls up everything below plus the
previously-unreleased platform bundle (Automations, native-git reads, Code-tab removal, universal
language, the `chat_stream_handlers` 7984→2364 decomposition). Security detail:
`docs/SECURITY_REVIEW_v14.8.12.md`.

### Added — sandbox, system-scope gate, notifications

- **Self-contained write-confining sandbox on every OS.** `run_command` writes are confined to the
  workspace + caches (reads + network stay open) via the OS's own kernel sandbox — macOS Seatbelt
  (built-in), a bundled Windows AppContainer helper, and a bundled Linux **Landlock** helper (falls
  back to `bwrap`, then unsandboxed). Ships unsigned for now; CI signs the Windows helper only when a
  cert is configured, and never blocks a release if a helper fails to build.
- **System-scope approval gate.** A command that changes things OUTSIDE the project — an on-device
  install (`brew`/`apt`/`rustup`/`npm -g`/`cargo install`/…), `sudo`, or a write outside the workspace —
  shows a distinct **"System change"** approval and is never silently auto-allowed. Approving it runs
  that one command unsandboxed so the install works; unattended Automations never get the prompt and
  stay sandboxed.
- **"Finished responding" desktop notification.** The same OS notification used when Atlarix needs you
  now also fires when a turn finishes (any mode, incl. a text-only Explore answer) — when the app is in
  the background. On/off + volume in Settings → General.

### Fixed (harness contracts)

- **Shift+Tab mode-cycle works while busy.** The binding was dropped whenever focus was
  in the composer or a stream was in flight (it sat below the input-focus guard); it's
  now global + always-live, like Cmd/Ctrl+B.
- **Streaming scroll no longer fights you.** An intentional upward scroll (wheel / touch /
  PageUp) now synchronously disengages auto-follow, so the ResizeObserver re-pin can't
  yank you back to the bottom mid-stream.
- **Attached images reach capable models.** The models.dev vision registry is warmed
  before the attach gate, so a cold cache no longer silently drops a DeepSeek/Qwen
  attachment (screenshots worked only because their gate ran later, warm).
- **MCP auth waits are truly indefinite.** The 5-min agent wait and 60-s OAuth flow
  timeout are removed — every human-in-the-loop MCP auth wait blocks until you resolve it
  (or Stop), matching command/file approvals.
- **Read-only mode blocks read clearly.** A mutating command blocked after a mid-session
  mode switch now returns a terminal "this is a MODE restriction, not permissions — don't
  retry" message instead of a soft failure the model looped on.

### Security (audit-driven; full report in `docs/SECURITY_REVIEW_v14.8.12.md`)

- **Compound-command danger gate.** `echo ok && rm -rf ~` (and `; | && ` chains, `$()`)
  are evaluated per segment — a risky command can no longer hide behind a benign prefix.
- **Exfiltration taxonomy.** Inline-eval interpreters (`node -e`, `python -c`), `gh` write
  verbs, credential-file reads, and remote-shell/netcat tools (`ssh`/`scp`/`nc`) are now
  dangerous — denied in unattended Automations, prompted interactively.
- **Deep-link hardening.** `atlarix://auth/callback` is rejected unless a sign-in flow is
  in progress (was one-click account-takeover); `atlarix://pro-return` requires an explicit
  confirmation before writing an API key / enabling Pro.
- **MCP consent + trust.** Attended MCP tool calls now prompt for per-tool consent (was
  unwired); tool descriptions are framed as untrusted data; the server-supplied OAuth URL
  is validated to http(s) before opening.
- **`.atlarix` authority files.** Writes to `.atlarix/atlarix.md` and
  `.atlarix/permissions.json` require normal approval (were blanket auto-approved).

### Added

- **Notification sound + OS notification when Atlarix needs you.** A chime (and an OS
  notification when the window is unfocused, respecting Do-Not-Disturb) fires when a turn
  waits on you for approval or a question. On/off + volume in Settings → General.

### Changed

- **Prompt refinement.** Distilled model-agnostic guidance into `AGENTS.md`
  (ground-claims-in-tool-results, finish-the-turn, report-don't-act, lead-with-outcome);
  reframed Debug's "state your hypothesis in your reply" to an action-first form (avoids a
  `reasoning_extraction` refusal on Claude-5-family models); `git checkout`/`switch` branch
  navigation is allowed in read-only modes (discard forms stay blocked).

### Platform bundle (rolled into this release) — native-git reads, Code-tab removal, universal language, Automations

#### Added

- **Automations** — Codex-app-style local recurring triggers with a triage feed, in the tab slot
  freed by the Code tab. Notify-only by default (a fired trigger posts to the feed with zero model
  involvement; "Send to chat" hands the event to your active session). Triggers: **schedule** (presets
  or cron), **GitHub polls** (new PR / review requested / CI failed — deterministic, cursor-seeded,
  zero LLM cost), **MCP polls** (fire on result-hash change). Opt-in agent runs execute through the
  `chat:stream` engine's headless spine: **read-only** or **worktree-write** (diff surfaces as a
  reviewable `git apply --3way` proposal). Dangerous ops always denied unattended; 10-min budget;
  concurrency 1. Results land in a triage feed (unread badges, nothing-to-report auto-archives,
  sonner/OS notifications); transcripts persist as background chat sessions; interrupted runs recover
  on boot. (Migration `0066_automations`.)

#### Fixed

- **Version history no longer crashes on large repos (production Sentry `null.slice`).** All local git
  ops shell out to system git (isomorphic-git buffered whole packfiles → hard-fails at 2 GiB);
  `enableNativeGit` deleted; isomorphic-git kept only as a lazy no-binary fallback for
  clone/push/set-remote. `list-versions` degrades to `[]` with one warning per workspace.
- **ast-grep no longer mis-parses unknown languages as TypeScript** — unregistered grammars are skipped.

#### Removed

- **ast-grep, blast-radius, and the dead blueprint-parse chain.** A consumer trace proved the working
  "Blueprint" is ctags + FTS5/BM25 only (grep reranking); ast-grep edges fed only the blast-radius line,
  silently broken in every packaged build. Deleted the ast-grep engine + worker + grammars (3 native
  deps), blast-radius, orphaned structural search, the whole dead parse chain, and 4 inert settings;
  the watcher slimmed to incremental ctags/FTS5 refresh. Grep reranking + enclosing-symbol annotation
  unchanged.
- **The Code tab, Monaco, and Cmd/Ctrl+P (QuickFileOpen).** Monaco (+5 workers, 812K grammars, a
  postinstall download) powered one component. Chat code blocks (shiki), agent diffs, write proposals,
  the Errors tab, and approve/reject are independent and unchanged; write-proposal cards render
  read-only with highlighting. `@file:`/`@dir:` mentions untouched.

#### Changed

- **`run_command` steers file-finding/content-search to `glob`/`grep`** (indexed, permission-free);
  `ls` still fine for listings.
- **Language support is universal.** ctags extension allowlist deleted (auto-detect ~150 languages +
  2 MB size gate); symbols carry their ctags `language`; a project with no marker file gets a real
  ctags-only blueprint; the workspace analyzer runs on the shared ctags index + one universal
  import-pattern pass — chat context + diagrams work for any language.

## [14.8.11] (2026-07-04) — Attachment fidelity, edit re-indentation, honest compaction, real context windows, ordered stream UI

Harness-fidelity release (every issue an observed live failure). tsc/oxlint/knip clean; vitest **1658**.

### Fixed

- **`edit_file` fuzzy matches re-anchor `new_content` to the file's REAL indentation** — a space-indented
  input into a tab file no longer splices verbatim (mixed indentation). Mapped lines adopt the matched
  region's indents, novel lines extrapolate by indent-unit delta, ambiguity falls back to verbatim.
- **Interrupted turns no longer erase attachment content** — paste-attachment ids are always the
  deterministic content-hash; send-time persist retries once; editing a message regenerates its
  model-facing content for both transport and DB.
- **`compress_context` tells the truth and actually compacts** — model calls force past the gate, the
  ratio uses the meter's scope, one exact counter feeds every number, the banner is success-gated.
- **Context windows come from real provider data** — per-model hardcode table deleted; resolution is
  user override → OpenRouter catalog → provider row → models.dev → logged fallback (native DeepSeek
  sees its real 1M); the Settings token-budget override wins everywhere incl. the compaction denominator.
- **Sub-agent cards read like the main chat** — reasoning segments rotate at every tool boundary
  (thought → tool → thought, in order).
- **Compaction/background cards render inline at their real position** via a pure timeline-weave.
- **Editing a sent message keeps its attachment chips** (stub tags stripped, rendered as read-only chips).

### Fixed (post-smoke)

- **Attachments survive edits + relaunches** — records carry the session UUID as the primary scope key;
  edit-resends rebuild the attachment directive.
- **Attachments are scoped to their conversation** — records tagged with their owning chat; the tools
  filter to an injected scope (no cross-session leaks).
- **Images on OpenAI-compatible vision providers** — the tool-media gate is API-format-driven while
  image input capability (models.dev) drives the user-message embed; a text-only-tool API gets an
  explicit "image is embedded / re-attach — do not guess" result. (`deepseek-v4-pro` is text→text per
  catalogs — its refusal is correct.)
- **Native multimodal models receive images** — models.dev input modalities feed `detectVisionCapability`;
  the non-vision placeholder forbids guessing from a filename.
- **Sub-agent popup unwraps to the final `<task_result>` markdown** (no raw envelope JSON).
- **Tab-strip titles follow session renames.**
- **Drag-and-drop attachments don't delay turn start** (PDF pre-extract moved off the send path).
- **S18: full-history tokenization ran ~3×/turn** — `exactTokenCountText` gained an LRU memo (O(1) for
  unchanged history).
- **Local providers (Ollama/LM Studio) use their live window from turn one.**

### Improved

- **`read_attachment` pages the FULL extraction** — 200K per-extractor caps gone; read_file-style
  offset/limit paging, cached extraction, shared preview whitelist, `rawBase64` bloat dropped.
- **Attached images are embedded in the message itself** — on a vision dispatch the turn's images ride
  as native image parts (≤8, ≤5MB, dispatch-only); `read_attachment` returns a native media part gated
  on result shape, vision-gated, honest placeholder otherwise. SVG returns as XML text.
- **Preflight TTFT gaps are attributable** (`gap-after-<name>`), naming every ≥50ms inter-span gap.

### Removed

- **Every dead legacy positive-id chat branch** (all live chats are negative-id stream-transport), plus
  two dead-by-flag features: auto-memory-after-stream and the post-turn self-correction husk.

## [14.8.10] (2026-07-03) — Reliable background work, one permission gate, lighter UI, sharper reasoning

Harness-refinement release from a live installed-app session. tsc/oxlint/knip clean; vitest **1576**.

### Fixed

- **The repetition guard guides instead of killing the turn** — `edit_file` keyed by full args (not
  `{path}` only, which read sequential edits as a doom loop); staged 3 (corrective result) → 6 (stronger
  steer) → 9 (tools-off force-finish).
- **grep no longer looks "stale" after the agent's own edits** — the write path upserts each written file
  into the FTS5 index; the reranker treats unindexed files neutrally; the watcher registers on workspace bind.
- **Inline chat no longer freezes after an error + model-switch continue** — every lifecycle event carries
  its leg's `streamId`; the renderer drops superseded-leg events.
- **edit_file self-heals across typographic punctuation** (curly quotes/dashes/ellipsis/NBSP normalized).
- **Sidebar "new window" opens the workspace chooser** (not a clone of the current workspace).
- **Model-driven commits carry the Atlarix co-author trailer.**
- **End-of-turn timeline no longer regroups old tool cards** (rebuild is a persistence fallback only);
  long delegations of any kind steer to `background:true` + park/auto-wake.
- **Headless tarball rebuilds automatically on every `v*` release tag.**
- **Plan progress updates are weak-model-proof** — full-plan rewrite (`operation:'write'`) is the
  canonical progress update; `update_step` prefers `step_text` and its not-found error carries the
  checklist + recovery routes inline.
- **Dead Blueprint UI surface removed** (13 `blueprint:*` channels, preload allowlist, the 430-line
  `registerBlueprintHandlers`, 3 UI-only libs) — the substrate is untouched.
- **Tool-result JSON fragments no longer leak into chat text** (orphan result tails stripped).
- **The continue-until-done gate no longer restarts finished work or hijacks Plan mode** — it doesn't
  attach in Plan mode, the nudge says "mark completed steps done, never redo", and a hard per-turn cap (12)
  bounds nudges.
- **Background/sub-agent results are delivered reliably** — the wake decision is computed up front
  (single-consumer), `background_jobs` shows the real finished output.

### Changed

- **One permission gate** — the "dangerous command" hard floor is gone; force-push / `reset --hard` /
  `rm -rf` flow through the ask / allow-once / always-allow / deny gate (amber badge, keyed per danger
  pattern, never auto-run until allowed once).
- **Reasoning scales to each model automatically** (capability-derived from the catalog channel;
  budget-capable → high/max, effort-only → medium/high).
- **Lighter UI under load** — ignore-filtered file-watcher + per-chat jotai selectors.

### Added

- **`wake_on` monitor for long-running jobs** — wakes the agent when a running job's output matches.
- **Background-job live view** — the running-tasks popover expands each job's output tail with a
  stalled/matched badge, cancel, and send-to-chat.

## [14.8.9] (2026-07-02) — Open-weight harness hardening: task-state, edit fidelity, and a sharper agent

First tagged release since 14.8.0; carries harness work 14.8.5→14.8.9. tsc/oxlint/knip clean; vitest **1525**.

### Added

- **Live task ledger + continue-until-done** — the session plan is re-surfaced compactly every turn; the
  agent keeps one step in-progress, verifies each before advancing, and drives the plan to completion
  (bounded; still stops for a decision / manual test / background work).
- **Out-of-band `<system-reminder>` framing** so a harness continuation isn't read as a fresh user request.

### Changed

- **`edit_file` collapsed to `write` + `replace`** with an opencode-style self-healing match cascade;
  over-escaped content (literal `\n`) is auto-repaired when unambiguous, hard-blocked otherwise.
- **Prompt + tool-guidance refinement** — de-duplicated triplicated mode guidance, decisive "when to use"
  moved onto tool schemas, work-mode picker shows only the five modes.
- **Token-efficient visual "sight" is more accurate** — the layout-defect check excludes
  decorative/positioned layers (no false "layout bugs").

### Fixed

- **Cancel is immediate** — stopping a turn kills sub-agent git/worktree children.
- **Actionable tool errors everywhere** — bare `{error}` returns normalized so a failure never reads as success.

## [14.8.0] (2026-06-30) — Headless preview testing, rock-steady streaming, smarter stalls

Reliability + capability pass. tsc/oxlint/knip clean; vitest **1441**.

### Added

- **Headless `preview_test` tool** — one call runs a scripted navigate→click/fill→waitFor→assert against
  the live preview and returns a structured pass/fail (reuses the offscreen `WebContentsView`, so it works
  in the packaged app; framework-agnostic). Build/Debug only.
- **Preview runtime-error completion gate** — a turn can't end "done" while the preview is
  white-screening/500ing (error console output, failed loads, dead renderer, 4xx/5xx block completion;
  benign dev warnings filtered).

### Changed

- **Idle-stall budget 300s → 600s** for open-weight reasoning models' silent think-pauses.
- **Stall recovery continues from the partial round** — completed steps captured via `onAbort` and
  replayed (no re-running every tool call).
- **Removed the redundant rolling 7-exchange session-memory summary** — context defers to the full history
  + token-overflow compaction (like opencode/Claude Code).

### Fixed

- **The streaming chat no longer jumps back** mid/end-of-stream — dynamic `overflow-anchor`, a same-frame
  `ResizeObserver` re-pin, and a scoped end-of-stream fallback.
- **Weak/local text-tool models settle cleanly** — text-tool detection runs per-delta so a prior round's
  `<tool_call>` isn't re-detected and re-executed.

## [14.7.0] (2026-06-26) — Wait-state unification: the agent waits, stops, and resumes like a real coding agent

Grew past a regression patch (14.6 fixes folded in). tsc/oxlint clean; vitest **1439**.

### Added

- **Wait is a harness property, not a prompt** — tool approvals block the turn mid-loop (the await lives in
  the tool's `execute`): Stop stays, no premature "all done", approve/deny continue the same turn.
- **Durable `waiting` status** — a parked/question turn persists as `waiting` (no migration), showing a calm
  affordance after reopen instead of the amber "interrupted".
- **The agent manages its own background sub-agents** — `task({list:true})` lists running sub-agents,
  `task({task_id,cancel:true})` hard-cancels one; live partial-output tails on status checks.
- **`schedule_wakeup` self-wake** (clamped 60–3600s; fully opt-in).
- **Atlarix Core local auto-fallback (dev-gated)** — release builds byte-identical (no-op when packaged).

### Changed

- **The agentic loop terminates on `finishReason`, not a native-message proxy** — removes a wasted extra
  round on every tool-using turn and parks detached work so the turn ends and auto-resumes.
- **Finished background results arrive as a real, persisted tool-result** (forced `collect_results` on the
  native-history channel).
- **Longer async timeouts** — sub-agent cap 5m → 10m; stalled advisory 2m → 3m.
- **Background tasks fold into one card** with a scrollable popover.

### Fixed

- **Context meter drops after compaction; reopened sessions slice correctly** (marker reliably persisted).
- **Settings permission rules now actually apply** — duplicate `apps` rows collapse onto the canonical row.
- **Edit-and-resend revert dialog returns after relaunch** (snapshot map rehydrated on session load).
- **No re-answering an already-answered question on auto-wake.**
- **Decrypt-aware provider-key check** — an undecryptable key no longer counts as "usable".

## [14.5.0] (2026-06-22) — Streaming reliability, full history, honest "Reconnecting", model-facing context meter

Reliability + fidelity pass on the chat stream and conversation surface. tsc/oxlint clean; vitest **1343**.

### Added

- **Stall auto-retry (per-round AbortController)** — a transient mid-turn stall retries the round on a fresh
  controller + reset-partial signal instead of killing the turn (slow first byte 180s vs. idle silence 45s).
- **Edit-and-resend optional file revert** — replays discarded turns' shadow-git snapshots newest→oldest.
- **Headless CI** — `.github/workflows/headless.yml` publishes the `headless-bench` prerelease tarball.

### Changed

- **"Reconnecting…" only on genuine reconnects (any provider)** — driven solely by the backend retry signal.
- **Single-flight turn guard** — at most one turn/write set per chat; a stale stream can't paint over a live one.
- **Smooth streaming render (no virtualization)** — memoized markdown segments, deferred Shiki,
  `overflow-anchor` (virtualization was prototyped and reverted).
- **Full conversation history** — 7-exchange render cap + `SESSION_LOAD_MESSAGE_LIMIT` + destructive
  200-message prune removed (no silent history loss).
- **Model-facing context meter** — shows the real dispatched size (post-compaction), so it drops after a summarize.
- **In-band file reads** — `read_file` self-paginates with stateless offset paging (disk-spill envelope dropped).
- **Review mode is read-only** — produces a change list, never edits.

### Fixed

- **Sub-agent panel ordering on native function-calling.**
- **Agent-error popups are user-only** (the error is in the tool card).
- **Background-job auto-wake end-of-turn race** — the wake lands before the turn closes.
- **Agent terminal-tab routing** — command output reaches the right-panel Terminal tab.

## [14.0.0] (2026-06-21) — Live preview control, session recordings, true background jobs, and mode-policy command safety

Major pass on the agent's execution surface. tsc/oxlint clean; vitest **1326**.

### Added

- **`target:"preview"` — the agent drives the LIVE app** — `browser_navigate`/`browser_inspect`/
  `browser_interact` act on the running dev server (snapshot refs, click/fill, console errors) via a real
  `WebContentsView`.
- **Inline preview artifact in chat.**
- **Session recordings (scrubbable reels)** — browser/preview activity captured off-screen as a frame
  manifest, rendered as a scrubbable player.
- **`background_jobs` tool + true background lifecycle** — list/output/cancel detached commands;
  `run_command({background:true})` returns a `job_id`; any command still running after ~15s auto-moves to
  the background.
- **Auto-wake when idle** — a finished backgrounded job re-engages the agent (no polling).
- **Generic localhost-URL → preview** auto-load.
- **Local-build auto-resign** — `postPackage` ad-hoc re-signs + clears quarantine on macOS local builds.
- **Launchpad help pages** (`/docs/*` on atlarix.dev).

### Changed

- **Preview: iframe → `WebContentsView`** (native navigation/console/error capture; off-screen
  `capturePaintable` fixes black frames when unfocused).
- **Terminal output streams inline** with a live activity pulse; sequential foreground commands reuse one
  Agent tab.
- **Capability-based vision gate** — `detectVisionCapability` replaces the hardcoded 3-provider allowlist.
- **Command persistence + safety overhaul** — removed the kill-timeouts + fake "dev server started";
  safety is now mode policy + a compound-aware `isMutatingCommand` backstop + the dangerous-commands gate
  + `.atlarix/permissions.json` (no large hardcoded classifier).
- **Readable, arg-aware tool cards.**
- **AGENTS / mode prompts realigned** to the real tool surface.
- **Rate-limit error card links to troubleshooting** (no upgrade button).

### Fixed

- **Provider-agnostic `web_search` dedup** — the xAI/Grok `Duplicate tool names: web_search` crash.
- **`browser_interact` fill reliability** (schema emphasizes `value` is required).
- **Empty preview frames** when the preview tab isn't focused.
- **Dev servers dying after ~10s / fake "running in background"** — removed in the persistence overhaul.
