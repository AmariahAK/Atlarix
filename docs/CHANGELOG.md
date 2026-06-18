# Atlarix Changelog

## [13.7.0] (2026-06-17) — Blueprint becomes the silent grep substrate, `@` mentions as chips, fewer Supabase pings, editable plans

> Retrieval gets simpler and sharper: the `get_blueprint` **tool** is gone, but the Blueprint
> index stays — now it silently reranks every `grep` (and powers edit-time blast-radius) instead of
> being a separate, token-heavy call the model rarely chose over grep. This matches the reference
> harnesses (Claude Code, opencode), which ship no structural-map tool; the published retrieval
> method is unchanged (the index still exists), only the agent-facing affordance moved into `grep`.
> The composer's `@` file/folder mentions now appear as removable chips (like pasted-text / terminal
> attachments) instead of inline `@file:` text, while preserving the existing capped, scoped
> extraction. Account/plan state is cached so a single user no longer triggers redundant Supabase
> round-trips on every auth event, and session plans can be added to/edited before and during a
> build with the agent picking up the changes.

### Added

- **`@` mentions render as chips.** Picking a file/folder from the `@` autocomplete adds a removable
  chip in the attachments row instead of inserting `@file:`/`@dir:` text inline. On send the token is
  re-emitted into the prompt so the scoped, capped extraction (60 KB/file, 200 KB total; folder =
  listing only) is unchanged; mentions are never base64-encoded. (`MentionAttachmentChip`,
  `src/lib/chat/mention-attachment.ts`, `ComposerAutocomplete` `mentionChips`.)
- **Browser interaction in read-only modes.** `browser_click` / `browser_fill` are now offered in
  Explore/Plan/Review (they mutate only the open page, never the workspace) so research can drive
  dynamic pages. Prompt guidance steers `browser_snapshot` (cheap refs) before `browser_screenshot`.
- **Editable plans before & during build.** A "Quick add step" input and an "unsaved edits" hint in
  the Plan panel; a new `plan({operation:"append_step"})` op + `plans:append-step` IPC add a checklist
  item without a full rewrite. Build-mode guidance tells the agent to re-read the plan (`plan({operation:"read"})`)
  so user additions made mid-build are honored.

### Changed

- **Retrieval: `get_blueprint` tool removed; Blueprint is the grep substrate.** The tool, its registry
  entry, prompting, sub-agent toolset entry, and help-page card are gone. The FTS5 + Ctags index,
  ast-grep edges, the token-free grep reranker, and edit-time blast-radius all stay. README "Map"
  positioning reframed; the retrieval eval retargets onto the `grep` surface; tool goldens re-pinned.
- **Fewer Supabase pings.** Effective tier and subscription details are TTL-cached per session and
  invalidated on sign-out / realtime plan change / explicit refresh, so repeated auth events and
  `auth:get-plan-info` calls don't each re-query. The team-membership lookup is skipped when the user
  is already at the max tier. No polling timer added (realtime remains the upgrade signal).

### Fixed / Security

- **OAuth tokens no longer logged.** The deep-link handler no longer logs the full callback URL (which
  can carry `#access_token=…`/`?code=…`) and the protocol-mismatch dialog no longer echoes it.
- **MCP env vars encrypted at rest.** `envJson` values are now stored encrypted (mirroring `apiKey`)
  and decrypted only for the spawned MCP process and the (trusted) settings UI; legacy plaintext is
  read transparently and migrated on next save.
- **Stale sub-agent worktrees reaped.** Worktrees leaked by a crashed writer sub-agent are pruned
  before a new one is created (registry prune + leftover-dir removal), preventing accumulation.
