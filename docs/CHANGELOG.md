# Atlarix Changelog

## [Unreleased]

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
