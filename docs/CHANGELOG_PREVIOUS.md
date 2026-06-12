# Atlarix Changelog — Previous releases (before 13.0)

**Atlarix 13.0** and newer release notes are in [CHANGELOG.md](CHANGELOG.md).

Everything below covers **12.10.0 down through 8.0.x** and older entries archived from the main changelog.

## [12.10.0] (2026-06-09) — streaming-UI crash fixes + runtime Core models + project-check verification

### Added (v12.10)

- **Runtime Core-tier model config (no repackage).** The four Atlarix Core tiers (Core 1–4) now
  resolve their underlying model from a hosted `core-models.json` in the `atlarix-releases` repo,
  fetched and disk-cached at startup (and hourly), with the build-time env (`ATLARIX_CORE_MODEL_1..4`)
  as the fallback. Swapping a Core model is now a JSON edit, not a full app rebuild/re-sign/re-publish.
  New `src/ipc/shared/core-model-override-store.ts` (pure, renderer-safe) holds the map; new
  `src/lib/routing/core-model-overrides.ts` (main-process, mirrors the `models_dev.ts` fetch/cache
  pattern) fills it; `getOpenRouterModelIdForCoreTier` prefers the override over env so it propagates
  to every consumer from one edit; a `core-models:refresh` IPC forces a re-fetch. Secrets stay
  build-time (the public JSON carries model ids only).

### Changed (v12.10)

- **Build & Debug verify with the project's *own* tooling.** Both modes now instruct the agent to
  discover and run the project's real checks via `run_command` — its `package.json` scripts, else
  `tsc --noEmit`/`eslint`, `ruff`/`mypy`/`pytest`, `cargo`/`go`, with `node --check` /
  `python3 -m py_compile` as a syntax floor — and to **write tests for non-trivial logic** before
  `<task_complete>`. LSP diagnostics remain one input, not the only one, so verification works on the
  common case of a machine with no language server installed (`src/lib/tools/mode-prompt-bundle.ts`,
  `src/skills/modes/{build,debug}-mode.md`).

### Fixed (v12.10)

