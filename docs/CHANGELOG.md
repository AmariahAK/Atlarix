# Atlarix Changelog

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