- **Clearer MCP auth errors** ("[MCP needs OAuth sign-in] … click Connect …, then call this tool
  again") so the agent can guide the user and retry.
- **GPU sandbox kept on macOS.** `disable-gpu-sandbox` is now applied only on Linux/Windows (where the
  `SharedImageManager::ProduceSkia` bug occurs); macOS keeps the hardening. `ATLARIX_DISABLE_GPU_SANDBOX=1`
  forces it off everywhere.

### Removed

- Dead code: `blueprint-rag.ts` (leftover from the embeddings removal), `retryOnLocked.ts`,
  `sql-exec-guards.ts`, the orphaned Blueprint focus-path error builders, and the unused `commit_blueprint`
  suggestion path. Unused deps `@mixmark-io/domino`, `axios`, `bluebird` uninstalled.
- Dead-export sweep (knip): removed ~14 unused exported functions/types left over from retired
  features — deploy-connector env helpers (`updatePostgresUrlEnvVar`, `updateDbPushEnvVar`,
  `readEnvFile`), `writeMigrationFile`, `getBlueprintSectionMeta`, `resolveWorkspaceIdFromRoot`,
  `setStreamInactive`, `appendTerminalInstanceLines`, project-memory list/upsert helpers,
  `createTestOnlyLoggedHandler`, the `DBConnectionStored` type, and a duplicate `OAuthSignInButtons`
  default export — plus the imports they orphaned. Unused exports 51 → 38 (remaining are vendored
  shadcn re-exports + e2e-only sentinels). Vendored UI re-exports left intact.

## [13.6.0] (2026-06-16) — Surface simplification: scoped `@` mentions, tiers collapsed to Core 1–4, deploy connectors removed, Review absorbs security

> The cycle that shrinks the product surface to what's actually used. Model selection drops the
> Fast/Balanced/Thinking tier abstraction — there are simply four individual **Core** models (Core 1–4),
> every plan can use every one, and nothing in the app is hardcoded to a tier anymore. The `@` mention
> was rebuilt from a cross-workspace whole-codebase dump into **scoped file/folder context** in the
> current workspace (a token bomb becomes a scalpel). The `/` slash-command system — which only
> duplicated the mode picker behind a hidden editor — is gone. The bespoke deploy connectors
> (Supabase / Neon / Vercel / GitHub Actions panels) are removed in favor of a **terminal-first** flow
> plus **MCP-only** SaaS connectors, and the standalone `/security-review` is folded into **Review** mode
> so one reviewer covers correctness *and* security. BYOK context limits now come live from each
> provider's API — no hardcoded model windows.

### Added

- **Scoped `@` file & folder mentions (current workspace).** Typing `@` in the composer lists workspace
  files + folders via a new gitignore-aware `workspace:list-paths` IPC (reuses `getProjectFiles`). A
  mentioned **file** injects its contents (capped 60 KB/file, 200 KB total); a mentioned **folder**
  injects only its file *listing* (capped, paths re-rooted under the folder) so the agent `grep`s/reads
  within that scope. Parsed by `parseContextMentions` (`@file:`/`@dir:`), built by `extractMentionedContext`,
  injected provider-agnostically as a single read-only prefix message. Replaces the old `@app:` whole-other-app
  codebase dump. (`src/shared/parse_mention_apps.ts`, `src/ipc/utils/mention_apps.ts`,
  `src/components/chat/ComposerAutocomplete.tsx`.)
- **Live BYOK context limits.** Per-provider context windows are resolved from each provider's own
  catalog/API at dispatch and display time rather than hardcoded — switching from a 1M-token model to a
  268K one (or any model) reflects the real limit everywhere (budget, compaction, the context bar).
- **Session-resume prompt + model-switch notice.** Reopening a workspace offers to resume the prior
  session, and switching the active model mid-thread surfaces a notice when the context window changes.
- **MCP OAuth marketplace connect.** One-click OAuth connect for marketplace MCP servers (interactive
  Connect flow distinct from the silent runtime auth-and-retry path; the agent never opens a browser
  mid-turn).
- **README ↔ JSON workspace docs** auto-generation kept in sync.

### Changed

- **Model selection: tiers → four individual Core models.** The Fast/Balanced/Thinking tier abstraction
  is removed; Core is just **Core 1–4**, every plan can use every model, and per-role model settings
  (summarization/review/agent) bind to actual models. Persisted legacy selections are coerced forward
  (`fast`/`balanced` → `same`; `compass-fast/-balanced/-thinking` → `core-1/-2/-3`) in
  `src/main/settings.ts` + the compass alias maps. No tier names remain in user-facing copy.
- **Review mode now covers security.** The standalone `/security-review` (which didn't reliably work) is
  merged into **Review** so a single pass audits correctness, maintainability, *and* security concerns.
- **SaaS integrations are terminal-first + MCP-only.** Databases and CI/CD are driven through the
  sandboxed terminal (`git`/CLI); third-party SaaS connects via the MCP marketplace (Team adds one-click
  OAuth) instead of bespoke in-app connector panels.

### Removed

- **The `/` slash-command system — deleted wholesale.** It only duplicated the mode picker behind an
  already-hidden editor. Gone: `commands_handlers.ts`, `src/lib/commands/custom-commands.ts`, the dispatch
  expansion, the `commands:*` IPC channels + client methods, the Custom-commands settings UI (Hooks
  settings retained), and the `custom_commands` table (migration `0065_drop_custom_commands`). The
  composer autocomplete is now `@`-only.
- **User-facing deploy connectors — Supabase / Neon / Vercel / GitHub Actions.** The connector panels and
  their handlers are removed (`SupabaseConnector`, `DBPanel`, `GitHubActionsPanel`, `neon_handlers`,
  `db_extension_handlers`, `extension_space_handlers`, `github_actions_handlers`, the Supabase e2e
  fixtures/specs). **Atlarix's own prod Supabase (account auth + Core metering) is untouched** — only the
  per-app deploy machinery was removed.
- **The `security_handlers` / standalone security-review path** (folded into Review, above).

### Fixed

- **`ask_user` no longer leaks across sessions.** A question left pending when the app closed mid-turn no
  longer reappears in a new session, and closing the app on a pending question no longer raises an
  `AbortError: ask_user_pending` (with the matching Sentry noise suppressed).
- **Stale Core selection** corrected when a previously-selected Core model is no longer present.

## [13.5.0] (2026-06-13) — Open-weight Core providers, disk-backed FTS5 retrieval, writer sub-agents, real Windows sandbox

> The cycle that makes "the open-weight frontier harness" literal: DeepSeek, Qwen, Kimi, and MiniMax
> ship as first-class **Core** providers; code retrieval is rebuilt to scale to any workspace size on a
> disk-backed lexical index (no vector DB, by design); sub-agents can now *write* in isolated git
> worktrees; and the `run_command` sandbox gains a real Windows AppContainer helper. Net effect: sharper
> retrieval at lower token cost, more parallel work per turn, and a lighter app (−62 MB).
> Validated on a real giant multi-repo: the "find the signup code" query went from ~63K to ~26K turn
> tokens with verified-accurate results (exact file:line citations across three sub-projects, zero
> hallucination). The thesis, confirmed in data: for **code**, lexical + structural retrieval plus the
> model's own reasoning beats a vector index (our references Claude Code and opencode carry no index).

### Added

- **Open-weight Core providers — DeepSeek, Qwen, Kimi, MiniMax.** The four open-weight families ship as
  first-class managed providers, with their model lists pulled from the live `models.dev` catalog at
  startup (cached, no repackage to add a model). Provider-id mapping handles catalog vs. API naming
  (`qwen→alibaba`, `moonshot→moonshotai`; deepseek / minimax identity). (`src/lib/provider_model_fetchers.ts`,
  `src/lib/core-model-overrides.ts`.) BYOK pricing resolution added (`src/lib/routing/byok-pricing.ts`).
- **Disk-backed SQLite FTS5 lexical index** (`src/lib/search/fts5-index.ts`, pure SQL contract in
  `fts5-core.ts`). One standalone DB per workspace; ~constant low memory at any repo size (kills the
  prior in-memory OOM ceiling on giant repos), incremental per-file updates, with candidate-set rerank
  (scores only the files ripgrep returned) and per-package lexical scoping (`package-boundaries.ts`).
  The public retrieval API is unchanged behind a facade.
- **Symbol-aware `grep` (zoekt-style).** Each result names its enclosing function/class via a new
  `findEnclosingSymbol` ctags helper, so the model jumps straight to the symbol instead of reading files.
  Match-list cards show the symbol as a badge.
- **Writer sub-agents in isolated git worktrees.** A `task` can now run in *implement* mode
  (`task({ write: true })`): it works inside a throwaway git worktree branched from `HEAD`, with
  `write_file`/`edit_file` path-confined to that worktree and `run_command` sandboxed to it. The
  worktree's diff is captured and handed back to the main agent, which lands the changes through its
  own approval-gated write tools — so parallel writers never touch the real tree directly and the user
  still reviews every hunk. Requires a git repo; otherwise the sub-agent falls back to a read-only
  scout. (`src/lib/agents/run-subagent.ts`, `src/lib/agents/subagent-worktree.ts`.)
- **Real Windows AppContainer sandbox helper.** The `atlarix-sandbox.exe` helper (`native/atlarix-sandbox/`,
  Rust) is now built + code-signed in CI and bundled via `extraResource`, completing the per-OS
  write-confining sandbox for `run_command` alongside macOS Seatbelt and Linux bubblewrap.
- **Verifiable browser session-recording + accessibility-ref tools.** The in-app browser records a
  verifiable session artifact, and the snapshot/interact tools resolve actions by injected
  `data-atlarix-ref` accessibility refs rather than brittle CSS selectors. (`src/lib/browser/a11y-snapshot.ts`,
  `src/lib/tools/browser-recorder.ts`.)
- **Microcompact: stale tool outputs dropped without an LLM call.** Tool outputs older than the last few
  user turns are dropped outright (no summarization round-trip), reclaiming context cheaply before full
  compaction is ever needed. (`src/lib/context/compaction.ts`.)

### Changed

- **`grep` tuned for sharp, low-token output:** defaults cut hard — `max_bytes` 120K→24K,
  `max_results` 50→20, per-file lines 30→5, context 2→0 — and results lead with the most relevant file.
- **Blueprint Tier-1 retrieval sharpened** — reciprocal-rank fusion across lexical legs, field reweighting,
  and proximity scoring, so the most structurally relevant rooms/symbols surface first. (`src/lib/blueprint/`.)
- **Browser tools steered snapshot-first:** `browser_screenshot` reworded to "visual confirmation only"
  (token-heavy); `browser_snapshot` is the way to find/interact; Explore + Build mode skills updated.
- **Checkpoints survive a restart.** `snapshotTurnId` is now persisted, so revert-turn still works after
  the app is closed and reopened (previously session-lifetime only).
- **Keep-awake while the agent works** is a gated setting — long unattended runs no longer stall when the
  machine sleeps, but the behavior is off unless opted in.

### Removed

- **The on-device Model2Vec / semantic-embedding lane — deleted wholesale.** `model2vec-runtime`/`-loader`,
  `static-embeddings`, `searchBlueprintByEmbedding`, the embedding RRF leg, the `semanticRecall` setting,
  the `emb_src` column, the bundled 62 MB model + `fetch-model2vec`. It only engaged under a 40K-symbol
  cap (never helping giant repos), bloated the bundle, and chased recall when the real bottleneck was
  token volume. Bundle shrinks ~62 MB. Blueprint room scoring (lexical) is unaffected.
- **The capability-TRIM stage + per-tool `cost` + the `ToolCategory` enum.** At ~22 tools the tool-count
  cap was unnecessary, so it is gone — every model now gets the full mode allowlist. Weak/local models
  keep only parameter-schema simplification (`getCapabilityProfile` / `simplifyToolParametersForProfile`),
  not a reduced tool count. (`src/lib/routing/model-capability-profile.ts`, `src/lib/tools/resolve-toolset.ts`.)

### Fixed

- **Lost plan sessions auto-rebind** after a restart, and **ast-grep language grammars are unpacked from
  the asar** so structural search works in packaged builds. A renderer `get_model_client` stub prevents a
  packaging crash.

## [13.1.5] (2026-06-12) — Open-weight harness hardening: command sandbox, parallel-research orchestration, Hugging Face, Blueprint-backed grep

> Ships the full v13 line (see [13.0.0] and the v13.1 follow-ups below) plus this cycle's hardening.
> Atlarix is a private, any-model, local-capable agent harness with verified-edit rigor.

### Added

- **Per-OS write-confining sandbox for `run_command`.** Agent shell commands run inside an OS sandbox
  that confines filesystem **writes** to the workspace + temp + package caches (network stays on,
  reads stay broad): macOS **Seatbelt** (`sandbox-exec`), Linux **bubblewrap** (`bwrap`), Windows
  **AppContainer** (the `atlarix-sandbox.exe` helper — `native/atlarix-sandbox/`, Rust, built + signed
  in CI and bundled via `extraResource`; pending first validation on a Windows build). Agent-only —
  the user's interactive PTY tabs are never sandboxed. Toggle via `sandboxRunCommand` (default on
  where available) or `ATLARIX_DISABLE_SANDBOX=1`; graceful fallback if the OS tool/helper is missing.
  (`src/lib/sandbox/wrap-command.ts`, injected at the `run_command` spawn in `runShellCommand.ts`.)
- **Background sub-agents: wait / work-while-waiting orchestration.** `task({ background: true })`
  returns immediately; the main agent keeps working and **each sub-agent's result folds into the turn
  the moment it finishes** (even one at a time) via the `prepareStep` injection seam — no polling. The
  turn now waits on in-flight sub-agents before ending (a "Waiting on N sub-agents" indicator), with a
  per-sub-agent ~5-min timeout (`ATLARIX_SUBAGENT_TIMEOUT_MS`) so a hung scout can't stall the turn.
  Sub-agents can `web_search` + `get_blueprint`, so fan several out for parallel research.
  (`src/lib/agents/subagent-results.ts`; mirrors the v13 background-command seam.)
- **Hugging Face provider (BYOK).** Hugging Face appears in Settings → AI as an OpenAI-compatible
  provider (router `https://router.huggingface.co/v1`, live `/v1/models` listing, "Setup API Key" →
  huggingface.co/settings/tokens, env `HF_TOKEN`). Direct-BYOK only — not routed through the managed
  engine, so Pro users still use their own key.

### Changed / Fixed

- **Blueprint is the always-on retrieval substrate behind `grep`.** Grep results are reranked and
  ordered by Blueprint's BM25 + structural relevance (the same warm, file-watcher-refreshed index
  `get_blueprint` uses), so the most structurally relevant files surface first and survive the result
  cap. No embeddings — by design. (`src/lib/blueprint/grep-blueprint-reranker.ts`.)