- **Renderer no longer crashes to the error boundary (React #185 "Maximum update depth exceeded") while a plan is showing.** The remaining infinite loop was in `useWorkspacePlanPanel.ts` (not the sidebar, as first suspected): `messages` was rebuilt with a fresh `.map()` on every render, so the "sync plan changes" effect (deps `[messages, …]`) ran after *every* render and its `setPanel(prev => ({ ...prev, changes }))` wrote a **new object reference** whenever a plan was open → re-render → fresh `messages` → effect re-fires → loop, triggered exactly on the `show-plan → get-proposal` path. Fixed by memoizing `messages` (keyed on the raw per-chat array) and equality-guarding the write (return the same object when `changes` is unchanged), reusing the JSON-equality pattern from the loop-safe `useProposal.ts`.
- **Accepted edit/write tool result cards no longer vanish.** A write/edit card was visible while the op ran but disappeared the instant the permission was accepted. In the interleaved-timeline branch, `ipcTimelineTailItems` (`AssistantMessageBody.tsx`) only kept tools with `status === "running"`, so a permission-interceptor op — which never gets a content-tag part — was dropped the moment it completed. It now shows tools not represented in the content parts regardless of running/done. Also broadened the frozen-view tail filter (`completedThreadTailItems`) so a completed card carrying its own `resultText`/expand isn't dropped when a matching part lacks a result.
- **Main process no longer files fatal `TypeError: Object has been destroyed` on quit.** `broadcastToAllWindows` (`broadcast_all_windows.ts`) guarded the *window* (`!isDestroyed()`) but then called `win.webContents.send(...)` — during teardown the webContents can already be gone while the window still reports alive, so the send threw. Now routed through `safeSend` (which checks `webContents.isDestroyed()/isCrashed()`) inside a try/catch, fixing the race for every broadcaster at once. These benign teardown races are also added to the Sentry ignore list as a safety net. (The `emitUserTags` frame in the Sentry report was a stale-source-map mislabel.)
- **TextMate tokenizer no longer floods the console/Sentry with `invalid pattern in look-behind`.** `onigasm@2.x` (old Oniguruma) rejects the variable-length look-behind patterns modern grammars use heavily (e.g. `python.json`), and `OnigScanner.findNextMatchSync` re-threw on every background-tokenized line (observed opening a Python workspace). The scanner is now wrapped at its source (`guard-onig-scanner.ts`, applied in `init-textmate.ts`) so a rejected pattern degrades to "no match" (those tokens just don't highlight) instead of throwing/retrying forever.

### Internal (v12.10)

- New derived `backgroundStreamingSessionIdsAtom` (`sessionAtoms.ts`) drives the session-list spinner from a membership-stable Set, so the sidebar stops re-rendering on every streaming tick (it previously subscribed to the whole `chatIdToSessionId` reverse map).
- **Lighter prompt loader.** Removed the runtime-unused full `AGENTS.md` — `AGENTS_COMPACT.md` + `AGENTS_MODE_BASE.md` are the authoritative bundles (the loader always preferred them; the full file only shipped as a fallback that never fired). Simplified `src/prompts/system_prompt.ts` and dropped it from `forge.config.ts` `extraResource`.
- Corrected the `.atlarix/plans/_index.md` scaffold text (`src/lib/plans/plan-manager.ts`): it now points at `.atlarix/atlarix.md` (durable project instructions) and `.atlarix/memory.md` (project knowledge) instead of the wrong, single `.atlarix/ATLARIX.md`.
- Aligned the `toolset-golden` plan surface with the intentional `run_command` exclusion from Plan mode (`mode-tool-registry.ts`). Added regression tests: plan-panel no-loop, mid-stream completed tool card, broadcast teardown guard, onig-scanner guard, runtime Core-model overrides, and the new Sentry ignore patterns.

---

## [12.9.7] (2026-06-09) — ask_user options render correctly + de-hardcoded context-window logic

### Fixed (v12.9.7)

- **Question options no longer render as `[object Object]`.** When a model emitted the Anthropic-native option shape (`options: [{ label, description }]` — observed with **minimax** over OpenRouter), the normalizer stringified each object to `"[object Object]"`, and the Set-dedup then collapsed them all to a single bogus choice. The question text itself was always fine — only the choices broke, and only for some models (deepseek's `{question, options:[strings]}` nesting worked, which is why it was inconsistent). `coerceStringArray` now extracts a label (`label ?? value ?? title ?? name ?? text ?? option`) from object options before stringifying. Hardened the normalizer further so it's model-agnostic: the question is resolved from alias fields (`question ?? prompt ?? text ?? header ?? title ?? label`), options also accept `answers`, and if a model ever sends choices with no question text we synthesize a generic title rather than letting the options leak into the headline.
- **Proposal token-usage % now uses the model's real context window.** `proposal_handlers.ts` hardcoded a `Math.min(getContextWindow(), 100_000)` cap — the only caller that clamped — which made the logged percentage wrong and fired the "summarize in a new chat" suggestion far too early for >100K-context models. It now uses the real per-model window (and passes `chatId` so Compass chats use their per-chat captured window). This is informational/suggestion-only; it never gated real dispatch.

### Internal (v12.9.7)

- **Modernized stale context-window heuristics** (`resolve-model-context-limit.ts`), the catalog-miss fallback that feeds compaction/budgeting: `deepseek` 16K→128K, `qwen` 32K→128K, `llama`/`mistral` 8K→128K, added `minimax`→1M, and raised the unlisted-model floor 16K→128K. These were wildly low for today's models (and for exactly the OpenRouter models in use); biasing slightly high is safe because the provider-overflow feedback loop self-corrects over-estimates, while under-estimates cause permanent premature compaction.
- **Unified the tier-limit fallbacks** (`tier-context-limits.ts`): the per-model-miss path used `100_000` while whole-fetch-failure used `200_000`; both now use a single generous `FALLBACK_LIMIT = 200_000`. Raised the delegation tier-limit fallback (`agent.ts`) 32K→128K (only used if model resolution throws). Real, live OpenRouter limits are unchanged.
- Compaction tuning knobs (compaction/prune/soft-cap thresholds, fill ratios, round/exchange counts) were audited and **intentionally left as-is** — they're co-tuned with per-step token enforcement.

---

## [12.9.6] (2026-06-09) — Terminal actually opens now (correct asar unpack key)

### Fixed (v12.9.6)

- **"Interactive shell unavailable: posix_spawnp failed" — fixed for real this time.** v12.9.5's fix added node-pty's `spawn-helper` to an `asarUnpack` array, but that's an **electron-builder** option — this app uses **electron-forge/electron-packager**, which ignores it (verified against the shipped 12.9.5 build: `spawn-helper` was still trapped inside `app.asar`). node-pty execs the helper from `app.asar.unpacked/.../spawn-helper`, which didn't exist → `posix_spawnp` ENOENT. Switched to the correct key, `packagerConfig.asar.unpack` (a minimatch glob that `AutoUnpackNativesPlugin` merges with `**/*.node`), so the `@lydell/node-pty-<platform>` dirs — including `spawn-helper` (and the Windows conpty/winpty binaries) — are unpacked to disk and code-signed. The interactive Terminal now launches in the installed app.

---

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

---

## [8.9.0] (2026-05-27) — Workspace-first product & release polish

### Breaking

- **No global chat:** Incognito / chat-without-folder removed. Open a workspace from the welcome screen to stream.
- **No global MCP/skills:** Deleted `scope=global` rows on upgrade (migration `0049`). Limits are **10 MCP** and **10 skills** per workspace only.
- **Prompt Library removed:** Custom workspace/global prompts and `@prompt` mentions removed. Use `.atlarix/atlarix.md` for project instructions (`0050_drop_prompts_table`).

### Welcome & open

- **Welcome launcher:** Hello + tier badge; **Open folder** and **Clone repo**; recent workspaces by last opened. (Remote SSH UI hidden until wired; backend stubs remain.)
- **Settings → MCP / Skills:** Scoped to the **active workspace** only (no cross-workspace list).
- **`openWorkspaceFolder`:** Unified import → session → ephemeral chat → IDE (`src/lib/open-workspace-session.ts`). CLI and sidebar use the same path.

### Sessions & windows

- **Background sessions:** `sessionIdToChatId` reuses chat transport when switching sessions; row spinner when a background session is streaming.
- **Multi-window (local):** `workspace-window-manager` focuses an existing window for the same folder path.

### Remote SSH (initial)

- Main-process `remote-ssh/` (config parse, connect stubs, IPC). `packages/atlarix-remote-server` health stub. Remote FS facade (`workspace-fs`) — full RPC in follow-up.

### Agents (prior unreleased)

- **Sub-agents (Explore & Review only):** Up to **5** readonly sub-agents per turn; batch paths via `scopes`. Plan, Build, and Debug no longer expose delegation tools.
- **Sub-agent UI:** Single **Sub-agents** round panel with per-scope cards (exploring / reviewing / …), nested thoughts and grouped tools; no duplicate “Research completed” handoff rows.
- **Grouped tool summaries:** Main and sub-agent streams batch tools by category (terminal, search, read/explore, web); handoffs use compact group digests.
- **Removed counsel & agent bus:** Multi-model counsel, agent bus, orchestrator, and parallel prefetch removed; sub-agent delegation replaces that workflow.
- **Tool permissions:** Always manual approval.

### Preview

- **Dev server:** No auto-start on workspace select; use **Start dev server** in preview or the workspace Preview tab.

### Attachments

- **Pasted text:** Compact file-style chip (click to open full preview dialog).

### Release polish (8.9.0)

- **Sub-agent labels:** Cards show scoped titles (e.g. `Mapping: repo`) instead of raw `delegation-*` ids; duplicate subtitle leak fixed in collapsed cards.
- **Code tab:** File tree loads via `getAppFiles` whenever a workspace is selected (no sidebar expand required).
- **Monaco:** Bundled `monaco-editor` + workers in the renderer for syntax highlighting in packaged Electron builds.
- **Vault UI removed:** Per-workspace Vault tab dropped; `.env.local` helpers remain for codegen/templates.
- **Onboarding & tour:** Updated for welcome launcher, workspace sessions, and right-panel tabs.
- **Tools page:** Workspace-first catalog; Explore & Review sub-agents; removed legacy delegation / vault copy.

---

## [8.8.0] (2026-05-26) — Plan artifacts, session titles, folder picker

### Plans

- **Session plan artifacts:** Plans are stored as SQLite rows (`session_messages` with `kind=plan`), not `.atlarix/ATLARIX_PLAN.md`. `write_implementation_plan` creates/updates DB rows; inline plan cards in chat; right Plan panel shows the last clicked artifact.
- **Status lifecycle:** `plan` → `building` → `built` on the DB row (Lucide badges in chat and panel).
- **Removed:** JSON task ledger sync to disk for plans (`task-state/**/ledger.json` creation disabled).

### Project memory

- **Canonical file:** [`.atlarix/atlarix.md`](src/lib/project-memory.ts) (migrated from workspace-root `atlarix.md` and `.atlarix/ATLARIX.md`). Plan mode may write this file; all modes read it.
- **Ignore file:** `.atlarix/.atlarixignore` (migrated from root `.atlarixignore`). Workspace open runs one-time bootstrap ([`workspace-bootstrap.ts`](src/lib/atlarix/workspace-bootstrap.ts)).

### Sessions

- **AI session titles:** After the first assistant reply, `sessions:generate-title` uses the summarization model on the first user + assistant exchange. Sessions stay `Untitled` until then (no more truncated first-message titles).

### Workspace UX

- **Add workspace:** `+` opens the native folder dialog immediately; recent workspaces via a clock popover ([`WorkspaceRecentsMenu.tsx`](src/components/workspace/WorkspaceRecentsMenu.tsx)).
- **Files tab:** `get-app` returns metadata only; file index loads via `get-app-files` when the sidebar Files tab expands.

---

## [8.7.5] (2026-05-24) — Polish & UX

### Packaging / IPC

- **Renderer IPC bridge:** Single listeners for `chat:auto-self-correct` and `apps:status-changed` ([`renderer-ipc-bridge.ts`](src/lib/renderer-ipc-bridge.ts)); stable `streamMessage` ref in layout.
- **Packaged logos:** `build.assetsInlineLimit: 0` so `?url` SVG imports emit real asset files in production.
- **Workspace delete:** Central client cleanup ([`workspace-delete-cleanup.ts`](src/lib/workspace-delete-cleanup.ts)); graceful `useLoadApp` when app is missing.
- **Auth:** Dedupe `plan-changed` fan-out in [`auth-ipc-bridge.ts`](src/lib/auth/auth-ipc-bridge.ts).
- **PDF:** Filter harmless pdf.js `TT: undefined function` warnings during extract.

### UX

- **Diagrams:** Removed saved-diagram auto-load on workspace open ([`useLoadApp.ts`](src/hooks/useLoadApp.ts)).
- **`get_diagram`:** Local on-demand generation only; no stale DB snapshot return ([`diagram.ts`](src/lib/tools/diagram.ts)).
- **Mermaid:** Spinner during stream; defer error overlay until stream completes ([`MermaidRenderer.tsx`](src/components/MermaidRenderer.tsx)).
- **Sessions:** Instant title from first user message; `<atlarix-chat-summary>` still upgrades when present ([`workspace-session-title.ts`](src/lib/workspace-session-title.ts)).

### Blueprint

- Routine blueprint / ast-grep **info** logs → **debug** (`lazy-parse.ts`, `run-structural-scan.ts`, `blueprint_handlers.ts`).
- **Windows packaging:** Stage grammars as `parser.so` (not `parser.dll`) to match `@ast-grep/lang-*` prebuild layout.

---

## [8.7.4] (2026-05-24) — Packaged ast-grep native binding hotfix

### Packaging

- **ast-grep natives:** Removed post-install `npm prune --omit=optional` that stripped `@ast-grep/napi-darwin-arm64` (and other platform bindings), restoring `app.asar.unpacked` native modules.
- **Grammars:** Stage Python/Go `parser.so` into `Resources/ast-grep-grammars` via `extraResource`; [`register-dynamic-langs.ts`](src/lib/blueprint/rte/ast-grep/register-dynamic-langs.ts) resolves extraResource first, then unpacked asar paths.
- **asarUnpack:** Broadened globs for `@ast-grep/napi-*`, `lang-python` / `lang-go`, and `astgrep_worker.js`; rebuild includes `@ast-grep/napi` and platform binding package.
- **Scripts:** `verify-astgrep-packaged` checks napi `.node` and grammar paths; `measure-package-size` streams asar list to avoid ENOBUFS; `npm run package:verify` runs package + verify + size report.

---

## [8.7.3] (2026-05-24) — Packaged Blueprint crash fix & smaller asar

### Blueprint — packaged ast-grep fix

- **Crash fix:** Unpack `@ast-grep/lang-python` / `lang-go` tree-sitter `parser.so` files to `app.asar.unpacked` so structural scans no longer panic with `GetLibPath: Not a directory` in production builds.
- **Dynamic langs:** Resolve grammar paths to real filesystem locations in [`register-dynamic-langs.ts`](src/lib/blueprint/rte/ast-grep/register-dynamic-langs.ts); skip Python/Go registration when parsers are missing (ctags-only fallback).
- **Worker pool:** Packaged `astgrep_worker.js` path resolution and safer worker error handling.

### Packaging

- **Source maps:** Disabled in production worker builds; strip `**/*.map` in `packageAfterPrune`.
- **Dev deps:** Denylist Playwright, TypeScript, ESLint, Vitest, etc. from release `node_modules`; `electron-playwright-helpers` moved to devDependencies.
- **Scripts:** `npm run verify-astgrep-packaged`; `measure-package-size` prints asar audit counts.

### UI

- **Logo:** Home and sign-in use bundled `assets/logo.svg` (fixes `file:///logo/...` load failures in packaged app).

---

## [8.7.2] (2026-05-24) — Stability & package size

### Blueprint — enforce section scope

- **`get_blueprint`:** Rejects workspace-root `focus_path` (`.` / `..`); returns section suggestions instead of parsing the entire repo.
- **Lazy parse:** `allowWorkspaceRoot` is opt-in only (UI refresh); agent tools cannot trigger full-workspace walks via `.`.
- **Timeout:** Shuts down the ast-grep worker pool when a section parse times out.

### Crash diagnostics

- **Main process:** Logs and Sentry breadcrumbs for `render-process-gone`, `child-process-gone` (GPU), and unresponsive windows.

### Renderer safety

- **Markmap:** Node cap and debounced render to avoid huge mind-map graphs in chat.
- **Mermaid:** Lazy-loaded in code blocks so the renderer bundle pays for it only when needed.

### Packaging

- **Smaller installs:** Omit bundled dugite git when system `git` is available (`ATLARIX_BUNDLE_GIT=1` or E2E to force bundle); exclude `scaffold/` and `*.map` from production asar; prune duplicate markmap/mermaid trees from packaged `node_modules`.
- **Scripts:** `npm run measure-package-size`, `npm run verify-renderer-bundle`.

---

## [8.7.0] (2026-05-24) — Section-scoped Blueprint

### Blueprint — section-first tool

- **`get_blueprint`:** Requires **`focus_path`** (workspace-relative folder). Preflight **`validateBlueprintFocusPath`** with Levenshtein **did-you-mean** suggestions on typos; **`success: false`** instead of misleading empty maps.
- **Cache:** Do not cache 0-room blueprints after parse; improved infer logging when scan root is missing or parse yields no visible rooms.

### Blueprint — slice layer

- **`blueprint-slice.ts`:** `resolveSliceParams` / `buildSliceWithResolve`; default **`scope: "full"`** for the section; auto-widen when a narrow slice would be empty.
- **`blueprint-markdown.ts`:** `emptyReason` distinguishes **`unparsed`**, **`slice_empty`**, and **`topic_filter`**.

### Blueprint — richness & hybrid merge

- **`blueprint-quality.ts`:** `assessBlueprintRichness`, `isThinRteNodeSet` gate file-tree backfill.
- **`blueprint-merge.ts`:** Richness-gated merge (replaces “skip merge whenever any ast-grep edge exists”).
- **`rte-supplement.ts`:** Hybrid supplement when ctags output is thin; engine type **`hybrid`**.
- **Tool output:** Tool-mode Markdown (`parseQuality`, `parseEngine`, compact exports per room); optional auto **`graph`** when thin.

### Agent guide & tests

- **Skill:** `src/skills/guides/blueprint-section-first.md` for agents.
- **Tests:** `blueprint-slice-scope`, `blueprint-quality`, `blueprint-merge-thin`, `blueprint-section-path`, `blueprint-markdown-toolmode`.

### UI

- **Tools page:** Removed unused **Diagram** filter tab; updated Blueprint feature cards and subtitle.

---

## [8.6.5] (2026-05-23) — Windows file-discovery path fix

### Fixes

- **`project-files`:** normalize paths returned by `fd` and `rg --files` to workspace-relative posix; the previous `path.relative(workspacePath, "src/app.ts")` resolved the relative argument against `process.cwd()` and produced cross-drive garbage on Windows runners (manifesting as `ctags-index` returning 0 symbols).
- **`ctags-index`:** validate that discovered paths actually exist under the workspace before running ctags; fall back to recursive scan when not.
- **`settings`:** create the `userData/` parent directory before seeding default settings (silences `ENOENT user-settings.json` noise in CI / headless tests).

---

## [8.6.4] (2026-05-23) — Windows ctags index fix

### Fixes

- **ctags-index:** when file discovery returns no paths (common on Windows CI temp fixtures), fall back to recursive scan before running ctags; normalize `-L` file list paths to forward slashes.
- **ctags-parse:** resolve Windows absolute/relative path shapes when matching ctags JSON `path` to workspace root.

### CI

- **ctags-index.test:** clear file-list cache between temp fixtures.

---

## [8.6.3] (2026-05-23) — Windows CI ripgrep

### CI

- **build-windows:** install ripgrep via Chocolatey before blueprint index benchmarks so file discovery uses `rg --files` instead of legacy recursive scan.

---

## [8.6.2] (2026-05-23) — Atlarix Core build embed fix

### Fixes

- **Atlarix Core “Not Setup” in release builds:** `compass_constants` now uses static `process.env.COMPASS_*` reads so Vite `define` embeds `COMPASS_OPENROUTER_API_KEY` and model IDs from CI secrets into the packaged main process (dynamic `process.env[name]` was never inlined).

---

## [8.6.1] (2026-05-23) — Packaging & release hotfix

### Fixes

- **Packaged app — ast-grep native binding:** `packageAfterPrune` no longer skips `@ast-grep/napi` platform optionalDependencies (`@ast-grep/napi-darwin-arm64`, etc.); fixes startup crash *Cannot find native binding* in production builds.
- **Release CI — Windows:** skip flaky `setup-node` npm cache on `windows-latest`; disable cancel-in-progress on same-tag release runs so retags do not abort `build-windows` mid-step.
- **Release CI — Discord:** forum-channel webhooks require `thread_name` on release announce payload.
- **Release CI — ctags-win32:** resolve Windows ctags download URL via GitHub releases API (correct `ctags-{version}-x64.zip` asset names).
- **ast-grep scan:** `findInFiles` no longer hangs when the native callback is skipped on zero matches.
- **CI:** `extract-changelog.sh` executable in repo.

---

## [8.6.0] (2026-05-22) — ctags + ast-grep Blueprint stack

### Features

- **Blueprint lazy-load:** `get_blueprint` / `inferBlueprint` now runs `generateBlueprint()` (Universal Ctags + ast-grep) on cache miss instead of file-tree-only seeding.
- **Route edges:** ast-grep scans Express/Fastify `app.get/post/…` and Next.js `export async function GET` handlers → `api_call` edges on the Blueprint graph.
- **Structural search BFS:** `search({ mode: "structural" })` walks blueprint `flowEdges` with configurable depth.
- **Auto search → BM25:** When `.atlarix/symbols.json` is warm, `mode: "auto"` upgrades concept queries to `semantic-graph` (BM25 over ctags).
- **ast-grep worker pool:** Structural scans run in dedicated workers (`astgrep_worker.js`); built on `npm install` / `npm start`; pool shuts down on app quit.
- **Bundled Universal Ctags:** `npm run fetch-ctags` for macOS/Linux/Windows (nightly download or Homebrew); CI fetches before release builds.
- **Incremental blueprint refresh:** `updateBlueprintCacheForFile()` + [`blueprint-file-watcher.ts`](../src/lib/blueprint/blueprint-file-watcher.ts) (500ms debounce) re-runs per-file ctags + ast-grep instead of a full-project rebuild.
- **Python/Go structural edges:** `@ast-grep/lang-python`, `@ast-grep/lang-go` registered via [`register-dynamic-langs.ts`](../src/lib/blueprint/rte/ast-grep/register-dynamic-langs.ts); import/call/route rules in worker pool.
- **Blast radius:** [`blast-radius.ts`](../src/lib/blueprint/blast-radius.ts) BFS over blueprint `flowEdges`; wired to `diagnose_issue` (`change_impact`) and permission metadata for `write_file` / `edit_file` via [`enrich-blast-radius.ts`](../src/lib/tools/permissions/enrich-blast-radius.ts).
- **Autonomous mode:** blast-radius enrichment skipped when auto-approve is active (`shouldAutoApprovePermissions`).

### Fixes

- **`edit_file` permissions:** added to permission schema + interceptor `executeOperation` (was `Unknown operation: edit_file`).
- **Dev/build:** repaired corrupted [`ToolsMcpSettings.tsx`](../src/components/settings/ToolsMcpSettings.tsx) and [`MarkmapRenderer.tsx`](../src/components/chat/MarkmapRenderer.tsx) merge damage.
- **Blueprint refresh:** removed erroneous `markSymbolIndexDirty()` after full refresh in [`blueprint_handlers.ts`](../src/ipc/handlers/blueprint_handlers.ts).

### Removed

- **oxc-parser** and per-language RTE parsers (TypeScript, Python, Go, Rust, …).
- **tree-sitter WASM** extraction path and parser worker pool.
- **`getStructureScan`** now uses ctags symbols via `structure-from-symbols.ts`.

### Tests / CI

- New tests: `blueprint-generate`, `ctags-index`, `bm25-ctags`, `structural-graph-query`, `ast-grep-import-edge`.
- Additional coverage: incremental ctags, blast-radius BFS, Python/Go ast-grep pattern tests (583 tests passing).
- Release CI runs `bench-blueprint-index.ts` instead of `bench-parsers.ts`.

---

## [8.5.2] (2026-05-21) — Agentic stream completion

### Fixes

- **Build agentic loop:** No longer ends the turn when the model replies with prose only; nudges continuation until `<task_complete>` or the task ledger is complete (prose-only safety cap: 5 rounds).
- **Completion signal:** Agentic completion uses explicit `<task_complete>` only (removed inferred “all done” / similar phrase matching).
- **Stream stall watchdog:** Removed the 60s pending-tool stall abort so long tool-heavy turns are not cut off mid-stream.
- **CI:** Fixed `processStreamChunks` try/catch brace after stall watchdog removal (esbuild parse error).

---

## [8.5.1] (2026-05-21) — Hotfix

### Fixes

- **App load crash:** Removed stale `setQuestionsByMessageId` from `useStreamChat` dependency array after `QuestionsWidget` removal (`ReferenceError` on startup).
- **Reasoning dedup:** `cleanFullResponse` now recognizes long-form `</think>` close tags (duplicate answer text after thinking blocks is trimmed again).

---

## [8.5.0] (2026-05-20) — Single ask path, terminals, sessions, packaging

### Features

- **One question UX:** Clarifying `<questions>` XML / `QuestionsWidget` removed; agents use **`ask_user`** only (`UserQuestionBar` in workspace and chat-only). Prompts direct models to `ask_user`, not inline question blocks.
- **Multi-terminal Activity panel:** You/Agent terminal instances per chat; output and draft input persist across tab switches until a new chat or close; AI can spawn multiple agent terminals.
- **Workspace sessions:** Sidebar session list + titles; chats tied to workspace sessions via [`ensure-workspace-session.ts`](../../src/lib/ensure-workspace-session.ts).
- **Right panel:** Diagram tab removed from default tabs (Activity/terminal focus); diagram content remains via tools/chat where applicable.

### Fixes / build

- **Renderer packaging:** [`vite/renderer-main-only-shims-plugin.ts`](../../vite/renderer-main-only-shims-plugin.ts) + alias order fix so main-only modules (`models_dev`, Supabase, `db/index`, `SubscriptionManager`) do not land in the UI bundle; fixes `npm run package` Rollup errors.
- **CLI uninstall:** `atlarix uninstall` uses elevated install when global `node_modules` is not writable ([`cli_handlers.ts`](../../src/ipc/handlers/cli_handlers.ts)).
- **Markmap:** Dark-theme CSS variables, destroy/recreate on theme change, zoom/fit controls ([`MarkmapRenderer.tsx`](../../src/components/MarkmapRenderer.tsx)).
- **`read_file`:** Structured `ENOENT` / directory / path errors; quieter logs ([`file.ts`](../../src/lib/tools/file.ts)).
- **Viz prompts:** Proactive markmap vs mermaid routing in [`system_prompt.ts`](../../src/prompts/system_prompt.ts).

### Copy

- Inline chat “Starting chat…” and launchpad FAQ reflect session + terminal persistence.

---

## [8.4.2] (2026-05-19) — Patch

- Renderer Vite shims (in progress toward 8.5.0 packaging fixes).

---

## [8.4.0] (2026-05-17) — Terminal, CLI, modes, and session fixes

### Features

- **Terminal reliability:** `runShellCommand` listens to `exit` and `close`, guards double-resolve, kills child on permission timeout; interactive [`terminal:run`](../../src/ipc/handlers/terminal_handlers.ts) IPC; [`TerminalPanel`](../../src/components/panels/TerminalPanel.tsx) + Activity tab (Lucide icons).
- **CLI:** `atlarix .` / open-file / second-instance ([`open_workspace_from_cli.ts`](../../src/main/open_workspace_from_cli.ts), [`cli_handlers.ts`](../../src/ipc/handlers/cli_handlers.ts)); Settings PATH install scripts; layout `workspace:opened-from-cli` listener.
- **Terminal mode permissions:** [`classifyTerminalCommand`](../../src/lib/terminal-command-class.ts) + stream enforcement in [`chat_stream_handlers.ts`](../../src/ipc/handlers/chat_stream_handlers.ts).
- **PDF attachments:** 30s timeout + pdf2json fallback in [`workspace.ts`](../../src/lib/tools/workspace.ts) read path.
- **Per-mode system prompts:** removed `request_mode_change`; per-mode blocks in [`system_prompt.ts`](../../src/prompts/system_prompt.ts).
- **Per-message work mode:** migration `0044_messages_work_mode`; resend UI in [`ChatMessage.tsx`](../../src/components/chat/ChatMessage.tsx).

### Fixes

- **Message edit (workspace):** [`show-workspace-mode-controls.ts`](../../src/lib/chat/show-workspace-mode-controls.ts) — Mode dropdown + **Send** for ephemeral workspace chats (negative `chatId`), not **Save** only ([`SimpleMessage.tsx`](../../src/components/SimpleMessage.tsx)).
- **Edit resend duplicate:** ephemeral workspace path respects `continueAfterQuestions` (no second user row); `SessionMemory.replaceLastExchange` on continue-after-edit.
- **Explore + terminal:** `run_command` registered for Ask mode; Autonomous ask-tier uses `shouldAutoApprovePermissions` for terminal like Build.
- **Git identity:** canonical author `atlarix-agent <agent@atlarix.dev>` in [`git_author.ts`](../../src/ipc/utils/git_author.ts); co-authored-by reads `includeAtlarixCoAuthor` live inside `gitCommit()`.

### Tests / migrations

- Bundled SQL migrations (45); new tests: `show-workspace-mode-controls`, `session-memory-replace`, `git_author`, `git_commit_coauthor`.

---

## [8.3.1] (2026-05-17) — Chat config dropdown placement

### Release highlights

- **Chat config / model / work-mode menus:** Open **above** the composer by default with Radix collision avoidance so Guided / Direct / Autonomous, model, and MCP sub-panels stay on screen instead of clipping below the viewport edge.

---

## [8.3.0] (2026-05-17) — Agent Workstation reframe

### Release highlights

- **Positioning:** Agent Workstation across website, README, and in-app copy — the editor stays yours; the agent gets its own workspace beside it.
- **Language:** Solo / Studio / Team tiers; Explore / Fix mode labels; Model Bridge tiers Speed / Standard / Deep; Approval Queue, Agent Memory, Checkpoints, Multi-Model Review, Agent Teams.
- **Tools:** Removed `git_status`, `git_diff`, and `git_log` from the agent registry — use the terminal tool for standard `git` CLI commands.
- **Fix:** Raw `<task_complete>` tags are stripped before chat UI render and DB persist.
- **Docs:** Live Code Map / parser deep-dive in [architecture.md](architecture.md); README lead rewritten.

---

## [8.2.0] (2026-05-15) — Parser worker pool, WASM tree-sitter, packaging fix

### Release highlights

- **oxc packaging fix:** `packageAfterPrune` no longer strips `@oxc-parser/binding-*` optional deps; platform binding is re-installed after `--omit=optional` prune so packaged apps load native oxc.
- **Parser worker pool:** TS/JS/JSX/TSX `parseSync` runs in 2–4 dedicated workers (`parser_worker.js`) with timeout and crash recovery; sync fallback when the worker bundle is absent (vitest/dev).
- **WASM tree-sitter:** Python, Go, and Rust Blueprint RTE uses `web-tree-sitter` + `tree-sitter-wasms` grammars (packaged via `extraResources`); WASM wins for class/function nodes, regex wins for routes.
- **CI gates:** Release workflow runs `npm test` and `npx tsx scripts/bench-parsers.ts` before `npm run make` on macOS, Linux, and Windows.

---

## [8.1.1] (2026-05-15) — oxc-parser, repo overview, secret path hardening

### Release highlights

- **oxc-parser for TS/JS/JSX/TSX:** Blueprint RTE uses `oxc-parser` (Rust-based, ~2× faster than SWC in oxc's published benchmarks) for AST-level extraction on `.ts`, `.tsx`, `.js`, `.jsx`. Python and other supported languages remain on structural heuristic parsers (unchanged). Per-file 256 KB cap, cooperative `setImmediate` yield every 10 files during parse, merge rules for oxc + regex route nodes.
- **`get_repo_overview` tool:** Lightweight cold-session orientation (shallow tree, README excerpt, entry points, language stats) without Blueprint parse.
- **Secret path denylist:** Extended to `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `secrets.json`, `credentials.json`, `service-account.json`; `assertReadablePath` blocks workspace escape (`../../.env`) across file-reading tools and IPC.
- **Removed tree-sitter stubs:** Dead pivot/tree-sitter modules deleted; tiered Blueprint prompt injection code removed (tool-driven only).

---

## [8.1.0] (2026-05-11) — Pass 6: Blueprint restoration, unified search, streaming, tool merge

### Pass 6 highlights (this branch)

- **Blueprint:** Restored lazy-parse graph, DB schema + migrations bundle alignment, IPC, `BlueprintCanvas` (click-to-load, 500-node cap), single **`get_blueprint`** tool; structural queries use unified **`search`**.
- **Unified search:** `search` (`auto` | `text` | `semantic` | `structural`) replaces `search_code` / `find_relevant_files` in core registration; manifests + `mode_system_consistency` test updated.
- **Streaming / chat UI:** Throttled renderer updates, `@tanstack/react-virtual` message list, post-stream message trim; diagrams/blueprint no longer auto-open the right panel (sources/terminal behavior preserved where applicable).
- **Dev server:** `DevServerProvider` stops auto-starting dev servers and forcing panel visibility; still parses output/errors for the preview pipeline.
- **Tool consolidation:** `get_diagram` (type/scope/path/`role`); `check_environment`; `get_file_outline({include_stats})` supersedes **`analyze_context`** tool; `run_tests({path,watch})` supersedes **`test_changes`**; **`git_status`** adds optional **`workspaceId`** session summary (replaces **`get_session_changes`**); **`live_preview({port_only,workspaceId})`** replaces **`get_dev_server_port`**; **`get_project_history({revert_to})`** replaces **`revert_to_snapshot`**; **`request_tools`** description lists current categories.
- **Diagram UX:** Tool results with `role:"reference"` populate reference chips in **`DiagramPanel`**; diagrams page defers creation to **`get_diagram`** in chat.
- **PDF attachments:** `pdfjs` uses `GlobalWorkerOptions.workerSrc = ''` with `disableWorker: true` for reliable Electron extraction.

---

## [8.1.0] (2026-05-09) — Pass 7: Blueprint removal + tool consolidation

> **Note:** The Pass 7 changelog below describes an intermediate removal branch. **Pass 6 (above) restores Blueprint and supersedes several Pass 7 tool removals** (e.g. `search_code` → `search`, Blueprint tables re-added). Keep Pass 7 items that still apply (`edit_file`, `memory`, MCP on-demand, mode lists).

### Release highlights

- **Blueprint subsystem removed:** Deleted React Flow canvas (`src/components/blueprint/`, `BlueprintCanvas.tsx`, `BlueprintEditor.tsx`, `PivotAnalysisPanel.tsx`, `LayoutToggle.tsx`), all `src/lib/blueprint/`, `src/lib/cache/blueprint-cache.ts`, `src/lib/pivot/`, `src/ipc/handlers/blueprint_handlers.ts`, `src/ipc/handlers/pivot_analysis_handlers.ts`. Removed all `blueprint:*` and `pivot:*` IPC channels from `preload.ts`. Settings tier (`blueprintInjectionModePreference`, `blueprintDebugTrace`, `blueprintDebugFile`, `blueprintAlwaysShowBeacons`) deleted. Mermaid Live diagrams stay (`DiagramPanel.tsx` simplified to Mermaid-only).
- **Tool consolidation (~60 → ~28):** unified tools — `search_code({mode: "keyword"|"regex"|"semantic"})` (absorbs `grep_search` / `semantic_search`); `edit_file({operation: "replace"|"insert"|"delete"|"section"})` (absorbs `replace_code` / `insert_code` / `delete_lines` / `edit_file_section`); `memory({operation: "recall"|"search"})` (absorbs `recall_memory` / `search_memory`); `diagnose_issue({analysis_type: "diagnose"|"health_check"|"change_impact"})` (absorbs `health_check` / `get_change_impact`); `stream_terminal_output({source: "terminal"|"pipeline"})` (absorbs `stream_pipeline_logs`); `web_search({deep: true})` (absorbs the old multi-source `deep_search`). `deep_research` (agentic loop) stays standalone. Deleted: `template-tools`, `ai-template-tools`, `atlarix-ignore-tools`, `refactoring-tools`, `reference-project-tools`, `view_symbol`.
- **MCP scoping rework (Part F):** Workspace chats no longer auto-merge every MCP tool. New tools `list_available_mcps` + `mcp_call` for on-demand discovery and invocation. Chat-only mode keeps global MCP pre-loading.
- **Skills wired to ToolRegistry (Part G):** New tools `get_active_skills` + `list_installed_skills` give the model first-class access to installed skills. Removed the dead `if(false)` skills injection block in `chat_stream_handlers.ts`.
- **Mode-aware tool surface (Part H):** New `<mode_system>` block in `system_prompt.ts` + `chat_only_handlers.ts` declares per-mode tool lists. New smoke test `src/__tests__/mode_system_consistency.test.ts` asserts the prompt lists stay in sync with runtime `modeAllowlist`.
- **Migration 0043:** New SQL migration drops `blueprints`, `pivot_nodes`, `pivot_edges`, `pivot_containers`, `pivot_beacons`, `blueprint_snapshots` and rewrites `project_snapshots` (drops `blueprint_json`, tightens `trigger` enum from `{blueprint_change, plan_update, build_complete, session_end}` → `{plan_update, build_complete, session_end}` with `blueprint_change` rows mapped to `plan_update`). Bundled SQL regenerated; `migration_seed_verification.ts` extended.
- **Dependency audit (Part I):** Removed `@xyflow/react`, `elkjs`, `tree-sitter`, `tree-sitter-javascript`, `tree-sitter-python`, `tree-sitter-typescript`. Removed `smoke:tree-sitter` script and `patch-tree-sitter-electron-cpp20.cjs` postinstall. Retained `konva` / `react-konva` (Pro Annotator) and `@opentelemetry/*` (telemetry). 16 packages removed via `npm install`.
- **Tool registry telemetry:** `initializeTools()` now logs the registered tool count and the sorted name list at startup.

### Notes

- Stubbed `searchBlueprintBm25()` returns `null` so `search_code({mode:"semantic"})` cleanly falls back to file-walk semantic search.
- `parseWithTreeSitter()` and `isTreeSitterAvailable()` are now no-op stubs (return `null` / `false`); workspace analysis falls through to existing heuristics without the pivot parser path.
- Skill manifests (`src/lib/skills/tool-manifest.ts`) and skill .md files (architect / builder / debugger / researcher / reviewer / orchestrator / focused-writer / focused-researcher / ask-mode / debug-mode) updated to consolidated tool names.

---

## [8.0.4] (2026-05-07)

### Release highlights

- **Windows / symlink permissions:** Fallback file discovery skips paths that throw **EACCES** / **EPERM** instead of failing the scan; warns in logs and ships **`fileDiscoveryWarnings`** on **`get-app`** with a toast when folders are unreadable (e.g. Python **venv**/ **lib64** without Developer Mode).
- **Renderer memory pressure:** Chromium **V8** old-space **`--max-old-space-size=4096`** via **`js-flags`** at startup; autonomous parallel specialist runs capped to **two** concurrent delegations; **`extractCodebase`** formats and **`sortFilesByModificationTime`** stats run **serialized** instead of **`Promise.all`** bursts.
- **Main-process RSS logging:** **`performance_monitor`** emits tiered **`electron-log`** warnings at **1200 MB** / **1800 MB** RSS (with hysteresis) to correlate heavy sessions with silence-before-quit diagnostics.
- **Dev installs:** Root **`postinstall`** runs **`electron/install.js`** so the **Electron** binary is present when **`dist/`** was left without **`Electron.app`** (fixes **`spawn .../Electron ENOENT`** on **`npm start`**).

---

## [8.0.3] (2026-05-07)

### Release highlights

- **OpenRouter BYOK:** First-class **OpenRouter (bring your own key)** next to **Compass** — provider in settings, dynamic model list from OpenRouter API, encrypted settings + env `OPENROUTER_API_KEY` + DB keys, **`get_model_client`** path with shared `OPENROUTER_APP_HEADERS`, Auto config and quick-switch in Config dropdown when a key is present, token budget parity.
- **Electron packaging robustness:** Main bundle externalizes **`@anthropic-ai/tokenizer` / `tiktoken` / `pdfjs-dist`** where filesystem-relative assets are required; Forge **`packageAfterPrune`** maps Rollup subpath externals to npm package roots and merges worker externals; **`@lydell/node-pty`** included in Electron rebuild; packager **`ignore`** allows required `node_modules` subtrees.
- **`npm run package` / `make` / `publish`:** `NODE_OPTIONS=--max-old-space-size=8192` via `cross-env` to reduce Vite OOM on large production builds.
- **Quit diagnostics:** Main process logs **`[lifecycle] before-quit`** / **`will-quit`** with **RSS / heap** to help trace silent app exits via `electron-log`.

---

## [8.0.1] (2026-05-07)

### Release highlights

- **Tool Contract Layer:** Agent does not claim a tool is unavailable when it is registered in the tool registry.
- **Model-triggered compaction:** `compress_context` tool replaces unconditional pre-dispatch auto-summarize; model decides when to compress.
- **Streaming terminal guarantee:** Every stream path emits `chat:response:end` exactly once (idempotent terminal handling).
- **Macro tools:** `get_workspace_overview` and `read_attachment_summary` added for lighter default prompts.
- **BYOK error banners:** `classifyProviderError` maps 401/429/404/network and related failures to actionable UI copy (incl. switch-model where relevant).
- **Skills Marketplace:** Settings → Skills — browse/install from community registry (`AmariahAK/atlarix-skills`), 5 global + 5 per-workspace slots, Pro/Workforce gated in UI and IPC.
- **Context cleanup:** Six heavy pre-dispatch injections removed or gated (`if (false)` / mode gates) — blueprint, installed skills block, Supabase pre-inject, diagram-first prefix, workforce workspace analysis, SQLite project memory; session memory capped; estimated ~50% lower baseline input tokens on large workspaces.
- **Explore subagent:** Read-only exploration via `delegate_to_agent` / explore agent for codebase survey without bloating main thread context.
- **OpenRouter identification:** All OpenRouter SDK and HTTP calls send `X-Title: Atlarix` and `HTTP-Referer: https://atlarix.dev` for usage logs.
- **Tool spinner reconciliation:** `AtlarixMarkdownParser` treats in-progress tools as finalized when stream ends — no stuck “running” indicators.
- **Debug cleanup:** Removed `hypothesisId` / `debugLog` pre-dispatch instrumentation from chat stream path.

### Fixes and infrastructure (same release)

#### Workspace Path Resolution Fix

- **Fixed [`getAtlarixAppPath()`](src/paths/paths.ts)**: Relative paths are now resolved by checking real directory locations before falling back to `~/atlarix-apps/`. Checks `~/Documents/Atlarix/{name}` first, then `~/atlarix-apps/{name}` (legacy). This ensures workspaces imported from locations like `/Users/amariah/Documents/Github/Spacinsider` are resolved to their actual location rather than `~/atlarix-apps/spacinsider`.

### File Path Normalization Fix

- **[`src/ipc/utils/project-files.ts`](src/ipc/utils/project-files.ts)**: All strategies now return workspace-relative paths (`src/lib/foo.ts`) regardless of which tool generated them. `fd` and `ripgrep --files` were returning absolute paths, causing workspace-relative assumptions to break downstream. Normalization is applied at return time in each strategy.
- **[`src/lib/DiagramManager.ts`](src/lib/DiagramManager.ts)**: Added defensive `path.isAbsolute()` checks before `path.relative()` to handle both relative and absolute inputs from `getProjectFiles`.
- **[`src/lib/tools/exploration-tools.ts`](src/lib/tools/exploration-tools.ts)**: `scanDirectory()` now returns workspace-relative paths instead of absolute paths, fixing `generate_workspace_map` tool output.
- **[`getStructureScan()`](src/ipc/utils/project-files.ts)**: Now keys results by relative path and accepts both relative and absolute input paths.

### Crash Fix

- **Fixed `ReferenceError: budgetTracker is not defined`** in [`src/ipc/handlers/chat_stream_handlers.ts`](src/ipc/handlers/chat_stream_handlers.ts): The stepped compaction refactor removed the `budgetTracker` variable declaration that `simpleStreamText`'s TTFT logging closure depends on. `budgetTracker` is now instantiated before the closure along with `dispatchEstimate`, `contextBudgetPruningApplied`, and `llmCompactionApplied`.

### Token Estimate Fix

- **Fixed `estimatedTokens=209715` on every request** in [`src/ipc/handlers/chat_stream_handlers.ts`](src/ipc/handlers/chat_stream_handlers.ts): `compactionResult.estimatedTokens` was `undefined` (field doesn't exist on `RunSteppedCompactionResult`), causing fallback to `tierLimit` (context window size). Now uses `estimateDispatchTokens()` with the actual post-compacted `limitedMessageHistory` to compute the real token count.

### Workspace Analysis Deduplication

- **Added in-flight deduplication** to [`src/ipc/handlers/chat_stream/workspace-context.ts`](src/ipc/handlers/chat_stream/workspace-context.ts): Added `workspaceAnalysisInFlight` Map to prevent parallel `analyzeWorkspace` calls from OOM-ing the app on large workspaces. Follows the same pattern as `extractCodebaseCached`.

### Tool Output Cache Fix

- **Fixed `cachedAt.getTime is not a function`** in [`src/lib/tools/cache/output-cache.ts`](src/lib/tools/cache/output-cache.ts): `cleanupExpired()` called `.getTime()` on a `Date` that was stored via JSON (becomes string after `JSON.parse`). Fixed by wrapping with `new Date(cached.cachedAt).getTime()`.

### Fingerprint Cache Fix

- **Fixed workspace-fingerprint cache never hitting** across [`src/lib/analysis/fingerprint.ts`](src/lib/analysis/fingerprint.ts) and call sites: The 60s TTL `getWorkspaceFingerprint()` function was defined but never called — all 4 call sites used `generateFingerprint()` directly, bypassing the cache. Updated `DiagramManager.ts`, `diagram_handlers.ts`, `diagram_regenerate_background.ts`, and `staleness.ts` to use `getWorkspaceFingerprint()` instead.

### Attachment UI Fix

- **Fixed raw `<atlarix-text-attachment>` XML visible in chat** in [`src/components/chat/AtlarixMarkdownParser.tsx`](src/components/chat/AtlarixMarkdownParser.tsx): Added `atlarix-text-attachment` to `customTagNames` array and added a render case that shows a styled chip `[📄 filename]`.
- **Changed `dyad-attachments` → `atlarix-attachments`** in [`src/ipc/handlers/chat_stream_handlers.ts`](src/ipc/handlers/chat_stream_handlers.ts): The temp directory name was leaking internal naming. Now uses `atlarix-attachments` consistently.
- **Used `escapeXml()` when generating attachment tags** in [`src/ipc/handlers/chat_stream_handlers.ts`](src/ipc/handlers/chat_stream_handlers.ts): Attachment filename, type, and path attributes are now properly escaped to prevent XML injection.

### New Chat Workspace Inheritance Fix

- **Fixed new chat inheriting previous workspace** in [`src/app/layout.tsx`](src/app/layout.tsx): `handleNewChat` now calls `setSelectedAppId(null)` to prevent the previous workspace's context from being auto-loaded when the user starts a fresh chat from the home page.

### File Attachment Permission Fix

- **Fixed permission prompts on user-attached files** in [`src/ipc/handlers/chat_stream_handlers.ts`](src/ipc/handlers/chat_stream_handlers.ts) and [`src/ipc/handlers/permissions/interceptor.ts`](src/ipc/handlers/permissions/interceptor.ts): When a user attaches a file with `upload-to-codebase`, the file is now marked `preApproved: true` in `FileUploadsState`. `shouldAlwaysAutoApprove()` in the permission interceptor checks pre-approved paths and auto-approves AI writes to those files without showing a permission dialog. The AI still writes the file (not auto-written bypassing AI) — the dialog is just skipped since the user already consented by attaching.
- **Added `isPreApprovedPath()` method** to [`src/ipc/utils/file_uploads_state.ts`](src/ipc/utils/file_uploads_state.ts): New method to check if a file path matches a pre-approved upload.

### Copy-Paste Large Text Fix

- **Copy-paste over 500 lines now attaches as file** in [`src/hooks/useAttachments.ts`](src/hooks/useAttachments.ts): When pasting plain text with more than 500 lines, the content is saved as a file and attached as `chat-context` instead of filling the message input. Language detection uses simple heuristics: TypeScript for `import`/`const`/`function`/`class`/`interface`/`type`/`export`, Python for `def`/`class` (no semicolons), HTML for `<`, JSON for `{`/`[` (valid JSON). Default is `.txt`. Filename format: `pasted-{ext}-{timestamp}.{ext}`.

- **Added `build.publish` to [`package.json`](package.json)**: Tells electron-builder to generate `app-update.yml` at build time, embedded in the app bundle. Required for electron-updater to locate the release feed.
- **`releaseType: "release"` added to `setFeedURL`** in [`src/main.ts`](src/main.ts): Ensures electron-updater v6 looks for the correct YAML feed format in `atlarix-releases`.
- **Import path corrected** in [`src/lib/context/compaction.ts`](src/lib/context/compaction.ts): Fixed wrong relative path `../ipc/` → `../../ipc/`.

---

## v7.1.4 — Stepped compaction, exact tokenizer, icon fix (2026-05-06)

### Token Counting (Exact)

- **Installed `@anthropic-ai/tokenizer`**: Uses tiktoken internally for accurate token counting across all providers
- **New [`src/lib/context/token-counter.ts`](src/lib/context/token-counter.ts)**: Exports `exactTokenCount()` and `exactTokenCountText()` that use the tokenizer with fallback to character-based estimation
- **Replaced all `estimateTokens()` calls** across the codebase with exact token counting

### Context Compaction (Stepped, OpenCode pattern)

- **New [`src/lib/context/compaction.ts`](src/lib/context/compaction.ts)**: Automatic stepped compaction that runs before every dispatch
  - **Step 1 — Measure**: Calculate `usageRatio = exactTokenCount(modelContext) / tierLimit`
  - **Step 2 — Prune tool outputs** (at 60% ratio): Zero-LLM-cost mechanical replacement with placeholders
  - **Step 3 — Strip media** (at 75% ratio): Remove image/PDF from older turns, keep last 2 turns intact
  - **Step 4 — LLM summarization** (at 75% ratio): Background summarization with Fast tier model; task continues seamlessly
  - **Step 5 — Detect model-applied**: Track compaction markers to avoid re-summarizing

- **Summary template** includes `## Resume From` section for immediate task resumption after compaction
- **Protected content**: `write_file`, `run_command` tool calls, current active task, last 2 turns, modified file paths
- **`MODE_CONTEXT_CAPS` removed**: Replaced by stepped compaction system

### `compress_context` Tool (All Modes)

- **New tool registered** in [`src/lib/tools/exploration-tools.ts`](src/lib/tools/exploration-tools.ts)
- Available in **all modes**: Ask, Plan, Build, Debug, Review (no mode restriction)
- Scopes: `completed_tasks`, `old_tool_outputs`, `everything_old`
- Returns separator: `"── Context compacted · N tokens freed ──"`

### Hard Stop Removal

- **Removed `ContextBudgetTracker` from dispatch path**: No longer used in `chat_stream_handlers.ts` or `chat_only_handlers.ts`
- **Removed `ContextLimitBanner` component**: No UI warning elements for context limits
- **Tasks never stop**: Compaction runs transparently; user sees only the subtle separator

### Installer Icon Fix

- **DMG icon**: `MakerDMG` now configured with `icon: "./assets/icon/logo.icns"`
- **Windows setup icon**: `MakerSquirrel` now configured with `setupIcon: "./assets/icon/logo.ico"`
- **Linux AppImage icon**: `MakerAppImage` now configured with `icon: "./assets/icon/logo.png"`

## v8.0.0 — Model-driven exploration, LSP diagnostics, OpenCode parity (2026-05-06)

### Architecture (OpenCode parity)

- **Model-driven workspace exploration**: Replaced auto-generation with on-demand tools
  - `generate_workspace_map`: Mermaid diagram for specific paths via Tree-sitter
  - `scan_file_structure`: Extract classes/functions/imports without reading full content
  - `find_entry_points`: Discover main entry points for a directory
  - Available in all workspace sizes, all modes (Ask/Build/Debug)

- **LSP diagnostics injection** (`src/lib/lsp/`): Live error/warning context for Build/Debug modes
  - `lsp-server-registry.ts`: Multi-language LSP server configs (TypeScript, Python, Rust, Go, Java, C++, and 15+ more)
  - `lsp-client.ts`: JSON-RPC over stdio, push/pull diagnostics, instance caching, deduplication
  - `lsp-trigger.ts`: Lazy trigger on file open/save/change (150ms debounce)
  - `lsp-diagnostics.ts`: Context formatting for AI injection
  - Binary availability check — fails silently if server not installed
  - `apply_lsp_fix` tool: Auto-fix loop (diagnostic → code action → apply → verify)

- **Directory exclusions** (`src/ipc/utils/file_utils.ts`):
  - Added `isExcludedDir()` helper with wildcard matching for `.venv*`, `venv*`
  - Extended exclusions: `.venv-ci`, `.venv-dev`, `.venv-test`, `site-packages`, `dist-packages`, `tzdata`, `zoneinfo`, `.aws-cdk`
  - Applied consistently across all analyzers: file_utils, workspace-analyzer, workspace-cache, project-selector, codebase

### Follow-up Batch (Auto-generation removal)

- **Cold start diagram generation removed**: Diagram now generated on-demand via `generate_workspace_map` tool
- **workspaceAnalysis auto-injection removed**: Model uses exploration tools to understand codebase structure on demand
- **Unified exploration hint**: Single low-priority (10) hint injected when workspace is open
- **`BLUEPRINT_EAGER_BUILD_THRESHOLD = 100`**: Blueprint now on-demand by default; eager build only for workspaces under 100 files

### Provider/Language Support

- **All Tree-sitter languages now have LSP server configs**: TypeScript, Python, Rust, Go, Java, Kotlin, C/C++, C#, Ruby, PHP, Swift, Lua, Bash, HTML/CSS, JSON, YAML, TOML, GraphQL, Dockerfile, Vue, Svelte

### File Discovery & Performance (Lazy Architecture)

- **Project file discovery** (`src/ipc/utils/project-files.ts`): 4-strategy cascade with 5-minute memory cache
  - `git ls-files` primary (uses project's .gitignore as source of truth)
  - `fd` first fallback (cross-platform, respects .gitignore)
  - `ripgrep --files` second fallback
  - Legacy recursive scan (`getFilesRecursively`) final fallback only
  - Results cached in memory per workspace; subsequent calls within 5 minutes return cached result

- **Workspace fingerprint cached** (60s TTL): `getWorkspaceFingerprint()` now uses the file list cache instead of raw recursive scan; only fingerprints tracked files, not build artifacts

- **Tree-sitter on-demand only**: Removed automatic Tree-sitter parsing from `analyzeFile()` in `workspace-analyzer.ts`. Tree-sitter is now invoked only via the `scan_file_structure` tool, on the specific files the model requests

- **search_code tool**: 20-second timeout with graceful error return instead of stream stall

- **tool-output-cache**: Better error logging with actual error details (`message`, `code`) instead of empty `{}`

- **Mental model**: Atlarix sits completely idle until the model or user explicitly requests something. No background scans, no auto-parsing, no fingerprinting on workspace open. First tool call triggers lazy load; subsequent calls are fast from cache.

## v7.1.2 — Token efficiency, architecture improvements, terminal enhancements (2026-05-05)

### Token Management (OpenCode parity)

- **`TokenUsage` interface** in [`src/ipc/utils/token_utils.ts`](src/ipc/utils/token_utils.ts): Added cache token awareness (`cacheReadTokens`, `cacheWriteTokens`) for accurate overflow detection
- **`normalizeTokenUsage()`**: Properly handles cache token extraction from AI SDK responses across providers
- **`calculateBillableTokens()`**: Separates billable tokens from cache tokens for accurate cost accounting
- **`wouldOverflow()`**: Cache-aware token overflow detection matching OpenCode's `isOverflow()`
- **`getUsableTokenBudget()`**: Mirrors OpenCode's `usable()` function with `COMPACTION_BUFFER = 20_000`
- **`getModelMaxOutputTokens()`**: OpenCode-style max output tokens calculation with experimental floor of 32k

### Context Compaction (OpenCode parity)

- **`selectMessagesForCompaction()`**: New turn-based message selection (mirrors OpenCode's `select()`)
- **`turns()`, `splitTurn()`, `preserveRecentBudget()`**: OpenCode-style turn tracking and budget preservation
- **`PRUNE_MINIMUM = 20_000`, `PRUNE_PROTECT = 40_000`**: OpenCode-aligned pruning constants
- **`DEFAULT_TAIL_TURNS = 2`**, `MIN/MAX_PRESERVE_RECENT_TOKENS`: Turn-based tail preservation
- Enhanced **`pruneToolOutputsBeforeCompaction()`** with stop-after-2-user-turns, protected tool list (`skill`), and truncation to 2k chars

### Architecture (New)

- **Logging service** ([`src/lib/logging.ts`](src/lib/logging.ts)): Service-tagged loggers with automatic timing via `Symbol.dispose`
- **Error types** ([`src/lib/errors.ts`](src/lib/errors.ts)): Typed error hierarchy (`AtlarixError`, `ToolExecutionError`, `TokenBudgetError`, etc.)
- **Context refs** ([`src/lib/context.ts`](src/lib/context.ts)): `AsyncLocalStorage`-based workspace/chat/operation context propagation
- **Plugin service** ([`src/lib/plugins/service.ts`](src/lib/plugins/service.ts)): Atlarix-specific hook-based extensibility with lifecycle events
- **Doom loop detection** ([`src/lib/messages/doom-loop.ts`](src/lib/messages/doom-loop.ts)): Hash-based doom loop detection with time windows
- **Tool output cache** ([`src/lib/tools/cache/output-cache.ts`](src/lib/tools/cache/output-cache.ts)): Disk caching for large tool outputs (7-day retention, 50-line preview)

### Terminal Enhancement

- **Copy button** in terminal header: One-click copy of terminal output to clipboard
- **Clear button**: Prepared for IPC-driven terminal output clearing (requires backend implementation)

### SimpleChatInput Enhancement

- **Drag-drop file attachment**: Drop files directly onto the chat input
- **Attachment menu**: Popover with "Upload from computer" option
- **Attachment preview chips**: Shows file name with remove button

### Counsel Live Thinking

- **`counsel_thinking` activity type** added to [`src/atoms/sourceAtoms.ts`](src/atoms/sourceAtoms.ts): New activity type for live reasoning updates during Counsel participant execution
- **`counsel-runner.ts`**: Switched from `generateText` to `streamText` with `fullStream` iteration; emits `counsel_thinking` activity every 1.5s with "Analyzing: [snippet]" detail from reasoning-delta parts
- **`ThoughtsPanel.tsx`**: Updated to display `counsel_thinking` type and add to `COUNSEL_ACTIVITY_TYPES` set; shows reasoning deltas in real-time

### Delegation Visibility

- **`useStreamChat.ts`**: Registered `onToolIndicator` listener to emit `tool_use` activity items for both `chat:tool:start` (with tool name) and `chat:tool:end` (with "✓ Done" for all completions)
- Tool use indicators now surface in ThoughtsPanel immediately when a tool starts, not just on completion

### Tool Completion for Empty Results

- Tool end activity now shows "✓ Done" automatically for all completed tools, including those that returned no output
- No AI confirmation needed — handled passively in activity stream

### File/Image Attachments (Non-Workspace Chats)

- **Attachment support extended** to chat-only mode (no workspace open) in [`src/ipc/handlers/chat_only_handlers.ts`](src/ipc/handlers/chat_only_handlers.ts): Files and images are saved to temp directory and processed through capability check
- Vision-capable models receive images as base64 content parts; non-vision models skip images gracefully

### PTY Support

- **`src/lib/pty-utils.ts`** (new): PTY wrapper using `@lydell/node-pty` with platform-specific shell selection, configurable cols/rows/cwd/env
- **`runShellCommand.ts`**: Integrated PTY for interactive shell commands with graceful fallback to standard pipes on failure
- `killPtyProcess()`: Graceful termination with SIGTERM → SIGKILL escalation (3s timeout)

## v7.1.1 — No-workspace CTA hides after first message in chat-only threads (2026-05-03)

### UX

- **Workspace onboarding:** The **Open workspace** / “Pick a folder” strip no longer stays visible for the whole session when you chat **without** a folder. It hides after your **first user message** in the current thread (and still hides immediately when you open a workspace, unchanged).

## v7.1.0 — Agent bus oversight, counsel completion-driven flow, diagram polish, first-run UX (2026-05-03)

### Agent Bus

- **DelegationMonitor:** Detects **cyclic** and **runaway** `delegate_to_agent` patterns (same edge repeated in a sliding window, total delegation burst); emits **WARNING** / **CRITICAL**-style corrective bus messages and exposes **`delegation_abort`** via **`consumeDelegationAbort`** for the autonomous tool loop when thresholds demand stop.
- **Bus payloads:** `publishAgentMessage` / IPC may include optional **`modelId`** and **`responseMs`** on relevant turns; **`chat:activity`** normalization and the Thinking / agent-bus UI surfaces show **model name** and **response time** when present (delegation completions instrumented).

### Counsel Pipeline

- **Completion-driven:** Replaced the stacked short **`participant_timeout`** / handler **`Promise.race`** behavior with **all participants settling** via **`Promise.allSettled`** — counsel resolves when each participant completes naturally (including **`COUNSEL_COMPLETE_SIGNAL`** semantics where applicable).
- **Hard cap:** Single outer **`COUNSEL_TIMEOUT_MS`** (**7 minutes**) in [`src/constants/settings_constants.ts`](src/constants/settings_constants.ts) replaces the previous tight shutdown races; on timeout, logs warning and emits a **`counsel_timeout`** / normalized activity event with **partial counts** (`completedModels` vs expected).
- **Partial results:** Non-null participant outputs still feed **synthesis** when timeout fires; activity carries incomplete-model visibility.

### Diagram

- **Mermaid prompts:** Shared **CRITICAL** bracket / label rules ([`src/lib/diagramMermaidPromptRules.ts`](src/lib/diagramMermaidPromptRules.ts)) wired into all generation paths so models avoid **parentheses inside `[ ]` node labels** and related lexer failures.
- **Renderer:** **“Diagram couldn’t render”** user copy instead of raw `mermaid.parse` errors; **one-shot** bracket-label repair retry before showing the overlay.

### UX

- **Sign-in:** **`oauthPending`** + timed status labels during OAuth round-trip (`Connecting…` → `Verifying…` → `Finishing…`-style progression) and **`LoadingBar`** on sign-in surfaces.
- **Workspace onboarding:** **No workspace** state uses neutral onboarding styling and **Open workspace** (folder flow + import) instead of an amber warning-only banner.

### Packaging / diagnostics

- **`typescript`** moved to **production `dependencies`** so the externalized TSC worker resolves in packaged builds; worker **`terminate()`** exit races no longer log false failures after success.
- **Problems check:** Workspaces **without** `tsconfig.json` / `tsconfig.app.json` return **empty problems** instead of throwing (non-TypeScript / empty folders).
- Quieter **diagram**, **Ollama/LM Studio**, and **workspace-cache “Cache HIT”** tracing logs (behavior unchanged).

## v7.0.9 — ask_user ordering, quieter IPC logs, stream while question pending (2026-05-01)

- **ask_user:** Fixed formatted Q/A user bubbles so they appear **after** the assistant intro that hosted the question (ephemeral insert order).
- **ask_user:** While a question is pending, assistant continuation still **streams** in the synthetic tail (freeze baseline omitted so the clamp does not hide segment B).
- **Logs:** Per-IPC success traces from `createLoggedHandler` only when `ATLARIX_VERBOSE_IPC=1`; reduced routine noise from performance sampling and cleanup jobs (behavior unchanged).

## v7.0.8 — Sentry hygiene, bundled TSC worker, clarifying questions (2026-04-30)

- **Sentry:** `beforeSend` in main and renderer drops expected auth noise (`ATLARIX_AUTH_REQUIRED`, sign-in messaging, `AuthRequiredError`). Removed renderer `Sentry.captureMessage` for chat streams blocked when not signed in (product analytics via PostHog unchanged).
- **TSC worker:** The compiler stays **external** to the worker bundle (bundling it caused multi‑GB Node heap use during `electron-forge start`). At runtime the worker resolves **project `typescript` first**, then **Atlarix’s shipped `typescript` dependency**, so typechecking still works when the workspace does not install its own compiler.
- **Clarifying questions:** Optional questionnaire block title via `<questions>` JSON object (`title` or `prompt` + `questions`); IPC and UI updated. Restyled questions widget (clearer block header, radio-style options). System prompt extended for “missing how / constraints” substantive asks (e.g. large refactors) to prefer `<questions>` before deep edits.
- **Clarifying questions (incognito + ephemeral workspace):** Chat-only stream parses/strips `<questions>` and emits `chat:questions`; `chat:submit-question-answers` updates in-memory ephemeral messages; `continueAfterQuestions` continues from the appended user text without adding a blank user turn; main chat stream resolves continue-after from ephemeral memory when `chatId < 0`. Home inline chat renders `UserQuestionBar` for `ask_user` when a session is active.

## v7.0.7 — Windows release upload URL encoding (2026-04-30)

- **CI (`release.yml`) — `build-windows` upload step:** When uploading `.exe` / `.nupkg` assets to `atlarix-releases`, URL-query the `name=` parameter with `urllib.parse.quote` (via `python3`) so filenames containing spaces (e.g. `Atlarix-7.0.7 Setup.exe`) upload correctly instead of breaking the GitHub release asset URL.

## v7.0.6 — New providers, Windows CI, remove Auto button (2026-04-30)

- **New AI providers (Settings → AI):** Added four new providers to the built-in cloud catalog:
  - **NVIDIA NIM** (`nvidia_nim`) — env `NVIDIA_NIM_API_KEY`, base URL `https://integrate.api.nvidia.com/v1` (OpenAI-compatible).
  - **Cohere** (`cohere`) — env `COHERE_API_KEY`, base URL `https://api.cohere.com` (native Cohere v2 Chat API).
  - **Perplexity** (`perplexity`) — env `PERPLEXITY_API_KEY`, base URL `https://api.perplexity.ai` (OpenAI Chat Completions compatible alias for Sonar).
  - **Cerebras** (`cerebras`) — env `CEREBRAS_API_KEY`, base URL `https://api.cerebras.ai/v1` (OpenAI-compatible).
  - Provider registry: [`src/ipc/shared/language_model_constants.ts`](../src/ipc/shared/language_model_constants.ts) and `cloudProviders` list in [`src/lib/schemas.ts`](../src/lib/schemas.ts).
  - Runtime clients: [`src/ipc/utils/get_model_client.ts`](../src/ipc/utils/get_model_client.ts) (new switch cases); Cohere adapter in [`src/ipc/utils/cohere_chat_adapter.ts`](../src/ipc/utils/cohere_chat_adapter.ts).
  - Token budget UI enabled for all four in [`src/components/settings/ProviderSettingsPage.tsx`](../src/components/settings/ProviderSettingsPage.tsx).

- **Provider model browsing:** Added native model list fetching where supported:
  - **NVIDIA NIM**: `GET /v1/models` at `https://integrate.api.nvidia.com/v1` (Bearer auth).
  - **Cohere**: `GET https://api.cohere.com/v1/models` (Bearer auth), filtered to chat-compatible models.
  - **Cerebras**: `GET https://api.cerebras.ai/v1/models` (Bearer auth).
  - **Perplexity**: Sonar family exposed as an explicit list (`sonar`, `sonar-pro`, `sonar-reasoning-pro`, `sonar-deep-research`) per Sonar docs (the generic `GET /v1/models` endpoint lists Agent API models and is not a Sonar model catalog).
  - Fetchers live in [`src/lib/provider_model_fetchers.ts`](../src/lib/provider_model_fetchers.ts).

- **Mode selector UI:** Removed the **Auto** button next to the work mode dropdown (Plan/Build/Debug/Review/Ask) in [`src/components/ChatIntentSelector.tsx`](../src/components/ChatIntentSelector.tsx) and removed “Auto · …” context labeling in [`src/components/ChatInputControls.tsx`](../src/components/ChatInputControls.tsx).

- **CI / Releases — Windows build enabled:** Updated [`/.github/workflows/release.yml`](../../Atlarix/.github/workflows/release.yml):
  - Enabled `build-windows` job (unsigned build, same philosophy as Linux).
  - Added tag/version drift guard to Windows job.
  - Uploads Windows artifacts (`.exe`, `.nupkg`) to `AmariahAK/atlarix-releases` using the same `upload_url` + `curl` pattern as macOS/Linux.
  - `publish-release` now waits for Windows in addition to macOS + Linux.
  - Draft release body now lists Windows `.exe` installers.

## v7.0.5 — Auto-updater: macOS ZIP feed + Linux deb/rpm update notification (2026-04-27)

- **Forge (macOS):** Added `@electron-forge/maker-zip` (`MakerZIP`) for darwin builds so releases include a `.zip` of the signed app bundle.
- **CI release workflow (`release.yml`):**
  - **Tag/version drift guard:** Fails build if `GITHUB_REF_NAME#v` does not match `package.json` version.
  - **Notarization pipeline:** After `notarytool submit` on the DMG, staples the packaged `.app`, then re-zips the stapled `.app` using `ditto -c -k --keepParent --sequesterRsrc`, and staples the DMG.
  - **`latest-mac.yml`:** Now references the stapled **ZIP** as the primary download (`files[0]`, `path`, `sha512`), with the DMG listed as a secondary entry.
- **Linux packaged installs (`src/main.ts`):** For packaged **non-AppImage** Linux installs (`.deb` / `.rpm`), skips `electron-updater` and instead checks `atlarix-releases` latest GitHub release; when newer, shows a native desktop **Notification** that opens the release page. AppImage continues to use `electron-updater` and `latest-linux.yml` for silent updates.

## v7.0.4 — Chat config panel never clips + agent cannot read .env* files (2026-04-26)

- **Chat config dropdown (`ChatConfigDropdown.tsx`):** Removed `max-h-[70vh]` override that defeated Radix `max-h-(--radix-dropdown-menu-content-available-height)` in `DropdownMenuContent`; dropped manual `onOpenChange` / `setContentSide` heuristics; pinned **`side="bottom"`** with **`avoidCollisions={false}`** so the menu always opens **below the trigger** (away from the chat prompt) and uses Radix's available-height clamp + inner scroll when space below is tight. `collisionPadding` 12.
- **`read_file` (`file-tools.ts`):** Denylist for env-secret basenames via shared **`isEnvSecretPath`** / **`ENV_SECRET_BLOCK_MESSAGE`** (`src/lib/security/env-secret-paths.ts`): `.env`, `.env.*` (e.g. `.env.production`, `.env.development.local`), `*.env`.
- **Codebase extraction (`codebase.ts`):** Env omission uses **`isEnvSecretPath`** on `filePath` and `normalizedRelativePath` in both `shouldReadFileContents` and `shouldReadFileContentsForSmartContext`; **`ALWAYS_OMITTED_FILES`** kept exported (deprecated) for back-compat—matching is no longer substring-only for secrets.

## v7.0.3 — Sign-in reliability + clearer dark mode (2026-04-24)

- **OAuth (system browser):** Restored external-browser Supabase OAuth flow matching `ddb8c6f`: `shell.openExternal`, **60s inbound deep-link timeout** dialog with **Copy Link**, Linux copy-link fallback, and callback-path cancellation via `cancelPendingOAuthTimeout` in main.
- **Sign-in screen:** Free tier bullets aligned to pricing (one workspace, starter included usage, optional BYOK/local models, no credit card).
- **Dark mode affordance:** Increased dark token contrast (`--border`, `--input`) and adjusted UI primitives so outline/ghost buttons and switches read as controls (visible surface + borders in dark mode).

## v7.0.2 — Chat strip labels, counsel/deep-think UX, turn artifacts (2026-04-20)

- **Tool / working strip (`ToolIndicator.tsx`, `chatAtoms.ts`, `useStreamChat.ts`, `ipc_client.ts`):** Provider-agnostic labels from stable **`toolId`** (registry name or MCP key): read-only → *Reading your codebase…*, writes → *Modifying the codebase…*, web tools → *Searching the web…*, MCP → *Checking …*, default *Thinking…*. Strip stays visible from **submit through stream end** (not hidden when a tool finishes mid-turn). **`chat:tool:start`** payloads include **`toolId`**; **`chat:stream:phase`** with **`phase: "done"`** is emitted on **`chat:response:end`** / **`chat:response:error`** so lifecycle stays aligned with the renderer.
- **Autonomous / counsel strip:** **Delegation + agent bus** activity can override the strip to *Splitting to autonomous agents…*; **`counsel_start` / `counsel_end`** (via **`chat:stream:phase`** and **`counsel-runner` `onCounselStreamLifecycle`**) show *Consulting the counsel…* during counsel pre-pass (explicit, auto, mid-task, deep-think substitute).
- **Deep think fallback (`reasoning-detector.ts` `hasNativeDeepThinkingSupport`, `chat_stream_handlers.ts`, `chat_only_handlers.ts`):** When **one-shot deep thinking** (`forceThinkingTier`) is on and the **effective model has no native reasoning path** (reasoning provider options + gateway thinking flags), the app **runs Counsel as a silent substitute** for that turn and **skips** native reasoning for the API. New counsel trigger **`deep_think_fallback`** (`counsel-session.ts`). Context assembly adds section **`counselDeepThinkSubstitute`** (`ContextAssembler.ts`).
- **Chat-only counsel:** Ephemeral / no-workspace path mirrors **auto counsel** trigger + lifecycle (same rules as workspace handler); **`thinkingTierEffective`** avoids requesting native reasoning when deep-think counsel substitute applies.
- **Turn artifacts (`completedTurnArtifactsByAssistantMessageIdAtom`, `useStreamChat.ts`, `TurnArtifactsCards.tsx`, `ChatMessage.tsx`):** On stream **end** / **error**, snapshot **Counsel** (trigger, participant previews, synthesis snippet) and **Agentic-Bus** (last lines from **`agentBusRingByChatIdAtom`**) per assistant message; collapsible cards (**collapsed by default**). Activity items carry **`counselTrigger`** from counsel **`trigger`** (`sourceAtoms`, `chat-activity-normalize.ts`).
- **IPC / preload:** Tool start listeners pass optional **`toolId`**; no new preload channel names required for this patch.

## v7.0.1 — Deep research ledger + web relevance (2026-04-17)

- **`deep_research` (`web-tools.ts`):** ResearchLedger + agentic loop: `SubQuestion` / `ResearchFinding` / `DeepResearchResult`, `DEEP_RESEARCH_LIMITS` (semantic stops: max iterations 8, coverage ≥ 0.75, 3 consecutive empty iterations, 3 attempts per sub-Q, 3 search hits per attempt, 2000 chars per excerpt, 10s fetch timeout), `decomposeQuery` for missing `aspects`, `deepResearchQuickSearch` → `WebSearchAggregator.search(..., "general", n)` (equivalent to `web_search` quick path; unchanged in-flight cache / SearxNG chain), `smartReadUrlForDeepResearch` + existing `extractRelevantSection` (4-arg BM25, unchanged implementation), `refineQuery` / `scoreRelevanceForDeepResearch`, `formatResultForModel`, iteration + completion `console.log` lines. Tool return: `text`, `sources` (favicon/snippet map), plus `aspects_used`, `coverage_score`, `iterations`, `completion_reason`, `findings`. Dropped `max_iterations` parameter.
- **Chat-only (`chat_only_handlers.ts`):** Removed `deepResearchQueryNorm` / supplementary `web_search` counter / `MAX_SUPPLEMENTARY_WEB_SEARCH_WITH_DEEP` / broad-overlap skip helpers (`normalizeResearchTopicForGuard`, `extractWebOrDeepQueryFromParams`, `isBroadRestatementOfDeepTopic`); no external cap on `web_search` after `deep_research`.
- **`filterRelevantResults`:** Snippet relevance floor **0.15 → 0.25** (aggregator-ranked results).
- **Deep research “answered” gate:** Token-overlap score threshold for marking a sub-question answered **0.6 → 0.35** (aligns coverage with typical BM25 excerpts).

## v7.0.0 — Atlarix v7 (Project Vanguard) (2026-04-11)

Major architectural release: agent execution, context, snapshots, parallel work, and plan UX are rebuilt on the existing Blueprint foundation.

- **Skills (`src/lib/skills/`):** Mode and specialist behavior driven from versioned skill files; workspace overrides under `.atlarix/skills/`.
- **Task ledger (`task-ledger.ts`, `completion-detector.ts`):** Structured steps, tool attribution, delegation advances, and disk-backed state for workspace plans; survives compaction and long sessions.
- **Plan sync + archive (`plan-sync.ts`):** Living `.atlarix/ATLARIX_PLAN.md`; archives prior markdown under `.atlarix/plans/archive/` before replace.
- **Plan viewer (renderer):** New `chat:plan-update` IPC (`ipc_types.ts`, `preload.ts`, `ipc_client.ts`, `emit_plan_update.ts`); `registerLedgerPlanUiNotifier` / `unregisterLedgerPlanUiNotifier` in `task-ledger.ts`; `TaskLedgerPlanCard.tsx` + `globals.css` plan-card styles; `livePlanUpdateByChatIdAtom` / `planSnapshotByAssistantMessageIdAtom` in `chatAtoms.ts`; `useStreamChat.ts` subscribes and snapshots on stream end; `ChatMessage.tsx` renders the card between `AgentActivityLog` and markdown.
- **Activity Stream:** `plan_created` type (`chat-activity-normalize.ts`, `sourceAtoms.ts`, `AgentActivityLog.tsx`) emitted from `chat_stream_handlers.ts` when a multi-step plan is first seeded for the turn.
- **Parallel agents + counsel + verification:** Unchanged themes from 6.5.x but shipped as the default 7.x story—see README “What changed” for the user-facing summary.
- **Snapshots / diagram:** Prior 6.x snapshot and revert work remains; path sanitization and plan archive directory follow ledger rules (see 6.5.x notes).

## v6.5.0 — Project Vanguard (2026-04-09)

- **Living plan (`plan-sync.ts`):** Workspace **`.atlarix/ATLARIX_PLAN.md`** stays aligned with the **task ledger**—status, steps with `[ ]` / `[~]` / `[x]` / `[!]`, notes placeholder, and a **## Completion** file list when the run finishes cleanly. Updates run from ledger create/replace, tool recording, delegation advances, and stream completion (never throws).
- **Plan archive:** Replacing steps from a parsed plan **or** approving a write to the plan file **archives** the previous markdown under **`.atlarix/plan-archive/`** before overwrite (permission interceptor + `setLedgerSteps`).
- **`parsePlanToSteps`:** Supports checkbox lines (`1. [ ] …`, `[~]`, `[!]`, `[x]`); **completed `[x]` lines are skipped** when seeding the ledger; plain numbered lines still work.
- **Auto memory:** Settings add **`autoMemory.writeToFile`** (default **true**); when false, **`.atlarix/ATLARIX.md`** is not written. Per-turn **tool names** are tracked for auto-memory bullets (cleared after each turn’s auto-memory pass).
- **Counsel IPC:** **`counsel:start`** / **`counsel:cancel`** invoke handlers; main emits **`counsel:participant-update`** and **`counsel:complete`** (also mirrored on **`chat:activity`**). `runCounselPipeline` accepts **`abortSignal`** for cooperative cancel. Preload whitelist + **`IpcClient`** helpers + **`ipc_types`** payloads.
- **Provider-agnostic task flow:** Audited continuation, completion, build verification, compaction, and parallel delegation paths—**no Compass-only gates** on ledger continuation or autonomous verification; Compass-specific code remains usage, limits, and telemetry.
- **Build verification:** Confirmed **pattern 2** after task-complete: parallel **reviewer + debugger** at **`depth: 1`**, **`recordOnParentLedger: false`** (parent `turnId` omitted inside `runDelegation` to avoid ledger races).
- **Migrations:** Journal through **0040** and **`migration_seed_verification`** cases verified for counsel, hooks, custom commands, compaction/synthetic columns, and snapshot/revert fields (no new SQL in this release).

## v6.2.2 — Tier-aware Compass context + pre-dispatch budgeting (2026-04-09)

- **Dynamic tier limits (`tier-context-limits.ts`):** Fetches per-model `context_length` from OpenRouter’s public `GET /api/v1/models`, applies a safety factor, caches results **24h** (keyed by the three model id strings). Warmed at app startup from Compass env model ids. Unknown ids or fetch failures use conservative fallbacks without throwing.
- **Pre-dispatch budgeting (`tier_context_budget.ts`, `context_budget_routing.ts`):** For **Balanced** and **Thinking** only (Fast unchanged): before `streamText`, if estimated tokens exceed the tier limit, compress **older** conversation (beyond last three exchanges) using the same summarization path as context compaction (**no** DB write), then progressively trim the ContextAssembler injection blob in the system prompt. Resolves tier from Compass synthetic names or Auto `autoModelIds`; BYOK OpenRouter overrides the active tier’s limit lookup id.
- **OpenRouter safety gate:** Single `needsOpenRouterContextSafety` — OpenRouter **context-compression** plugin and **last-7-exchanges** cap apply to **Compass** and **BYOK `openrouter`** when tier is **balanced** or **thinking** (disabled for **fast**). Replaces Compass-only checks in [`chat_stream_handlers.ts`](../src/ipc/handlers/chat_stream_handlers.ts).
- **Compaction helper:** `summarizeMessagesWithCompactionPrompt` in [`context-compaction.ts`](../src/lib/context-compaction.ts) — shared LLM path for budget summaries; `runCompaction` reuses it for the generate step.

## v6.2.1 — Autonomous session polish + Thinking UI + snapshot hash path (2026-04-08)

- **Autonomous Build / agent mesh:** Auto-approve permissioned tools in autonomous and workspace chat paths; in-memory session op log and agent-activity capture; agent bus lifecycle (`task_assign`, `task_result`, `blocker`, `correction`); `message_agent` + `waitForBusReply`; turn-scoped orchestrator wired from the Build stream; correction suffix on delegated tool results; `AutonomousReviewPanel` with `autonomous:session-complete`, `autonomous:revert-op`, and `autonomous:accept-all` IPC; selective `revertSnapshotFiles` under `.atlarix/snapshots/<turnId>/`. Key areas: [`chat_stream_handlers.ts`](../src/ipc/handlers/chat_stream_handlers.ts), [`agent-bus.ts`](../src/lib/agents/agent-bus.ts), [`orchestrator.ts`](../src/lib/agents/orchestrator.ts), [`agent-tools.ts`](../src/lib/tools/agent-tools.ts), [`snapshot-manager.ts`](../src/lib/snapshot/snapshot-manager.ts), [`AutonomousReviewPanel.tsx`](../src/components/chat/AutonomousReviewPanel.tsx).
- **Thinking card + activity stream:** Parse `think` and `redacted_thinking` tag pairs (provider reasoning) in [`AtlarixMarkdownParser.tsx`](../src/components/chat/AtlarixMarkdownParser.tsx); wire `chat:activity` into [`activityStreamItemsAtom`](../src/atoms/sourceAtoms.ts) / [`agentBusRingByChatIdAtom`](../src/atoms/sourceAtoms.ts) from [`useStreamChat.ts`](../src/hooks/useStreamChat.ts); [`ThinkingSection.tsx`](../src/components/chat/ThinkingSection.tsx) — compact multi-agent tool summary and last bus lines; `chatId` on activity payloads in [`chat_stream_handlers.ts`](../src/ipc/handlers/chat_stream_handlers.ts) where needed for routing.
- **Snapshot metadata layout:** Canonical `snapshot_hashes.json` lives under **`.atlarix/snapshots/`** (see [`staleness.ts`](../src/lib/snapshot/staleness.ts)); read path migrates legacy `.atlarix/snapshot_hashes.json`; successful write removes the legacy file.

## v6.2.0 — Unified workspace snapshots + non-destructive revert (2026-04-08)

- **SQLite migration `0035_unified_snapshots_revert`:** `diagram_versions.chat_turn_id`, `diagrams.last_snapshot_hashes`, `messages.is_reverted`; `migration_seed_verification` case; `npm run db:bundle-sql`.
- **Removed internal diagram git:** Deleted `DiagramGitTracker`, `git_change_tracker`, and `simple-git`. Staleness uses `.atlarix/snapshot_hashes.json` + `last_snapshot_hashes` vs live workspace MD5 map.
- **`.atlarix/snapshots/<turnId>/`:** Permission queue captures pre-write file state before approved writes; manifests tie diagram + files for revert.
- **`chat:revert-to-message`:** Restores files + diagram via snapshot manager; sets `messages.is_reverted` instead of deleting messages; removed `diagram:history-from-git` IPC.
- **Diagram history:** SQL `diagram:history` filters out `trigger = auto_sync` noise; version cap (20) via `insertDiagramVersionWithCap`.
- **Blueprint canvas performance:** `BlueprintEdge` uses one SVG `animateMotion` dot per edge (no stacked particles, filters, or extra CSS keyframes on moving dots); `prefers-reduced-motion` disables motion; `onlyRenderVisibleElements` on Blueprint React Flow views.

## v6.1.16 — Diagram stability + Compass context safety (2026-04-08)

- **/diagram Sentry noise:** Normalize `onunhandledrejection` cases where the rejection reason is an `Event` (e.g. script load errors) so telemetry captures actionable details instead of `Error: [object Event]`.
- **Blueprint canvas layout:** Replace grid/ELK with a deterministic **file-tree** layout (top→bottom) based on `room.parentId`/`room.path`.
- **Diagram history restore:** Restoring a previous diagram version refreshes the diagram + history panel immediately.
- **Compass/OpenRouter context safety:** Enable OpenRouter **context compression** as a fallback near the context limit, and hard-cap history to the **last 7 exchanges** when needed.
- **Long-running commands UX:** Terminal-like output now streams into the persistent tool indicator with capped buffers (Errors / Progress / Raw) and throttled UI updates to keep the app responsive.
- **Dev stability polish:** Fix a diagram-panel refresh loop that could spam diagram history updates; ignore `userData/` in Vite dev watch to prevent reload storms; use avatar previews instead of GitHub OpenGraph images to avoid 429 rate limits during template browsing.
- **DevTools noise:** In development, DevTools only auto-opens when `OPEN_DEVTOOLS=1` to avoid noisy Chromium protocol console errors.

## v6.1.15 — Safety: Compass network noise, SQL guards, prompt hygiene, profanity filter (2026-04-07)

- **Compass (`compass_usage.ts`, `network-failure.ts`, `ipc_types.ts`, `useCompassUsage.ts`):** Transient Supabase failures (`fetch failed`, `ECONNRESET`, etc.) return **`reason: "network_error"`** with **`Sentry.captureMessage`** at **warning** instead of **`captureException`**. UI treats offline reachability as transient (not “sign out” / migration copy).
- **SQL execution (`sql-exec-guards.ts`, `supabase_management_client.ts`):** Before **`executeSupabaseSql`** → **`runQuery`**, SQL is normalized (NUL strip, max length), checked for disallowed patterns (e.g. `INTO OUTFILE`), and **single-statement** only (no `;` outside strings except an optional trailing `;`). **`assertSafeReadOnlySql`** / **`assertSafeMutatingSql`** exported for future read-only vs mutating callers.
- **Prompt hygiene (`prompt-hygiene.ts`, `chat-prompt-gate.ts`):** At **`chat:stream`** and chat-only IPC entry — NFC normalize, NUL strip, max length (**200k** chars). Documented as **not** a substitute for execution-boundary checks.
- **Profanity (`bad-words`, `profanity-filter.ts`):** User turns matching the list are rejected with **`SAFETY_FILTER_BLOCKED_MESSAGE`** (`texts.ts`). Assistant text is **`sanitizeAssistantOutput`** after stream (skips **\`\`\` fenced** regions) before DB / ephemeral persistence and before **`processFullResponseActions`**. List-based only — not full moderation.
- **Developer experience:** Added **`tsconfig.main.json`** (extends `tsconfig.app.json`) for `tsc -p tsconfig.main.json`. **`ts:main`** / **`ts:workers`** invoke **`node node_modules/typescript/lib/tsc.js`** instead of **`npx tsc`** to avoid spurious npm config warnings. macOS window controls: **`setWindowButtonPosition`** replaces removed **`setTrafficLightPosition`** typings (Electron 38).

## v6.1.14 — Groq external auto-router classifier, balanced baseline, tier floors (2026-04-07)

- **Groq classifier (`src/lib/routing/groq-classifier.ts`):** Main-process-only `classifyPromptWithGroq()` calls `https://api.groq.com/openai/v1/chat/completions` with JSON-only tier + confidence output. Credentials: `GROQ_CLASSIFIER_API_KEY` and `GROQ_CLASSIFIER_MODEL` (embedded via [`vite.main.config.mts`](../vite.main.config.mts) `MAIN_KEYS`, same pattern as Compass keys). `max_tokens: 30`, `temperature: 0`, **2s** timeout; returns `null` on any failure or if key/model missing. **429** rate limits: `electron-log` message `"Groq classifier rate limited, using fallback"` then `null` (no user toast).
- **Auto router (`src/lib/routing/auto-router.ts`):** Removed heuristic Stage-1 + conditional Stage-2 JSON classifier. New chain: (1) Groq if confidence ≥ **0.65**; else (2) user’s **fast** model with one-word prompt, **1500ms** timeout; else (3) tier **`balanced`** (never default to fast). Then **`applyCeiling`** (unchanged), new **`applyTierFloor`**: autonomous **main** and guided **main** in **plan / build / debug** work modes enforce minimum **balanced**; agents/subagents unchanged. Tier → synthetic `RoutingCategory` for `recommendedAgent` / UI. **`runAutoRouter`** removed; **`runAutoRouterAsync`** returns **`classifierMeta`** `{ tier, confidence, source }`.
- **IPC / Activity Stream (`chat_stream_handlers.ts`, `routing_handlers.ts`):** `routing:preview` uses `runAutoRouterAsync`. When Auto routing runs, emits **`classifier_routing`** activity: `Classifier → [tier] ([pct]%) via [groq|fast-model|fallback]` (percentage omitted when confidence unknown), then existing `routing_decision` line.
- **UI (`sourceAtoms.ts`, `ThoughtsPanel.tsx`):** `ActivityStreamItem` type **`classifier_routing`**; Thoughts panel treats it like routing (Main / right).
- **CI (`.github/workflows/release.yml`):** `GROQ_CLASSIFIER_API_KEY`, `GROQ_CLASSIFIER_MODEL` in workflow `env` for packaged builds.
- **Env (`.env.example`):** Documents Groq classifier variables.

## v6.1.13 — Linux OAuth fallback, theme toggle, contrast fixes, auto-updater in-app UI (2026-04-05)

- **Linux OAuth timeout fallback (`src/lib/auth/supabase-client.ts`):** After `shell.openExternal` succeeds, a 60-second `setTimeout` starts. If the `atlarix://auth/callback` deep link has not fired by then, `dialog.showMessageBox` surfaces the OAuth URL with a **Copy Link** button and (on Linux) the `xdg-mime` registration commands in the detail text. The timer is cleared via `cancelPendingOAuthTimeout()` the moment the callback arrives in `main.ts`.
- **Linux deep-link hint in sidebar (`src/components/app-sidebar.tsx`):** On sign-in failure, Linux users see a dismissable amber notice with the two `xdg-mime` / `update-desktop-database` commands. Platform detected via `IpcClient.getSystemPlatform()`.
- **Theme toggle (`src/pages/settings.tsx`):** `useTheme` + `<Select>` with System / Light / Dark options added to Settings → General after the analytics toggle. Persists via `localStorage.theme` (already handled by `ThemeContext`).
- **Contrast fix — hero glow (`src/pages/atlarix-home.tsx`):** Glow div behind the "Atlarix" gradient heading changed from `to-[#F59E0B]` → `to-[#059669]`, eliminating amber-on-amber background that failed WCAG AA for large text.
- **Contrast fix — panel toggle button (`src/app/layout.tsx`):** Expand/collapse button moved from `top-2 right-2` → `top-3 right-3` to clear the `rounded-lg overflow-hidden` parent's corner clip.
- **Auto-updater in-app UI:** `dialog.showMessageBox` removed from the `update-downloaded` handler in `initAutoUpdater()`. Main process now sends `update:downloading` (on `update-available`) and `update:downloaded` IPC events to the renderer. New `UpdateBanner` component (`src/components/UpdateBanner.tsx`) renders a subtle download strip and a dismissable "Restart Now / Remind me later" banner. "Remind me later" calls `update:defer` IPC → writes `userData/atlarix-pending-update.json`; on next cold start `onReady()` detects the flag, deletes it, and calls `autoUpdater.quitAndInstall()` after the next `update-downloaded` event.
- **AppImage target (`forge.config.ts`, `package.json`):** `@reforged/maker-appimage` added; produces `.AppImage` alongside `.deb` / `.rpm` on Linux builds, enabling `electron-updater`'s native AppImage auto-update.
- **CI — Node 24 migration (`.github/workflows/release.yml`):** `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` env var; `softprops/action-gh-release@v1` → `@v2`; `appimagetool` extraction step added for build-linux; `latest-mac.yml` (arm64 leg only) and `latest-linux.yml` (AppImage SHA-512 + size) generated and uploaded as release assets for `electron-updater` feed.
- **Launchpad hero placeholder (`atlarix-launchpad/src/components/Hero.tsx`):** Chat input placeholder updated to a concrete SaaS-dashboard example prompt.

## v6.1.12 — Mermaid normalize (diagram page + AI output) (2026-04-04)

- **Mermaid:** New [`normalizeDiagramMermaid.ts`](../src/lib/normalizeDiagramMermaid.ts) — strip code fences, standalone `mermaid` lines, `mermaid graph` prefix, normalize `Style` → `style`, scrub corrupted `#hex` tokens on `style` / `linkStyle` / `classDef` lines (Unicode NFKC + zero-width strip). Used by [`sanitizeMermaid`](../src/lib/sanitizeMermaid.ts) for all parse/render paths.
- **Persistence:** [`diagram_handlers.ts`](../src/ipc/handlers/diagram_handlers.ts) and [`DiagramManager.ts`](../src/lib/DiagramManager.ts) save diagrams via **`normalizeDiagramAiOutput`** so DB content is parse-ready (fixes “No diagram type detected” when the model prefixes `mermaid` or omits strict ``` fences).
- **Diagrams page:** [`diagram.tsx`](../src/pages/diagram.tsx) — **`key={selectedDiagram.id}`** on [`MermaidRenderer`](../src/components/MermaidRenderer.tsx) so switching diagrams remounts cleanly; renderer **retries** up to ~12 animation frames if the container ref is not ready (first paint on `/diagram`).
- **Blueprint:** [`mermaid_to_blueprint.ts`](../src/lib/blueprint/mermaid_to_blueprint.ts) uses **`prepareMermaidForParse`** when inferring graph structure.
- **Tests:** [`normalizeDiagramMermaid.test.ts`](../src/lib/normalizeDiagramMermaid.test.ts) (Vitest).

## v6.1.1 — Diagram git ignore, blueprint ELK first paint, dev-server preview (2026-04-04)

- **Diagram git:** [`diagram_git_tracker.ts`](../src/lib/diagram/diagram_git_tracker.ts) — skip `userData` and `.cursor` when mirroring the workspace into the internal diagram repo so `git add` no longer fails with “paths are ignored by .gitignore” when the project contains a `userData` tree.
- **Blueprint:** [`BlueprintCanvas.tsx`](../src/components/preview_panel/BlueprintCanvas.tsx) — ELK layout dedupes only **after** IPC succeeds (`elkCompletedForKeyRef`), clears on structure reset and manual Re-layout, fixing Strict Mode / failed first attempt leaving nodes stacked at `(0,0)`.
- **Preview:** [`PreviewIframe.tsx`](../src/components/preview_panel/PreviewIframe.tsx) — iframe uses **`appUrl ?? devServerUrl`** so managed Next/Vite dev servers show in Preview without the Atlarix preview proxy `runApp` URL.

---

## v6.1.0 — Main `raw-sql` transform, pivot + prompts migrations (2026-04-02)

- **Build / SQLite:** [`vite.main.config.mts`](../vite.main.config.mts) — **`raw-sql`** plugin uses **`transform`** on `*.sql` (with **`enforce: "pre"`**), emits `export default` string modules. **`assetsInclude` for `.sql` removed** so Vite does not treat SQL as static assets (avoids empty or non-inlined bundles where the transform `id` never matched `?raw`). [`bundled.generated.ts`](../src/db/migrations/bundled.generated.ts) unchanged in workflow: `npm run db:bundle-sql` after journal/SQL edits.
- **Drizzle:** New migration [`0032_pivot_tables.sql`](../drizzle/0032_pivot_tables.sql) — `pivot_nodes`, `pivot_edges`, `pivot_containers`, `pivot_beacons`, `blueprint_snapshots` (journal idx 32; `0033_rename_type_columns` is idx 33). New migration [`0034_prompts_new_schema.sql`](../drizzle/0034_prompts_new_schema.sql) — prompts table migrates to `type`, `workspace_id`, drops legacy `title`/`description` shape. [`migration_seed_verification.ts`](../src/db/migration_seed_verification.ts) updated for `0032` and `0034`.

---

## v6.0.3 — Main Vite `?raw` SQL for embedded migrations (2026-04-02)

- **Build / SQLite:** Superseded by **v6.1.0** (`transform`-based `raw-sql`). v6.0.3 briefly used `assetsInclude` + `load()` with `?raw` path checks.

---

## v6.0.2 — Workforce workspace UI, FallbackModel doGenerate (2026-04-02)

- **Workforce / workspaces:** [`AppList.tsx`](../src/components/AppList.tsx) `canAddWorkspace` now respects `status.canCreateWorkspace` and treats **Workforce** like Pro for the add/import affordance (previously only `plan === 'pro'` was unlimited; Workforce users were incorrectly limited to one workspace in the UI).
- **Diagrams / Auto:** [`FallbackModel`](../src/ipc/utils/fallback_ai_model.ts) implements `doGenerate` by delegating to the current chain model inside the existing `retry` helper, matching `doStream` semantics. Fixes AI diagram generation when Auto wraps models in `createFallback` (`generateText` → `doGenerate`).

---

## v6.0.1 — Reasoning stream closure, thinking-tag hygiene, agent docs (2026-04-02)

- **Streaming (`processStreamChunks`):** Treat `reasoning-end` like other non-reasoning parts so an open stream thinking wrapper is closed; after the stream iterator, flush the matching closing tag if still inside a reasoning block and run a final `processResponseChunkUpdate` + `cleanFullResponse`.
- **Tags / dedupe:** `removeThinkingTags` moved to [`src/ipc/utils/thinking_tags.ts`](../src/ipc/utils/thinking_tags.ts) (strip long- and short-form thinking wrappers). [`cleanFullResponse.ts`](../src/ipc/utils/cleanFullResponse.ts) `deduplicateContent` finds the earliest recognized thinking closing tag after duplicated model output.
- **Tokens:** `getMaxTokensWithFloor` in [`token_utils.ts`](../src/ipc/utils/token_utils.ts) (8192 floor when catalog omits `maxOutputTokens`); main `streamText` uses it for `maxOutputTokens`.
- **Prompt bundle:** `AGENTS.md`, `AGENTS_COMPACT.md` — identity, modes, Compass, delegation, Workforce session scope, 6.0.x version line.

---

## v6.0.0 — Workforce session scope, autonomous agents, UX hardening, Thoughts & routing (2026-04-02)

- **Workforce — Change 1 / 2:** Removed stored “base of origin” / default group-repo-workspace pre-selection for Workforce services; selections are **in-memory per chat** (`workforce-chat-session`, IPC `workforce:session:*`, `WorkforceSessionPromptDialog`). First tool use can prompt for scope; **New Chat** clears session. `buildWorkforceWorkspaceContextBlock` and stream handlers append **Connected workspace contexts (this session only)** to the Workforce prompt block. Integration OAuth flows unchanged for configured MCP servers.
- **Workforce — gate:** `ToolRegistry` / `runToolExecuteWithWorkforceSessionGate` block Workforce tools until session scope is set where required (`// Fix: Workforce-Change-N` trace comments in touched files).
- **Autonomous — Change 3:** Nested autonomous sub-agents auto-execute permissioned tools (no user queue); `logger.info('[Autonomous] Tool executed without user approval: …')`. Guided delegation permission flow unchanged. Delegation summaries append autonomous tool footers where applicable.
- **Onboarding — Change 4:** Extra steps for chat continuity, right panel resize, autonomous expectations, and session-only Workforce context (`onboarding.ts`, home/settings UI).
- **Tester findings (pre-6.0 pass):** Fullscreen IPC + `data-fullscreen` / layout CSS; pinned New Chat + workforce session clear; code route `file`/`tab` params; Ask/Plan prompts and tool gating (`write_file` Plan-only paths, blueprint tool Ask rules); streaming `chat:stream:phase`, `chat:tool:start/end`, human labels; `models.dev` 30s timeout + Sentry + `models-dev:status` IPC; Compass strip in header + inline milestone banner; `RightPanel` resize grip.
- **UI:** `ThoughtsPanel` from `activityStreamItemsAtom` (guided/autonomous); `ActivityDisplay` wiring; removed legacy `ActivityStream` / `GuidedPipeline` / `AutonomousGraph`; `AppLoadingScreen` + `atlarix-home` loading use `AtlarixAnimation`; canvas `setTransform` reset before `scale`.
- **Auto router:** `runAutoRouterAsync` + optional Stage-2 `classifyAutoRouteWithFastLLM` via `getFastModelForCurrentProvider` in `chat_stream_handlers.ts`; `RoutingDecision.recommendedAgent`; `routing_decision` activity label may include `delegate: …`.
- **Blueprint:** `BlueprintCanvas` overlay controls moved outside ReactFlow `<Panel>` to fix misaligned hit targets on **Re-layout** / **Add container** (and related overlays).
- **Hygiene:** Fixed invalid escaped quotes in `classifyAutoRouteWithFastLLM` (esbuild parse error).

---

## v5.2.3 — Linux launch, OAuth, and local-model reliability (2026-04-01)

- **Linux packaging:** Disabled Chromium sandboxing for packaged Linux builds in `forge.config.ts` and added `x-scheme-handler/atlarix` registration parity for both `.deb` and `.rpm` makers to reduce launch failures and improve deep-link install behavior.
- **OAuth / deep links:** Tightened Linux deep-link handling in `src/main.ts` so `atlarix://auth/callback` can be processed reliably both when an existing app instance receives the callback and when the app is cold-started from the protocol URL.
- **PATH / local models:** Centralized PATH refresh into `src/lib/resolve-path.ts`, reused it from startup and `reload-env-path`, and now show non-blocking warnings when Ollama or LM Studio are unreachable instead of relying on console-only failure paths.

---

## v5.2.2 — Rename reserved `type` columns in SQLite graph tables (2026-04-01)

- **SQLite / PIVOT:** Added migration `0033_rename_type_columns.sql` to rename `pivot_nodes.type` -> `node_type`, `pivot_edges.type` -> `edge_type`, and `diagrams.type` -> `diagram_type`. This fixes production crashes in packaged builds when SQLite prepares queries against those graph/diagram tables (`no such column: "type"` on `/diagram` -> `/tools` flows).
- **Drizzle ORM:** Updated `src/db/schema.ts` and the affected persistence/query code to use `nodeType`, `edgeType`, and `diagramType`, while keeping renderer IPC responses normalized to `diagram.type` for UI compatibility.

---

## v5.2.1 — Supabase OAuth browser-open fallback (2026-03-31)

- **Auth:** `src/lib/auth/supabase-client.ts` now wraps `shell.openExternal()` for Supabase OAuth in a nested `try/catch`, logs success/failure explicitly, and on **Linux** shows a fallback dialog with the OAuth URL plus **Copy Link** when the browser cannot be opened automatically. This avoids silent sign-in failure while leaving the existing `atlarix://auth/callback` deep-link handling unchanged.

---

## v5.2.0 — Embedded SQLite migrations (2026-03-31)

- **SQLite:** Replaced filesystem `drizzle/` + Drizzle `migrate()` with **embedded SQL** in the main bundle (Vite `?raw`, [`src/db/migrations/bundled.generated.ts`](../src/db/migrations/bundled.generated.ts) generated by `npm run db:bundle-sql` / `postdb:generate`). New ledger **`__atlarix_migrations`**; legacy **`__drizzle_migrations`** rows are **bridged** by SHA-256 hash map. **Unknown hashes:** `logger.error` + **Sentry** + thrown `UnknownDrizzleMigrationHashError` (no silent swallow); DB wipe retry is **skipped** for that error. Packaged apps no longer need `drizzle` in Forge `extraResource`; `drizzle/` is excluded from the asar via [`forge.config.ts`](../forge.config.ts) ignore (SQL still lives in repo for Drizzle Kit).
- **Drizzle ORM:** Unchanged for schema types and queries (`schema.ts` untouched).

---

## v5.1.5 — Move ensure* safety nets after migrate() (2026-03-31)

- **Fix:** Moved all `ensure*` table-bootstrap calls (mcp_servers, blueprints, pivot tables, etc.) to run **after** `migrate()` instead of before. On a fresh DB (e.g. after auto-recovery deletes the corrupt one), `ensure*` would create tables like `mcp_servers`, then `migrate()` would fail with `CREATE TABLE mcp_servers` (no `IF NOT EXISTS` in migration SQL). Now `migrate()` runs first on a clean slate, and `ensure*` only fills gaps for legacy DBs afterward.

---

## v5.1.4 — SQLite auto-recovery on bad local DB (2026-03-31)

- **SQLite:** After `migrate()`, the app verifies core tables (`apps`, `chats`, `messages`, `language_model_providers`, `language_models`, `prompts`) and, when bundled migrations are available, that `__drizzle_migrations` exists with at least one row. If validation fails, it closes the DB, deletes `sqlite.db` plus `-wal`/`-shm`, and retries initialization **once** (only when a `drizzle/` folder is found on disk—no infinite wipe if migrations are missing). Fixes partial “bootstrap-only” DBs (e.g. ensure* tables without `chats`). The renderer stays on the existing loading gate until init succeeds.
- **Hygiene:** Removed temporary debug ingest `fetch` calls from `src/db/index.ts`.

---

## v5.1.3 — Packaged app: Drizzle migrations path (2026-03-30)

- **Production:** `drizzle/` is bundled via Electron Forge `extraResource` (unpacked under `Resources/drizzle`) so SQLite migrations are always on a real filesystem path.
- **Runtime:** `resolveDrizzleMigrationsCandidateFolders()` tries `process.cwd()`, `process.resourcesPath`, `app.getAppPath()`, then `__dirname`-relative paths; logs each candidate’s existence and the folder used. Fixes packaged builds where `migrate()` never ran (`no such table: chats`, `language_model_providers`, etc.) while `npm start` worked.

---

## v5.1.2 — Verified Drizzle journal seed + maintainer docs (2026-03-30)

- **SQLite:** `seedDrizzleMigrationsIfNeeded` now inserts `__drizzle_migrations` rows only while each journal migration’s effects are detectable in the DB; `migrate()` applies genuinely pending SQL. Prevents “empty journal + partial schema” installs from skipping migrations and breaking features (`chats`, MCP, etc.). Verifiers live in [`src/db/migration_seed_verification.ts`](../src/db/migration_seed_verification.ts).
- **Docs:** README Development Setup documents the requirement to update `migration_seed_verification.ts` whenever `_journal.json` gains a migration.

---

## v5.1.1 — SQLite MCP tables bootstrap (2026-03-30)

- **SQLite:** `ensureMcpBaseTablesIfNeeded()` creates `mcp_servers` and `mcp_tool_consents` when missing (migration 0012 baseline). Fixes `mcp:list-servers` → `no such table: mcp_servers` when `__drizzle_migrations` was seeded so Drizzle skipped applying migration 0012.

---

## v5.1.0 – Compass, usage limits, onboarding (2026-03-29)

- **Compass:** Managed cloud provider (OpenRouter-backed, single build-time key). Default model **Compass Fast**; Pro/Workforce unlock Balanced and Thinking. OpenRouter removed from user-facing settings and model labels.
- **Supabase:** `compass_tokens` + `get_compass_usage_state` / `record_compass_usage` for monthly token accounting (30-day reset). See `docs/compass-limits.md`.
- **Settings:** Collapsible model-provider grid with search and pagination (Compass pinned on page 1); Compass card shows tier copy and usage bar.
- **Chat:** Usage strip + exhausted state with upgrade / Settings CTAs; milestone toasts at ~50% / 25% / 10% remaining; usage refetches after Compass turns.
- **Onboarding:** Three post-login product steps (Compass → BYOK in Settings); diagram/workspace funnel steps removed from the default tour.
- **CI:** `COMPASS_*` secrets in `release.yml` and `vite.main.config.mts` `MAIN_KEYS` (main process only).

## v5.0.0 – Blueprint context & memory (2026-03-26)

- **Tiered Blueprint prompt injection (Sections 1, 3, 4):** Blueprint context is now routed through `blueprintPromptTiers.ts` with explicit Ask / Plan / Build / Debug tiers. Settings and the chat Config dropdown can force a tier per session, and Auto mode falls back to heuristics based on work mode and prompt.
- **Project memory & snapshots (Section 2):** New `project_snapshots` and `project_memory` tables (migration `0031_project_memory.sql`) plus `ensureProjectMemoryTablesIfNeeded` in `db/index.ts`. Snapshots track blueprint + plan state across sessions; tools (`get_project_history`, `set_project_memory`, `revert_to_snapshot`) expose this to the AI with an approval-gated `revert_project_snapshot` action.
- **`.atlarixignore` end‑to‑end:** Gitignore-style patterns are respected in RTE parsing, Blueprint cache loading, and prompt assembly. A default `.atlarixignore` is created on first parse; `get_atlarixignore` / `update_atlarixignore` tools and the Blueprint panel editor keep AI context bounded to relevant files.
- **Work modes + Auto routing:** Ask / Plan / Build / Debug / Review work modes now bind cleanly to Blueprint tiers and model routing. Auto decides between Fast / Balanced / Thinking based on mode/role, while manual mode selection and overrides still work as before.
- **MCP server tier gating:** MCP free-tier limits now respect the authenticated subscription (via `SubscriptionManager.isPro()` and `useAuth().status.plan`) instead of raw credit budget, so Pro/Workforce users can add multiple MCP servers without seeing the “Free tier is limited to 1 MCP server” banner.
- **Auto model configuration UX:** Auto mode lets you pick one provider and up to three models (Fast / Balanced / Thinking). The Config dropdown seeds tiers from provider favorites, supports 1–3 configured tiers, and uses an ordered fallback chain when a model fails.

---

For detailed historical notes (v1.x–v4.x) and implementation phases, see [`docs/previous-versions.md`](previous-versions.md) and the v5.0 tables in [`docs/TODO.md`](TODO.md).

## Atlarix product summary (for model and blueprint accuracy)

- **PIVOT:** From Code to Canvas, Canvas to Code. **Containers** and **Beacons** are the main diagram concepts. The **Blueprint** is the living diagram (RTE + RAG). **RTE** (Round-Trip Engineering): parsers (TypeScript, Python) extract structure; single and **combined blueprints**; diagram types: architecture, dependencies, flows. **RAG:** queryBlueprint, getCodeForNodes; file watcher for incremental updates.
- **Modes:** **Ask** = read-only (code search, web search, read_file, list_files, get_diagram, git_status; no terminal, no code gen/modification). **Build** = full tools (run_command, write_file, delete_file, etc.). Permission flow: user approves before execution.
- **Agents:** Research, Architect, Builder, Reviewer. Delegation: **Guided** (flat) or **Autonomous** (nested, depth limit). Model tiers: **Fast** / **Balanced** / **Thinking** (e.g. OpenRouter favorites); Auto routes by mode/role.
- **Workspace:** `.atlarix/memory.md`, `.atlarix/spec.md`; project instructions; token budget per provider; context bar + auto-summarize.

---

## v4.3.0 — UX and workflow update (2026-03-23)

### Added

- **Batch workforce permissions:** New `request_workspace_permissions(services[])` flow opens one unified Token Auth panel for multi-service access.
- **Ollama recommender panel:** Hardware-aware model recommendations with one-click pull and quick model selection in provider settings.

### Changed

- **Workforce Ask/Build behavior:** Ask mode is strictly read-only for Workforce tools; write/trigger actions are Build-only with approval.
- **Ask-mode planning:** ATLARIX plan-writing tools are available in Ask mode with approval, while code changes remain Build-only.
- **Release docs and metadata:** README/TODO/changelog/version metadata aligned to the 4.3 release.

### Fixed

- **Session persistence:** Secure auth session restore and refresh on startup, plus explicit logout secret clearing.
- **Subscription UX:** Correct active vs cancelled-within-period vs expired messaging and entitlement timing.
- **Token Auth lifecycle:** New chat clears prior Token Auth sessions and exposes connected-service indicators in chat UI.

---

## v4.2.0 — Bug fixes and security (2026-03-18)

### Improvements

- **Easier onboarding**: Sign-in and “Skip” buttons are now fully visible and no longer hidden under the window controls, so you can get started without any hassle.
- **More secure and stable**: The app now uses a simpler, more secure sign-in flow and has removed legacy backend pieces for a more reliable experience.
- **Under the hood**: Updated integrations and stability improvements across the app for better compatibility.

---

## v4.0.0 — Workforce (2026-03-16)

### Added

- **Workforce tier** ($79/mo): Up to 5 seats; extra seats $10/mo. Teams, MCP-configured integrations, Workspace Context, and all Workforce extensions.
- **Agent authentication for integrations:** OAuth and API credentials are configured per MCP server; high-stakes actions use approvals and per-integration re-auth as applicable.
- **Workspace Context** (Workforce only): Injected block after system prompt with open PRs, failing pipelines, assigned tickets, unread mentions, Sentry errors, today's meetings from connected extensions.
- **Teams**: Create team, invite members, manage seats; shared .atlarix (team-memory.md, Blueprint) via Git; effective tier = max(own plan, team plan).
- **Workforce extensions**: Slack, Google Chat, Jira, Linear, Sentry, Notion, Google Calendar, GitLab CI, Bitbucket Pipelines — connect via configured MCP servers and credentials in Settings.
- **Progressive Tool Reveal**: Tool manifest (one line per tool) in system prompt; full schemas loaded on first use; core tools always loaded.
- **New AI tools**: get_slack_mentions, get_slack_channel, post_to_slack; get_assigned_tickets, update_ticket_status, create_ticket, get_sprint_status; get_sentry_errors, get_sentry_error_detail; get_today_schedule; trigger_pipeline, cancel_pipeline. Read-only in Ask mode; write/trigger with approval in Build.
- **GitLab CI & Bitbucket Pipelines**: CIPlatform implementations using MCP-configured credentials; list runs, jobs, logs, stream.
- **Conversation rollback** *(superseded in v6.2.0 by unified snapshots):* Earlier releases restored file state from a snapshot tied to a chat turn. **Current behavior (v6.2.0+):** restore files and diagram from `.atlarix/snapshots/`; the full transcript stays visible with `is_reverted` markers — messages are not deleted. **Hash metadata (v6.2.1+):** `snapshot_hashes.json` is stored under `.atlarix/snapshots/` with one-time migration from the legacy root `.atlarix/snapshot_hashes.json`.

### Changed

- **DB Studio** moved from Pro to Workforce; existing Pro subscribers grandfathered (has_db_studio_legacy).
- **Pricing**: Three tiers — Free ($0), Pro ($19/mo), Workforce ($79/mo).
- **Build mode tools**: Manifest includes all tools; progressive reveal filters full schemas to loaded + core.

### Technical

- Drizzle migrations: teams, team_members, users.team_id, users.effective_tier, users.has_db_studio_legacy; workforce_connected_services; tool_session_loads.
- Supabase migrations and RLS for teams.
- LemonSqueezy webhook extended for Workforce and teams (idempotent).
