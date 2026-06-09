# Atlarix Changelog

## [12.9.5] (2026-06-09) — Terminal now opens in packaged builds

### Fixed (v12.9.5)

- **"Interactive shell unavailable: posix_spawnp failed" is fixed.** After v12.9 stopped the Terminal from crashing the app, the packaged build couldn't actually launch a shell. node-pty's macOS `spawn-helper` is a separate Mach-O executable (a sibling of `pty.node`, not a `.node` file), so `AutoUnpackNatives` (which only unpacks `*.node`) left it inside `app.asar` — and node-pty resolves it to `app.asar.unpacked/.../spawn-helper`, which didn't exist, so `posix_spawnp` failed. The `@lydell/node-pty-<platform>` dirs are now `asarUnpack`-ed (the same packaging pattern as the `@ast-grep` native packages), so `spawn-helper` (and the Windows conpty/winpty binaries) ship on disk and get code-signed. The interactive Terminal now opens in the installed app. Dev was unaffected.

---

## [12.9.0] (2026-06-09) — Fix fatal Terminal crash (removed keytar) + packaged system prompt

### Fixed (v12.9)

- **The packaged app now ships the full system prompt.** In production the agent silently ran on a degraded minimal fallback prompt — `AGENTS.md` / `AGENTS_COMPACT.md` / `AGENTS_MODE_BASE.md` were never packaged (root-level files are excluded by the packager's `ignore` allowlist), so `system_prompt.ts` logged "AGENTS.md not found … using fallback minimal prompt". These files now ship via `extraResource` (the same mechanism as the built-in skill guides) and are loaded from `process.resourcesPath` first when packaged. Dev was unaffected (it reads them from the project root).
- **Opening the Terminal no longer force-closes the app (macOS).** In packaged builds, clicking the right-panel Terminal tab could abort the entire process. The crash minidump symbolicated to **keytar**: its prebuilt native binary throws an uncaught C++ `Napi::Error` on the main thread (`Napi::CallbackData::Wrapper` → `__cxa_throw` → `std::terminate` → `abort`) for certain macOS Keychain states. Because the abort happens *inside native code*, no JS `try/catch` (nor the v12.8 `uncaughtException` handler) can catch it — the only fix is to stop calling keytar. The Supabase session store (the sole keytar user) was being touched during a session read/refresh that coincided with opening the Terminal. Replaced keytar with Electron's built-in **`safeStorage`** (already the fallback here, and used elsewhere in the app), which raises catchable JS errors and cannot abort the process. keytar is also deprecated/unmaintained.
- **Note:** session persistence now lives in `safeStorage` (encrypted `supabase-auth.enc`). After updating you may be asked to **sign in once more**; afterwards the session persists as before.

### Internal (v12.9)

- Removed the `keytar` dependency entirely (package, native rebuild config in `forge.config.ts`, types, knip allowlist). One fewer native addon to build/ship. The same keytar abort could also fire on any background Supabase token refresh; removing keytar closes that path too.

---

## [12.8.0] (2026-06-08) — Stability: graceful token count, delete-session keeps you in the workspace, crash hardening

### Fixed (v12.8)

- **No more "Chat not found: -1".** A debounced token-count request that fired for a chat just torn down (session deleted / app teardown) threw `Chat not found: <id>` (`token_count_handlers.ts`), which surfaced as a user error toast and a Sentry event. Token count is a non-critical estimate, so a missing ephemeral chat now returns an empty result instead of throwing.
- **Deleting the active session no longer bounces you to the workspace selector.** `WorkspaceSessionList.handleDelete` cleared the active session but never started a replacement, so deleting the active (or last) session fell back to the welcome screen. It now opens a fresh session in the **same** workspace (reusing an empty default session when one exists) via `startNewWorkspaceConversation`. Deleting a background session leaves your current view unchanged.

### Hardened (v12.8)

- **Prevent fatal native aborts.** The main process had no `process.on("uncaughtException")` handler, so an uncaught error (a native-addon throw, or a JS error outside a promise) reached the runtime and triggered `std::terminate()` — a hard abort that crashed the window and lost work (fatal minidumps in Sentry). Added an `uncaughtException` handler that reports to Sentry (respecting the v12.7 filters) and keeps the app alive, mirroring the existing `unhandledRejection` policy. Also wrapped the `before-quit` flush chain in a `try/finally` (always quits, reports unexpected throws) and guarded the unwrapped `safeStorage.encryptString` write in secure-storage.

---

## [12.7.0] (2026-06-08) — Tool-schema sanitizer (fixes strict-provider 400s), tidier chat config, quieter Sentry

### Fixed (v12.7)

- **Malformed tool schemas no longer break strict-validating providers.** Some tools encoded a property's optionality as a JSON-Schema-invalid `required: true/false` boolean (it must be an array of property names). Lenient providers ignored it, but strict validators (e.g. Mistral via OpenRouter) rejected the whole request with `400 "Invalid tool schema: False is not of type 'array'"`, which surfaced as an empty/failed turn. A new `sanitizeJsonSchemaForProvider` (`src/lib/ai/normalize-tool-schema.ts`) now strips those booleans and hoists the `required: true` ones into the correct top-level `required` array, applied at both tool-wiring sites in `chat_stream_handlers.ts`.
- **Tools with hand-written parameter maps now send their real parameters.** Tools that declared `parameters` as a bare `{ prop: {…} }` map (no `type`/`properties` wrapper) — e.g. `live_preview`, `rename_file`, `create_workspace` — were silently downgraded to an empty permissive schema, so the model received them with no parameter hints. The normalizer now wraps and preserves them.

### Changed (v12.7)

- **Removed the unused "Manage MCP tools" entry from the chat Config dropdown.** Full MCP management remains in **Settings → MCP Servers**. Tidies the in-chat config menu down to Model and Deep reasoning.

### Internal (v12.7)

- **Stop reporting benign empty-output stream errors to Sentry.** `AI_NoOutputGeneratedError` / `AI_NoContentGeneratedError` / `EmptyModelOutputAfterRetryError` are already handled in-process (retried, or a no-op flush); they're now dropped in `sentry-before-send.ts` (structured `isNoUsableModelOutputError` match) and `sentry-ignore-patterns.ts`. Genuine provider errors still report.

---

## [12.6.0] (2026-06-08) — Sign-in fix: Google & GitHub buttons everywhere, log out/in from the welcome screen

### Fixed (v12.6)

- **Sign-in surfaces show real OAuth buttons again:** after logging out, the sidebar (and the welcome screen, and the full sign-in page) showed only the animated Atlarix mark with "Click to sign in" — Google-only and easy to miss. They now render proper **"Continue with Google"** and **"Continue with GitHub"** buttons. The Supabase OAuth wiring was always intact (`auth:sign-in` → `SubscriptionManager.signIn`); only the UI had regressed to an animation-only control. Restores the v9.0.0 button UI, now driven by `useAuth()` so the in-flight OAuth status/spinner is preserved.

### Added (v12.6)

- **Log out / sign in from the welcome screen:** the home/workspace-selector header now has a **Sign out** control next to "Settings & account", and when signed out it shows the Google/GitHub sign-in buttons directly — no need to dig through the sidebar.

---

## [12.5.0] (2026-06-08) — Concurrency & stability: run sessions in parallel, never lose work, keep going while the screen sleeps

> The first tagged release. It bundles all the previously untagged 11.0/12.0 work (engine rewrite, in-app browser, Atlarix Core, document readers — see the sections below) plus this stability batch.

### Added (v12.5)

- **Concurrent sessions:** Starting a second workspace session no longer hides the first. Open sessions now appear as **tabs** above the chat (each with a live streaming dot), and the sidebar shows a running indicator per session — so a session that's still streaming in the background stays reachable instead of being overwritten. Per-chat state was already isolated by chat id in the backend; the bug was the renderer unconditionally replacing the active chat on every open.
- **Interrupted-turn recovery:** A turn that's cut off by an abrupt quit, OS sleep, or crash is no longer lost. The main process throttle-persists the in-flight assistant text to the session DB (a new `session_messages.status` = `interrupted` row), force-flushes it on stream abort, `before-quit`, and `powerMonitor` suspend, and deletes the draft on clean completion. On reopen the session shows the partial output with a **Continue** button that resumes the turn.
- **Keeps working while the display sleeps:** A reference-counted `powerSaveBlocker('prevent-app-suspension')` is held whenever a stream is active, so long tasks keep progressing when the screen sleeps. (A full system suspend / lid-close is still OS-enforced — partial work is flushed first so nothing is lost.)
- **Switch-provider prompt on Core exhaustion:** When the monthly Atlarix Core token pool runs out (or Core is unreachable), the chat shows an actionable banner — **Choose another model / Switch provider** (opens Settings → AI) plus an upgrade link — instead of a bare error.

### Fixed (v12.5)

- **The inline "A" indicator now persists after a turn:** It settled into a stagnant "A" but then vanished when a trailing synthetic/continuation message was appended; it's now anchored to the last assistant message and stays put.
- **Core token-pool stop no longer cascades into an error:** Hitting the pool mid-task previously let the agent loop fire one more request that returned empty (`AI_NoOutputGeneratedError`, surfaced as an unhandled rejection). The unified `runAgentTurn` loop now hard-stops on abort (outer turn loop **and** inner continuation loop) and takes the clean partial-save path.
- **Core context window no longer over-pruned on the first turn:** Before the first token was captured, Core dispatches budgeted against a blanket 200K; they now use the underlying tier model's real window (e.g. 1M for Core 3) from the warmed OpenRouter catalog, so the opening turn isn't needlessly truncated.
- **Login is required before opening a workspace:** enforced both in the UI (sign-in prompt) and the backend (`sessions:start`/`sessions:create`).
- **Folder/file tools emit plain text:** removed emojis from the folder layout, project-structure, `list_files`, `get_file_outline`, and `read_file` tool output (legacy parsing of older results preserved).

### Changed (v12.5)

- **Compass budget diagnostics:** preflight now logs `tier / monthlyLimit / used / remaining`, and a mid-task stop logs its cause (`rpc-limit_exceeded` vs local tally) — to surface a metering-vs-displayed-budget mismatch. **Known follow-up (server-side, not in this release):** the Supabase usage RPCs must report the correct monthly limit for paid plans so a workforce account isn't metered at a free-tier cap (see `docs/compass-limits.md`).
- **Schema:** added `session_messages.status` (`complete` | `interrupted`) via an idempotent boot migration.

---

## [12.0.0] — Unreleased (pending manual test): The engine release — one agent loop, native tool history, verified edits, background agents

> Everything since 10.1.0 ships as one release: the v12 core-loop rewrite (22 build sessions) plus the v11 feature batch (in-app browser, WebMCP, Atlarix Core, document readers) that was never tagged separately.

### Added (v12)

- **One unified agent engine:** Every mode (Explore/Plan/Build/Debug/Review) now runs the same `runAgentTurn` loop. The four divergent per-mode loops — each with its own abort, compaction, and permission quirks — are gone; cross-cutting fixes land once and apply everywhere. Found and fixed along the way: the plan-writing tools were never actually offered in Plan mode, loop-detection corrections never reached the model mid-round, and approving `run_tests` silently executed the wrong operation.
- **Native tool-call history:** Tool calls and results are carried as real provider-native blocks instead of being flattened to text. Weak and local models perform dramatically better (providers train on native tool formats), prompt caching holds across multi-step turns (the history is byte-stable round to round), and `browser_screenshot` is finally *visible* to vision models instead of arriving as base64 text.
- **Edit verification in the loop:** After each round's writes, LSP diagnostics on the touched files feed straight back to the model — and a turn can no longer claim completion on top of broken code (`enableAutoFixProblems` now actually does this; it was a dead toggle). Failed `edit_file` matches return the closest-candidate region with explicit re-read guidance instead of a bare error.
- **Per-model capability profiles:** Known-strong models get the full ~38-tool surface; clearly weak/local models get a trimmed, core-first set with simplified schemas — so a 7B model isn't handed an orchestration surface it can't drive. Tool resolution is one documented 4-stage pipeline assembled in exactly one place, with the per-mode offered surface pinned by an exact-list eval.
- **Portable permissions + hooks:** `.atlarix/permissions.json` (committable deny/ask rules, Claude-Code-style `tool(glob)` patterns) is enforced for every tool path at the single execution funnel, and a global `~/.atlarix/permissions.json` layer merges beneath the workspace file. File-based `.atlarix/hooks/hooks.json` adds blocking `pre_tool_use`, advisory `post_tool_use`, and a `stop` gate that can hold `task_complete` until your check passes.
- **User-defined agents:** Drop `.atlarix/agents/<name>.md` (system prompt + mode + optional model/tool allowlist) into a repo and it appears in the mode picker. Committable — your team shares them with the code.
- **Background agents:** Spawn detached agents that run a full turn into their own session — read-only by default, or write-capable with auto-approved writes captured by shadow-git and an explicit **keep/revert** review of the aggregate diff. Status, cancel, and the keep/revert gate live in a new Agents panel tab (which auto-surfaces when an agent starts) and survive app restarts.
- **BYOK cost estimate:** Each turn on a BYOK provider shows an estimated USD cost (provider pricing or a maintained static table; never a guessed number).
- **Blueprint v2:** Aliased imports (`tsconfig` paths/baseUrl, package `#imports`) now resolve to real cross-module edges; slices are relevance-ranked (BM25 over symbols fused with graph centrality) with ctags signatures inline; dynamic/member call sites are *disclosed* ("connectivity under-reported by ~N sites") instead of silently dropped; dense small-module codebases (idiomatic Python) no longer degrade to file-tree fallback. Measured baseline on a ground-truth fixture: **get_blueprint precision@1 = 100%** across exact/fuzzy/structural/Python query categories vs 45% for raw lexical search.
- **Faster first token:** The pre-flight pipeline (usage check, model client, context loads) is instrumented end-to-end (`[perf] preflight-breakdown`) and parallelized — network round-trips overlap, the six context-section loads run concurrently (wall-clock = slowest load, not the sum).
- **Agent-eval test harness:** 55 behavioral evals drive the REAL chat engine against a scripted in-process LLM server with a real temp database — the safety net the entire rewrite shipped on.

### Changed (v12)

- **Legacy DB hooks retired:** The old Settings-page hooks (database rows, advisory-only, `before/after_file_write` triggers) are removed. **Migrate to `.atlarix/hooks/hooks.json`** — the file-based hooks are committable, support blocking denial, and run at the tool funnel where they can't be bypassed. The Settings page now points at the file format.
- **`find_file` respects the secret denylist:** Glob results no longer enumerate `.env*`/key/credential filenames (read tools were already gated; listing names leaked their existence).
- **Messages have one store of record:** Session DB rows carry the id everywhere (`sessionRowId`); the fragile ordinal-mapping edit path is deleted. Editing a message can no longer silently diverge from what's persisted.
- **`agent` chat mode folded into Build:** The vestigial third path double-dispatched every turn and skipped workspace injection; persisted selections coerce automatically.

### Fixed (v12)

- Approving a `run_tests` permission executed a bogus operation (the legacy text marker was misparsed) — it now runs through the normal command path.
- Loop-detection guidance reaches the model mid-round via `prepareStep` injection (previously only the third-strike abort worked).
- Background write-agents keep their keep/revert capability across app restarts (the snapshot reference was in-memory only).
- The Agents panel tab was unreachable (never added to the tab list) — fixed, plus auto-surface on agent start.
- A runaway model calling tools in a loop is aborted mid-stream (the guard previously waited for a round boundary that never came).
- Generic-named symbols (`handle`, `process`, `get`…) no longer dominate Blueprint relevance ranking over contextual matches.

---

## v11.0.0 work — included in 12.0.0 above (never tagged separately): In-app browser, WebMCP, Atlarix Core, document readers, much lighter app

### Added (v11)

- **In-app browser (WebContentsView):** New **Browser** tab in the right panel — a real Chromium surface (immune to X-Frame-Options, unlike iframes) with tabs, URL bar, and back/forward. Security-first: isolated `persist:atlarix-browser` session (browsing cookies never touch the app), `sandbox: true` + dedicated minimal preload, http(s)-only navigation, popups/downloads/camera/mic/geolocation denied by default. The agent can drive it too: `browser_navigate`, `browser_read_page`, `browser_screenshot` in every work mode; `browser_click` / `browser_fill` in Build and Fix. All page text and screenshots reach the model wrapped in an untrusted-content envelope that discloses the origin.
- **WebMCP support:** Pages opened in the in-app browser that register tools via the W3C draft **`navigator.modelContext`** API (WebMCP) expose them to the model — in **all modes** — through `list_webmcp_tools` / `call_webmcp_tool`. Atlarix shims the API via the browser preload (Chromium doesn't ship it yet): tool *metadata* relays to the main process while `execute` stays in the page, invoked over IPC with a 20s timeout so a hostile page can never hang a turn. Tools clear on navigation; names, descriptions, and outputs are treated as untrusted page-authored content. Demo fixture: `e2e-tests/fixtures/webmcp-demo.html`.
- **Document readers:** `read_attachment` now extracts **.pptx** (per-slide text), **.odt**, **.rtf** (in-house stripper, zero deps), and **structured .csv** — alongside the existing pdf/docx/xlsx. Spreadsheets and CSVs render a proper **table card** in chat (headers + rows, truncation note); CSV/xlsx parsing share one engine (the existing `xlsx` package; pptx/odt unzip via the ~10KB `fflate`).

- **ask_user ends the turn (Claude Code-style):** Asking the user question(s) now **ends the assistant's turn** instead of holding the stream open behind a 30-minute timeout. The model is instructed to batch ALL its questions into one call up front; the turn persists with the question card embedded (survives app restarts via an `atlarix-questions` content artifact), the UI returns to idle, and the user can answer the card **or just type something else**. Answers become a real `Q → A` user message and a continuation stream picks the task back up — token-free waiting, no timeout machinery (`user_question_wait.ts` deleted), follow-up questions work naturally as new exchanges.
- **Context-overflow self-recovery:** When a provider rejects a dispatch with "context length exceeded" (any provider's wording), Atlarix now lowers its cached window estimate for that model (compounding 15% clamp, 40% floor), force-compacts the conversation, and **retries the dispatch once** — instead of just surfacing the error.
- **Durable compaction summaries:** Compaction summaries are persisted to the workspace session and the model history is sliced from the **last summary marker** at dispatch — reloading the app no longer re-expands the full history (which used to re-overflow and redo summarization). The UI keeps full scrollback.
- **Real local-model context windows:** Ollama (`/api/show` → `context_length`) and LM Studio (`/api/v0/models` → `max_context_length`) are queried (cached, 3s timeout, offline-safe fallback) instead of the old hardcoded 8192/16384 guesses — compaction now triggers at the *right* fill level for local models.

### Changed (v11)

- **Compass → Atlarix Core (4 models, token-metered, no tier gating):** The three plan-gated Compass tiers (fast/balanced/thinking) are now four **Core** slots — **Core 1–4** (`ATLARIX_CORE_MODEL_1..4` build-time env, OpenRouter-backed; see `.env.example`). **Every plan can use every Core model**; access is governed strictly by the monthly token pool in Supabase (`compass_tokens` — table, RPCs, limits, 30-day reset, and upgrade flow all unchanged; limits are read from Supabase, never hardcoded). The plan-coercion/filtering code is deleted. Legacy `compass-*` model ids keep resolving forever (alias map) and persisted selections normalize to `core-N` on settings load. Release workflow falls back to the old `COMPASS_MODEL_*` secrets until the new `ATLARIX_CORE_MODEL_*` secrets are set.
- **Strict mid-task token enforcement:** Core usage is now recorded **per agent step** (awaited at each step boundary) instead of fire-and-forget at stream end — which also fixes an undercount where only the final step of a multi-step turn was metered. When the pool runs out, the running turn **stops immediately mid-task**: the stream aborts, the partial response is saved with a "monthly Core token limit reached" note, and the upgrade message is shown. The Supabase RPC stays authoritative (concurrent devices, resets); a local remaining-budget tally is the fast same-step guard. Transient network/RPC errors never hard-stop a turn.
- **System git instead of bundled git:** `dugite` (142MB of bundled git binaries) is gone; git operations shell out to the system `git` via a drop-in `exec` adapter (`system_git_exec.ts`). When git isn't installed, features degrade with an actionable message (`xcode-select --install` on macOS). E2E/bundled-git escape hatch (`LOCAL_GIT_DIRECTORY`) still honored.

### Fixed (v11)

- **Stream-error banner placement:** failure/Retry/Dismiss UI now renders pinned **just above the chat input** (aligned with the slow-stream warning) instead of at the top of the page where it scrolled out of view.
- **Compaction undercount guards:** skip re-summarizing a head that is only the previous summary; cap runaway summaries at 25% of budget.
- Dead code: post-turn compaction scheduler (early-returned for every real chat and read a removed table), `if(false)` pre-injection blocks (project memory, Supabase schema, diagram-first prefix), ask_user freeze-baseline atom, `getSupabaseContext`, `buildProjectMemoryPromptBlock`, `supabase_schema_query.ts`.

- **The real reason the app was 1.28GB:** the `packageAfterPrune` hook's `npm install <externals>` reconciled the **entire** app dependency tree from the staged `package.json` — *after* the package-removal loops — so dugite (140MB), next + @next/swc (194MB), echarts, lucide-react, playwright-core, jsdom and friends shipped in the asar despite every ignore/remove rule (asar: **848MB**). The staged `package.json` is now rewritten to the runtime-external allowlist before any install, so no npm invocation can resolve the full tree into the package again. Plus: vestigial 64MB nested `typescript` stripped from `vscode-langservers-extracted` (none of its bundled language servers require it).
- **`docs/compass-limits.md`** referenced a "no direct writes" migration that never existed; a real hardening migration (`20260605120000`) now REVOKEs direct `INSERT/UPDATE/DELETE` on `compass_tokens` (writes only via the SECURITY DEFINER RPCs).

### Removed (v11)

- `geist` npm package (pulled in `next`/`@next`, ~284MB of install weight, for six font files) — Geist Sans/Mono now vendored as woff2 (~172KB) in `src/assets/fonts`.
- Dead code: `filterCompassModelsForPlan`/`coerceCompassModelForPlan` tier gating, `signal-sets.ts`, ~30 unused exports, 59 unused exported types, 12 redundant default exports, assorted orphaned helpers (knip-driven sweep; config tightened so regressions surface).

### Fixed

- **CI npm 401 (CodeArtifact lockfile):** Added project [`.npmrc`](../.npmrc) (public registry), [`scripts/verify-npm-lock-registry.mjs`](../scripts/verify-npm-lock-registry.mjs) (`npm run verify:lockfile`), and pre-`npm ci` lockfile checks so `package-lock.json` cannot ship private-registry `resolved` URLs again.

### Changed

- **Single CI workflow:** Merged the former Quality and Release workflows into one [**Atlarix CI**](../.github/workflows/release.yml) — typecheck, lint, and tests on `main`/PR; tag pushes run quality first, then macOS/Linux/Windows release builds.

---

## [10.1.0] (2026-06-04) — Inline streaming indicator, native web search, prompt caching, interactive questions, lighter app

### Added (v10.1)

- **Inline streaming indicator:** The full-width "Working…" strip below the chat is gone. A **small compass loops under the current assistant response only** while the agent works, then **settles into a stagnant "A"** when the turn completes — with a human-readable one-liner of what's happening right now ("Writing src/auth.ts…", "Consulting multiple models…", "mapping out structure"). Tool labels are argument-aware (file paths, queries, commands). Live command output is still available from a compact "Show output" expander on the status line.
- **Provider-native web search:** When the active model's provider ships built-in search — **Anthropic** `web_search`, **OpenAI** Responses `web_search_preview` (gpt-4o/4.1/5), **Gemini 2+** grounding, **OpenRouter** web plugin (BYOK) — Atlarix passes the provider tool at dispatch instead of the client-side `web_search`. Results and citations come back inline in the same stream and feed the existing citation chips. The client-side `web_search` (SearxNG → public SearxNG → DDG) remains the universal fallback for Ollama, LM Studio, Groq, and Atlarix Core.
- **Prompt caching:** Dispatches are cache-friendly — the stable system header (tools + identity + mode bundle) carries an Anthropic `cache_control` breakpoint, a second breakpoint on the previous exchange caches the growing history incrementally, and the per-turn tail (now day-stable: date without clock time) lives outside the cached prefix. Repeat turns on Anthropic BYOK bill cached input at ~10% of the normal rate; cache reads/writes are logged per round (`[prompt-cache]`).
- **Cmd/Ctrl+P quick file open:** Fuzzy file opener for the current workspace (basename matches rank first); selecting a file opens it in the right-panel Code tab. Reuses the Code tab's file query — no extra scans.
- **Terminal scrollback persistence:** User terminal tabs survive app restarts — tab list + buffers persist to disk, and PTY scrollback is restored above the new shell's prompt (xterm `SerializeAddon`). Tab labels track the shell's **live cwd** (OSC 7/1337).
- **MCP marketplace polish:** OAuth servers connect with **one click** (no dialog when there's nothing to fill in), curated **category** filter + **install counts** when the registry provides them, and the first-run wizard links straight to the marketplace.
- **Renderer test suite:** New jsdom vitest project (`src/__tests__/renderer/`) with a scriptable fake `IpcClient` harness — component tests covering the inline indicator, stream tool cards, Cmd+P, the first-run wizard, the legacy `/chat` indicator, and inline citations run alongside the existing suite.
- **Native-search citations are reload-stable:** Provider-executed search results (`source` stream parts from Anthropic/Gemini, plus Gemini `groundingMetadata`) are captured at stream end into a hidden `<atlarix-sources>` content tag — citation chips render live **and** survive app restarts / session reloads, deduped against client `web_search` sources.
- **Tool-output token budgets:** Tool results over ~6,000 estimated tokens spill to disk and the model receives a **head + tail** preview (~1,500 + 500 tokens with an omitted-range marker) instead of the old 2,000-char head-only cut — exit codes, error summaries, and final test results stay visible, with the `read_file`-the-spill-file hint unchanged.
- **Perf groundwork:** `WorkspaceFileTree` is virtualized (10k+ file repos no longer mount a DOM node per file), the ctags symbol index refreshes **incrementally** from per-file mtimes instead of re-tagging the whole repo on every commit change, and `[perf]` log marks measure workspace-open → first-prompt latency.

### Fixed (v10.1)

- **Stream no longer dies while sub-agents work:** The 45-second stall watchdog treated locally-executing tools (sub-agent delegations, long commands, a pending ask_user) as a dead stream — a 2-minute Explore delegation reliably ended in "The model stopped responding mid-stream" even though the sub-agent finished fine. The watchdog now suspends while a tool call is in flight (tools enforce their own timeouts) and still fires when the **model** itself goes silent.
- **Sub-agent panel honesty:** tool results no longer masquerade as "Thoughts" and tool rows no longer show raw JSON. Read results summarize to one line ("Read spacinsider-api/bitbucket-pipelines.yml — lines 1-272 (complete)"), failure envelopes summarize as "Reading files: file_not_found (api/README.md)", and sub-agent progress lines are labeled **Activity** (they're tool status, not model reasoning).
- **`ask_user` never showed the question (all modes):** Two stacked bugs. (1) `ToolRegistry.execute` wraps tool results in a `{ success, result }` envelope, and the ask_user pause marker was **nested inside it** — every stream path's interceptor checked the top level, found nothing, and handed the raw marker JSON to the model, which then invented answers you never gave. The marker now escapes the envelope (same contract as permission requests), with a defensive nested-unwrap in the interceptor. (2) The agent-mode path additionally lacked the interceptor entirely. The stream now genuinely **blocks** until you answer (30-min timeout) and the tool card expand shows the **question(s) + your answers** instead of "Done". Also fixed the display freeze while a question is pending (the baseline was cleared instead of captured, letting speculative text leak through).
- **ask_user redesigned as an inline question card:** Questions now render **inline in the chat thread** under the current response (not a bar above the input) — and one ask_user call can carry **up to 5 questions** (each with up to 4 options + a free-text "something else" field). Single questions submit on option click; batches show per-question selection with one **Submit answers** button that unlocks when everything's answered, and the model resumes with a readable combined `Q → A` transcript. Prompt guidance tells models to batch related questions into one call.
- **Duplicate "Untitled" sessions on every app reopen:** Opening a workspace always inserted a fresh session — six reopens a day meant six empty "Untitled" rows in the sidebar. `startWorkspaceSession` now **reuses** the newest default-titled empty session and **prunes** the stale empty backlog (sessions with messages or custom titles are never touched). Applies to app reopen, CLI open, and repeated "New chat" clicks alike.
- **Code tab FILES column was empty:** `get-app` returned a hardcoded empty file list and the Code tab preferred it over its own working query. The Code tab and the full-screen code page now read the `getAppFiles` query directly. (The sidebar tree worked because it already did.)
- **Lemon webhook misclassification:** If `LEMONSQUEEZY_WORKFORCE_VARIANT_ID` was unset, Workforce subscribers were silently classified as Pro. The webhook now fails loudly (500) so Lemon retries after the env is fixed.

### Changed (v10.1)

- **Sidebar simplified:** The **Files tab under the workspace name is gone** — the sidebar shows Sessions only. Files live in the right-panel Code tab and the new Cmd/Ctrl+P opener.
- **Streaming indicator everywhere:** The inline compass covers every work mode (Explore/Plan/Build/Debug/Review share one chat pipeline with mode-aware idle labels), and the legacy `/chat` page's old purple pulse dot was swapped for the same compass.
- **Security hardening deployed:** The v10.1 RLS migration and the hardened Lemon Squeezy webhook are **live** on the production Supabase project (migration parity verified; webhook rejects bad signatures with 401).
- **System prompt slimmed:** Deduplicated the Ask/Build discovery-flow prose, tightened the web-research and `task_complete` blocks, and deleted two unused prompt builders — a few hundred tokens off every dispatch (and a smaller, more stable cache prefix).
- **Supabase hardening:** New migration — team members can **leave a team** and invitees can **decline pending invites** (self-service DELETE), invite policies read the email from the JWT claim (no per-row users subquery), `users.team_id` gets a defense-in-depth WITH CHECK, and `record_compass_usage` now has a per-call sanity cap plus a 60-calls/minute rate limit.

### Removed (v10.1)

- **Legacy single-command terminal input:** User tabs are PTY-only; the `enablePtyTerminal` kill-switch now hard-disables the terminal instead of falling back to the old input box. Agent tabs (read-only captured output) are unchanged.
- **Pre-v10 `.bak` snapshot revert fallback:** Turns captured before the shadow-git store (v10.0) can no longer be reverted. Shadow-git turns are unaffected.
- **Dead weight (~28 dependencies + dead subsystems):** Removed zero-import packages (konva, react-konva, framer-motion, perfect-freehand, ml-distance, @mozilla/readability, html-to-image, react-zoom-pan-pinch, openai, pdf-parse, three @opentelemetry packages, lexical×3, and more), replaced `bad-words` with an in-house wordlist and `node-fetch` with the native global fetch, and deleted the never-invoked pivot-analysis subsystem (Sonar/Semgrep/SCIP), the dead legacy ChatInput/Lexical chat-input chain (+9 orphaned components/hooks), 16 unused atoms, and dead token-usage helpers. `npx knip` now runs clean on files and dependencies.
- **Dead-export sweep (≈220 symbols):** Every knip-flagged export with zero usage anywhere (the config treats in-file usage as live) was deleted, cascading into the long-dead legacy `AtlarixMarkdownParser` main component (~400 lines — live chat renders via `AtlarixMarkdownSegment`/`VanillaMarkdownParser`), `ThinkingSection`, `PlanCard`/`PlanSection`, and `FixAllErrorsButton`. Remaining flags sit only in intentionally-kept contract surfaces (zod schemas, IPC boundary types, the shadcn UI kit).

---

## [10.0.0] (2026-06-04) — Interactive terminal, live plan progress, per-hunk approvals, memory.md

### Added (v10.0)

- **Interactive PTY terminal:** User terminal tabs are now real shells (xterm.js + node-pty) — native **Tab completion**, arrow keys, colors, and interactive apps (vim, top) all work. Login shell loads your rc files; scrollback survives tab switches and panel toggles (session-only); closing a tab or quitting the app kills its shell. Agent command tabs stay on the read-only captured-output view (permissions/timeouts unchanged). Per-instance fallback to the single-command input if PTY spawn fails; `enablePtyTerminal` settings kill-switch.
- **Clickable terminal links:** URLs in the terminal are clickable — `localhost`/dev-server links open in the **Preview tab**, everything else opens in your **browser** (Cmd/Ctrl+click forces the browser for both).
- **Live plan step progress:** While building a plan, checklist steps flip `[ ]` → `[~]` (in progress) → `[x]` live on the plan card and in the Plan panel — new `update_plan_step` tool (by step index or text), Build-mode prompt guidance, and a safety net that closes remaining steps when the plan flips to built. Steps render with per-step icons and an `n/m done` counter.
- **Per-hunk diff accept/reject:** Inline file approvals now use real LCS hunks (multiple change regions render separately, via the `diff` package) with a checkbox per hunk — approve only the hunks you want; Atlarix composes and writes the partial file. The bulk bar shows a running "X of Y hunks selected" summary across multi-file change sets. `delete_file`/`rename_file` stay file-level.
- **`.atlarix/memory.md` (project knowledge file):** The agent can create and maintain a durable project-facts file (tech stack, architecture, layout) so future sessions skip full re-scans. Never auto-injected — the prompt carries a one-line hint (size + updated date) and the model reads it with `read_file` only when useful, updating it when durable facts change (e.g. payments PayPal → Stripe). Plan mode may write `.atlarix/atlarix.md` and `.atlarix/memory.md`. Auto-memory turn notes now append here too (previous `.atlarix/ATLARIX.md` notes were silently archived by the legacy migration — fixed).
- **First-run setup wizard:** New skippable 4-step wizard (welcome → providers/keys detection + Atlarix Core sign-in state → default model → open first workspace) replaces the legacy 5-step onboarding overlay. State lives in settings (`firstRunWizardCompleted`); existing users are migrated silently and never see it. The in-app Shepherd tour copy was refreshed (Explore naming, Shift+Tab, inline approvals, Cmd/Ctrl+B).
- **Context meter details:** The token bar tooltip now shows what was **pruned/trimmed at last dispatch** (per-section context assembly report) and **sub-agent/background tokens** from the last turn. Finished tool cards show an elapsed-time suffix (e.g. `(3.2s)`).
- **Commits attributed to the model:** Agent git commits are authored as `"<Model> agent" <agent@atlarix.dev>` (e.g. `DeepSeek V4 agent`) — prompt guidance plus automatic `-c user.name/user.email` injection on bare `git commit`, never touching your git config. Internal app commits stay `atlarix-agent`; the co-author trailer is unchanged.

### Changed (v10.0)

- **Token accounting is turn-accurate:** Sub-agent delegations and mid-loop compaction now record their `generateText` usage into the turn's totals — Atlarix Core (Compass) metering includes them, and `chat:response:end` carries `auxTokens` for the UI. Previously sub-agent tokens were invisible everywhere.
- **Snapshots → shadow git:** Per-turn revert snapshots moved from full file copies under `.atlarix/snapshots/` (no dedup, no pruning) to a hidden git repository per workspace under app data — content-addressed (deduped), auto-pruned after 14 days, 5 MB/file cap, and never touching your repo's `.git`. Files created during a turn are now **deleted** on revert (previously restored as empty). Old-style snapshot turns still revert via a legacy fallback.
- **Modes are fully isolated:** Every-mode tools (`ask_user`, `compress_context`, `read_attachment`, `list_attachments`, `web_search`, `deep_research`) are now in every mode's allowlist + execute gate (Plan/Debug/Review were missing several). Streams can never render the legacy all-modes block; consistency tests assert no cross-mode leakage and exact registry/prompt parity.
- **Actionable tool errors:** Every tool failure the model sees now answers "what happened + what to try next" — per-tool recovery hints merged at the registry layer (`suggestion` field), plus rewritten worst offenders (run_command timeout explains `timeout_ms`, permission denial says don't-retry/ask_user, find_file suggests broader globs/search).
- **Diff quality:** `SmartDiffView` switched from a prefix/suffix diff (one giant change region) to real LCS hunks — long files with changes at top and bottom no longer show the whole middle as changed.

### Removed (v10.0)

- **Right-panel Diff tab** (and the vestigial `file-diff` panel type): it only showed a placeholder — all diffs and approvals render inline in chat.
- **Legacy 5-step onboarding overlay** (`OnboardingProgressBar`, `OnboardingTrigger`, `lib/onboarding.ts`, `onboardingStepAtom`) — replaced by the first-run wizard + refreshed tour.

### Also shipping in 10.0.0 — quality batch (previously tracked as Unreleased)

### Added

- **MCP auth-and-retry:** When the agent calls an MCP tool that isn't authenticated — OAuth *or* API key / env — it now pauses, prompts the user to **Connect** (OAuth) or **Configure** (key/env), waits for them to authenticate (5-min timeout), then automatically retries the call. Auth failures are classified (`McpNeedsAuthError`: missing key, 401/403 invalid, OAuth needed); the MCP tool card shows an inline **Sign in / Configure** button (`mcp_auth` view). Built on the proven pending-map + timeout pattern (`waitForMcpAuth`), so the stream never hangs.
- **Copy & open affordances on tool cards:** Result bodies (reads, MCP results, command output, generic text) have a copy-to-clipboard button with "copied" feedback and a **Show full** toggle for long output; diff and read cards have an **Open in editor** action that opens the file in the Code tab.
- **Keyboard shortcuts:** **Cmd/Ctrl+B** toggles the right panel (everyone, works while typing); **Shift+Tab** cycles the work mode Explore → Plan → Build → Debug → Review in workspace chats (with a mode toast; ignored while typing). Pro-only Cmd+I / Cmd+O panel shortcuts unchanged.
- **Plan-artifact lifecycle is AI-driven:** the active session plan injected into Plan/Build turns now carries its `planId` + status with an explicit instruction to call `update_plan_status(planId, "building" | "built")`; Build-mode prompts reinforce it. Safety net: a Build turn that wrote files and finished cleanly auto-marks the session's "building" plan as **built** (and pushes the card update) if the model didn't. Plan cards no longer sit on "TBD" forever.
- **Quality gate:** `npm run check` (`check:ts` + `check:lint`), plus `.github/workflows/quality.yml` running tsc, oxlint, and the test suite as blocking checks with a report-only knip pass. knip config now resolves routes/aliases correctly and reports **zero unused files**.

### Removed

- **Legacy tag-rendered tool cards:** Deleted the unreachable `AtlarixToolResult`, `McpToolMessageCard`, `AtlarixMcpToolResult`, and `AtlarixMcpToolCall` components (and their `AtlarixMarkdownParser` cases). Tool tags are consumed into structured tool parts before markdown, so all tool rendering goes through the single `StreamToolCallCard` / `ToolExpandPanel` path.
- **Dead-code streamline (~100 files):** Removed ~100 unreferenced files (superseded UI components, dead hooks, orphaned `lib/` modules and unregistered IPC handlers, telemetry scaffolding, backups) plus two unwired extension dialogs — each batch verified by `tsc` + the full test suite + a reference grep (a dynamically-imported module surfaced this way was kept). Added `knip` (`npm run knip`) to catch dead code going forward.
- **Second dead-code sweep (knip-verified, ~100 more files):** With the `@/` alias + route globs fixed, knip's output became trustworthy and revealed another closed set of unreachable files: the legacy `ChatMessage`/`MessagesList`/`ChatHeader` chat chain (live chat renders via `SimpleMessage` → `AssistantMessageBody`), the gutted `FileDiffPanel` (returned only `InlinePermissionsHint` — permissions are inline in chat), the visual-editing/annotator toolbar suite, the old template browser, the `pivot`/`workflow-extractor`/`plugins` modules, a dozen orphaned hooks, and leftover test fixtures. Every file was double-verified dead via exact import-specifier graph (plus basename grep for dynamic imports) before deletion; suite green after each batch. `knip.json` now ignores only the vite-alias `src/shims/**`, so `npx knip` runs clean as a real dead-code gate.
- **Diagram subsystem removed entirely:** The legacy per-workspace diagram system — `DiagramManager`, diagram IPC handlers (`diagram:*`, `snapshots:diagram-timeline`/`revert-diagram`), the diagram refresh/staleness engine, the timeline tab + `DiagramTimeline` UI, the `update_diagram` permission op, diagram capture in workspace snapshots/revert (`diagram.md`), the diagram timeline in the memory tool, and the `diagrams`/`workspace_diagrams` table definitions (TS-only removal; the legacy SQLite tables remain inert in old DBs, no migration) — is gone. It was superseded by inline `visualize_graph` artifacts in chat (which stay); the remaining tendrils were dead weight (`workspace_diagrams` had no writers, `diagrams.id` reads were latent bugs — the table had no `id` column, staleness events had no UI). File/prompt/chat snapshot + revert keep working unchanged. Verified: 0 tsc errors, all 861 tests green.

### Fixed

- **Tool results visible in chat:** Tool cards now expand to show real results instead of only "done" — `list_available_mcps` and `mcp_call` render a server/tool list and result panel (new `mcp_servers` / `mcp_result` expand views), `web_search` shows clickable results, and file diffs / reads / command output expand as before. Works both live and when reopening a saved session (the persisted path and the live path both build through `buildToolExpandView`).
- **Live stream dropped tool results:** Tool completion on the `chat:activity` / `chat:tool:end` paths no longer discards the structured `resultText`/expand view (`StreamToolEndPayload` now carries `resultText` + `expand`; `finalizeToolItem` prefers the full result JSON over the "Done" detail).
- **In-chat links open the system browser:** Web-search result links (and any `target="_blank"` anchor / `window.open`) now open externally via a `setWindowOpenHandler` in `main.ts`, instead of spawning a blank Electron window.
- **Persisted counsel cards rehydrate:** Counsel thread items render on session reload (added the missing `case "counsel"` in `StreamThreadItemView`; previously fell through to `null`).
- **Failed tool cards auto-expand:** A tool that errors now opens its error detail by default instead of hiding it behind a click.
- **Light-mode diff counts:** Diff `+`/`-` line counts use theme-aware colors so they stay visible on light backgrounds.
- **Type/lint debt cleared to zero:** All 169 pre-existing tsc errors fixed (the final 48 fell with the diagram-subsystem removal) — real null-deref guards in the permission interceptor, corrected IPC-listener typings (preload strips the event), dependency-API drift (`OAuthDiscoveryState` moved modules, `NapiLang` removed upstream), stale test fixtures, references to the removed legacy `messages` table, and assorted prop/union drift. All 351 oxlint errors (~91% `no-unused-vars`) also swept to zero — including the write-only `SessionTracker` (recorded changes nothing ever read) and several dead helper clusters surfaced by the sweep. `npm run check` now passes clean: **0 tsc, 0 lint, 861/861 tests.**
- **Chat message edits persist:** Editing a user message in a saved session now writes to the `sessionMessages` DB (update + tail truncation), mapped by ordinal since ephemeral/persisted message ids don't correlate. Previously the edit only lived in the in-memory ephemeral chat and was lost on session switch.
- **In-chat MCP OAuth no longer opens a stray browser mid-turn:** When the agent calls an MCP tool whose token has expired, the runtime now refreshes silently or returns a clean "needs sign-in" result, instead of launching an interactive browser window (which dangled on a raw `127.0.0.1/callback` URL because no loopback was wired in that path). Interactive (re)authorization happens only via the explicit Connect flow. Added `interactive` flag to `AtlarixOAuthProvider` (agent path is non-interactive) and `McpInteractiveAuthRequiredError`. The loopback success page now auto-closes.

### Changed

- **Duplicate utilities consolidated:** one `extractDomain` (now in `lib/format-url.ts`, used by web tools + `MessageSources`; two other copies were dead and deleted), one `truncateToTokens` and one `truncateUtf8ByBytes` (new `lib/truncate.ts`, replacing identical copies in `ContextAssembler`, `context-budget-pruning`, `project-memory`, `tools/search`, and `tools/file` — call-site messages preserved via suffix options).
- **Descriptive tool summaries:** One-line tool summaries read "3 MCP servers · 12 tools", "github/search_issues", or "5 results" instead of the generic "Done" (the "Done" fallback is now last-resort only).
- **Tool-card consistency:** Unified the status icon/accent into a shared `ToolStatusIcon`, standardized tool-body max-height + text tokens across the expand panels, and added a `+N/−M` diff badge to write/edit card headers. `CollapsedScrollSection` now sets `aria-expanded`.
- **Shimmer status:** Running tool cards show a shimmering label (with a calm pulsing dot instead of a spinner); respects `prefers-reduced-motion`.

---

## [9.1.1] (2026-05-29) — Inline chat tools, permissions, build fixes

### Fixed

- **Workspace inline chat:** Tool cards and diffs render via IPC stream thread (not tag-only mode); `write_file` refreshes Code tab file tree mid-stream.
- **Long-task hint:** Amber banner after 3 minutes (5 minutes if the stream stalls) suggesting a faster provider/model.
- **Build / parse regressions:** Repaired corrupted merges in `schema.ts`, `permissions/handlers.ts`, `file.ts`, `layout.tsx`, `settings.tsx`, and `useRightPanelContext.ts`; restored missing `registerIpcHandlers` import in `main.ts`.
- **Mermaid mindmap:** Suppress incomplete streaming mindmap parse errors.

### Changed

- **Tool manifest:** Slim core-tool surface for native function calling; progressive load for extended tools.
- **Permissions:** Inline chat approvals; workspace command and file permission stores with Settings UI.

---

## [9.1.0] (2026-05-28) — Streamline, attachments, LSP

### Added

- **Workspace file permissions:** `workspace_file_permissions` table (per `app_id` + file / directory / extension scope); Settings UI with three rule tables; stream preflight auto-allow/deny before inline prompt; activity lines for auto-approved edits.
- **File approval scopes:** Inline cards offer Allow once, Always allow this file, Always allow parent directory, Always allow extension, and Deny (protected paths and deletes: Allow once / Deny only). Deletes never auto-approve from directory/extension rules.
- **Inline permission approvals:** File writes show `SmartDiffView` diffs in chat; `run_command` uses Allow once / Always allow (category) / Deny with dangerous-command checkbox. Bulk **Approve all files** / **Reject all** for multiple pending file ops.
- **Workspace terminal permissions:** `workspace_command_permissions` table (per `app_id` + command category); Settings UI to list, add, and revoke rules; auto-allow/deny before inline prompt with activity stream lines.
- **Sub-agent preview dialog:** `SubAgentRunCard` opens a maximize dialog for nested tool/thought activity (no inline accordion).
- **Web search in chat:** `web_search` tool cards expand inline with query + link list (`ToolSearchResultsExpand`).
- **Tool card expands:** Live stream passes `toolArgs` and full `resultText` for file diffs (`SmartDiffView`) and `run_command` terminal output.
- **Welcome launcher:** Free-tier workspace limit gate on open/clone; per-workspace delete; scrollable recents; Discord invite (top-right, `currentColor` icon).
- **Light compass palette:** `atlarix-animation-palette.ts` with `theme="auto"` on welcome compass.
- **Post-send attachment UI:** Pasted text, terminal snippets, and file/PDF attachments render as chips in user bubbles (not raw XML). `displayPrompt` / `modelContent` split so the model receives full bodies while the thread stays readable.
- **Attachment persistence:** `paste_attachments` and `file_attachments` columns (migrations `0052`–`0056`); `AttachmentStore` rehydrates across session reload.
- **Bundled LSP servers:** `typescript-language-server` and `vscode-langservers-extracted` (JSON/HTML/CSS) in app `node_modules`.

### Changed

- **GitHub clone:** Welcome and Import dialogs require a save folder before cloning (picker auto-opens); backend rejects clone without absolute `targetPath`; progress bar and cancel during clone. SQLite stores absolute paths only — repo files stay on disk (no silent `~/Documents/Atlarix` default).
- **OAuth env:** Device-flow client ID is `OAUTH_CLIENT_ID` (replaces legacy `GITHUB_CLIENT_ID`).
- **Mermaid guidance:** Flowchart-first prompts and sanitizer repairs for common label syntax issues; `sequenceDiagram` documented as fallback only.
- **Build mode prompt:** Application files belong at project root; `.atlarix/` is metadata/plan docs only.
- **Remove workspace:** Deleting a workspace under `~/atlarix-apps` or `~/Documents/Atlarix` also removes those files from disk.
- **Welcome launcher:** Wider layout on large displays (`max-w-4xl`); compass animation background follows light/dark palette (no dark box in light mode).
- **Permissions UX:** Removed right-panel permission queue, `autoApproveChanges`, and panel auto-open on permission requests. Approvals stay in the chat column (including while blocked waiting on approval).
- **Right panel:** Removed Web Search tab and layout “N sources” shortcut; search results live in chat tool expands.
- **Agent defaults:** Default `agentMode` is `direct`; removed Turbo **auto** provider from model picker; removed autonomous review panel and unwired Thoughts/Activity delegation panels.
- **Explore mode:** `removeAtlarixTags` preserves attachment bodies for read-only mode.
- **Self-correction:** LSP diagnostics via `collect-workspace-diagnostics.ts` and `self_correction_followup.ts`.
- **Workspace open:** File tree loads on demand; no automatic full-repo scan on load.

### Removed

- `get_diagram` agent tool (use `get_blueprint` + inline ` ```mermaid ` fences).
- `PermissionQueuePanel`, `InlinePermissionPrompts`, `AutoApproveSwitch`, `ThoughtsPanel`, `ActivityDisplay`, `AutonomousReviewPanel`.
- Right-panel **Search** tab for web results.

### Fixed

- **Sub-agent spill reads:** `read_file` allows absolute `atlarix-tool-outputs` paths before workspace path sanitization.
- **LSP init/spawn:** listen-before-initialize; registry paths and macOS PATH for external servers.
- **Welcome dark mode:** Outline button hover visibility.
- **Sentry noise:** Plan-limit, TextMate grammar stub, and OnigScanner look-behind tokenizer errors filtered or suppressed.
- **Workspace path:** Stream warns when resolved `appPath` is missing on disk.

### QA (9.1.0)

- Sub-agent: click card → dialog only; no inline expand.
- Clone: cannot start without folder; path absolute in DB.
- Sub-agent reads spill file after large tool output (no `path_not_allowed`).
- `web_search` expand shows links; no right-panel search tab.
- `write_file` / `run_command` cards expand with diff/terminal output.
- Mermaid flowchart fences render; sequence still works if model uses it.
- `get_diagram` unavailable; `get_blueprint` works.
- Device flow works with `OAUTH_CLIENT_ID` in `.env`.
- No uncaught OnigScanner errors during chat scroll.

---

## [9.0.0] (2026-05-28) — Welcome launcher hotfix

### Fixed

- **Welcome → Open folder:** `openWorkspaceFolder` no longer imports `node:path` in renderer code (fixes Vite externalized-module error when picking a directory).
- **Welcome UI:** Right-panel toggle and panel chrome hidden until a workspace is selected (`selectedAppId` set).

---