- **Message order preserved after streaming.** Reasoning/thoughts no longer collapse to the top or
  bottom on reload — a turn renders text → thought → tool → thought in true arrival order, matching
  the live stream. The persisted `content` stays `<think>`-stripped (so the model never re-reads its
  own reasoning); an ordered display copy (`interleavedContent`) rides in the per-message display
  snapshot and the frozen view renders from it.
- **Terminal-command & file cards paginate.** Long runs of consecutive `run_command` / `write_file` /
  `edit_file` cards collapse into pages of ~6 with a "Show N more" control, so a busy turn no longer
  grows the page unbounded. (`PaginatedToolCards`, `lib/chat/paginate-tool-runs.ts`.)
- **Settings deep-link scroll fixed.** The Compass "switch provider" link and the MCP OAuth prompts
  now scroll Settings to the AI / MCP section instead of landing at the top (one-shot
  `pendingSettingsScrollAtom`).
- **Removed the Ollama model recommender** (hardware-profiling + "recommended models" + the external
  `llm-checker` wrapper) — unused; general Ollama provider support is unchanged.
- **Packaging hardening.** Runtime externals (`@mixmark-io/domino`, `axios`, `bluebird`) are declared
  so the slimmed package keeps them; `electron-log` is bundled into both main and the ast-grep worker;
  an ad-hoc re-sign step fixes the dev `package` Gatekeeper kill; the now-unused LSP server deps were
  removed from the manifest.

