# Atlarix Changelog

## [13.1.5] (2026-06-12) — Open-weight harness hardening: command sandbox, parallel-research orchestration, Hugging Face, Blueprint-backed grep

> Ships the full v13 line (see [13.0.0] and the v13.1 follow-ups below) plus this cycle's hardening.
> Atlarix is a private, any-model, local-capable agent harness with verified-edit rigor.

### Added

- **Per-OS write-confining sandbox for `run_command`.** Agent shell commands run inside an OS sandbox
  that confines filesystem **writes** to the workspace + temp + package caches (network stays on,
  reads stay broad): macOS **Seatbelt** (`sandbox-exec`), Linux **bubblewrap** (`bwrap`), Windows
  **AppContainer** (bundled `atlarix-sandbox.exe` helper). Agent-only — the user's interactive PTY
  tabs are never sandboxed. Toggle via `sandboxRunCommand` (default on where available) or
  `ATLARIX_DISABLE_SANDBOX=1`; graceful fallback if the OS tool is missing.
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