### Engineering

- Integration commit **bc171bb "making atlarix a proper harness v1"** — templates removed (~2,600
  lines), Activity/Agents tabs + background-agents removed, tool surface 38→22, one parallel `task`,
  live sub-agent thinking, background commands + waiting UI, web-search upgrades. The [13.0.0] and
  v13.1 sections below detail that line (now shipped as part of this release).

## [13.0.0] (2026-06-12) — v13 mass simplification (shipped in the 13.1.5 release)

> The simplification release: Atlarix keeps its differentiators (Blueprint, approval queue,
> native tool history, modes) and sheds everything the reference apps (opencode / Claude Code /
> Cursor / Antigravity) prove unnecessary. Tool surface cut from **38 → 22**; the model gets
> simpler primitives, the user gets richer feedback.

### Changed (v13)

- **Tool surface: opencode-minimal (38 → 22).** The agent now works with `read_file` (offset/limit
  pagination), `write_file`, `edit_file`, **`glob`** (file discovery, mtime-sorted), **`grep`**
  (ripgrep content search), `run_command`, `get_blueprint`, `web_search` (with `deep: true`),
  `read_url`, `ask_user`, **`task`**, **`plan`**, `mcp_call` + `list_available_mcps`,
  `compress_context`, `read_attachment` + `list_attachments`, and the 5 in-app browser tools.
  Deleted/folded: list_files, explore_folder, get_project_structure, get_repo_overview,
  get_file_outline, find_file, the multi-mode `search` tool, write_multiple_files, rename_file,
  delete_file (use `mv`/`rm` via run_command — `rm` always prompts and can never be auto-allowed),
  run_tests, check_environment, live_preview, 4 terminal-instance tools + stream_terminal_output,
  4 lsp_* tools (the in-loop edit-verify LSP gate is unchanged), the memory tool family
  (`.atlarix/memory.md` is now auto-injected; the agent updates it via write_file), the skills
  tools (installed skills auto-inject), 3 workspace tools, visualize_graph, db tools,
  request_tools, deep_research, the WebMCP bridge, and debug-hypothesis tooling.
- **One `task` tool, up to 5 PARALLEL sub-agents.** `delegate_to_agent` / `spawn_sub_agent` and the
  specialist roster (Research/Architect/Builder/Reviewer/Debugger) are gone. `task` spawns a scoped
  read-only scout; multiple `task` calls in ONE response run concurrently (5-slot semaphore), in
  every mode. `subagent_type` selects a user-defined `.atlarix/agents/` agent. Sub-agents now run on
  `streamText`: their **live thinking and narration stream into the sub-agent card** (new
  `subagent_thought` activity events, upserted in place) — not just tool labels.
- **`plan` is ONE tool** (`operation: write | read | set_status | update_step`) replacing the five
  plan tools; the SQLite plan-artifact backend, cards, and panel are unchanged.
- **Progressive tool reveal removed.** All ~22 schemas bind upfront; the 4-stage resolution
  pipeline is now 3 stages (registry → mode allowlist → capability trim).
- **Modes amped, not multiplied.** The 5 modes keep their lineup with rewritten prompts that absorb
  the deleted personas (Debug keeps hypothesis-first discipline as prose — the
  record_debug_hypothesis tool and its write gate are gone). Debug now has the full Build tool
  surface (differs by prompt discipline only). The structured Plan/Debug/Review "report rewriting"
  pass (JSON schema validation + retry model call over the final answer) was deleted — modes answer
  in natural markdown.
- **Tool result cards show the work by default.** A completed write/edit opens its diff; a completed
  command opens its output with an exit-code badge and "show full output"; reads stay collapsed.
  Cards no longer collapse to just "File has been created". Running mutating tools render a
  fixed-height skeleton so the card doesn't jump on completion.
- **"This appears to be a long task" banner deleted.** Replaced by subtle inline status states:
  "Reconnecting…" when the stream goes quiet, "still working (1:23)" on long turns, and the new
  waiting chip (below).

### Added (v13)

- **Background commands (Claude Code's run_in_background).** `run_command({ background: true })`
  returns to the model immediately; the command keeps running with live output in the agent
  terminal tab, and its exit result is delivered back automatically — mid-turn via step injection,
  or at the next turn via a context drain. No polling tool.
- **Visible waiting state.** When a foreground command runs >10s, the chat flips from the stop
  square back to a send arrow and shows a persistent "Waiting on command · 0:42" chip (click opens
  the right-panel Terminal on the agent's command; a stop affordance stays on the chip). The user
  can type ONE queued message that sends automatically when the turn ends.
- **`.atlarix/memory.md` + installed skills auto-injection** into the system context (replacing
  their tool families).

### Added (v13.1 — follow-up, same unreleased cycle)

- **Plan is a coexisting right-panel tab.** A session plan no longer takes over the whole right panel — it rides as a `plan` tab alongside Preview/Code/Browser/Terminal, so you can watch the plan while the agent builds and switch to the terminal freely. (`useRightPanelContext`, `RightPanel`, `mapIntentToView('show-plan') → code-preview`.)
- **Queue a message any time while streaming.** The chat input stays enabled during a turn; Enter/Send queues one follow-up that fires automatically when the turn ends (the stop square stays visible). Generalizes the v13 waiting-on-command queue to every streaming state.
- **AGENTS.md / CLAUDE.md interop.** When a repo has no `.atlarix/atlarix.md`, Atlarix injects its root `AGENTS.md` (the cross-agent standard) then `CLAUDE.md` as project instructions — drop-in friendly on repos already configured for other agents. Read-only; never copied into `.atlarix/`.
- **"Revert this turn's file changes" checkpoint.** Assistant messages whose turn captured a shadow-git snapshot get a Revert action that restores the files that turn wrote (deleting files it created) WITHOUT rewinding the conversation, after a confirm dialog listing the files. Session-lifetime only (the snapshot turn id isn't persisted across reloads).
- **Web search output quality.** `read_url` and deep `web_search` page content now convert HTML → Markdown (turndown, preserving headings/lists/code/links, with a plain-text fallback); page budgets raised (read_url 5K → 20K default / 50K max, plus `max_length` + `timeout` params); a one-shot Cloudflare-challenge retry with a browser User-Agent; fetch timeouts 10–15s → 20s.

### Removed (v13.1)

- **ALL LSP — model-facing and editor.** The in-loop post-write LSP-diagnostics verify (postWriteVerify) and its "Auto-fix from LSP" setting, the editor's Monaco squiggle integration (`src/lib/lsp/*`, the lsp IPC handlers/channels/client methods, FileEditor's LSP lifecycle), and the bundled `typescript-language-server` + `vscode-langservers-extracted` (+ `vscode-jsonrpc`/`-types`) servers (~6–8 MB). Verification is the project's own checks + tests via `run_command` (the v12.10 mode discipline). The stop-hook task-complete gate that shared the verify counter is preserved. The dev-server **Errors** tab (terminal/runtime error parsing) and the dev-server TypeScript watcher are independent and unchanged.

### Removed (v13)

- **Project templates — entirely.** The hub template picker, git-clone + cache pipeline
  (`userData/templates`), bundled `scaffold/` starter, `TEMPLATE_TOKEN` env/CI secret, Neon
  template hooks, `create-app` IPC chain, and the `selectedTemplateId` setting (~2,600 lines).
  Projects are scaffolded by the agent via non-interactive CLI commands (`npm create vite@latest …`).
  **Manual:** delete the `TEMPLATE_TOKEN` repo secret and remove `TEMPLATE_TOKEN` from local `.env`.
- **Right-panel Activity and Agents tabs** (deleted, not hidden), and the entire **background-agents
  feature** (detached sessions + shadow-git keep/revert + `agents:background:*` IPC). Parallel
  `task` sub-agents and background commands replace it. DB migrations 0060/0061 stay (history);
  the columns are simply no longer written.
- The autonomous post-task reviewer+debugger verification pass (redundant with the in-loop
  edit-verify gate + project-check discipline), the legacy DB debug-write gate, the WebMCP page-tool
  bridge (`preload-browser.ts`), and the terminal's "[restored scrollback — new shell below]"
  notice (now a dim separator, written only on real app restarts — tab switches were already
  silent reattaches).
