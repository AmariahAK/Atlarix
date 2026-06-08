# Atlarix v12.5.0 — Discord technical post

> Paste-ready for the Discord announcements channel. The last technical post was **v10.1.0**, so this catches everyone up across **v11**, **v12.0**, and **v12.5** in one go. (The tag-triggered Action also auto-posts the `[12.5.0]` changelog section; this doc is the full recap.)

---

**Atlarix v12.5.0 released** 🎉

Release notes (technical) — everything since v10.1:

This is the **first tagged build of the v12 line**. The v11 feature batch and the v12.0 engine rewrite were never tagged separately, so they ship here together with the v12.5 stability work. Grouped by release below.

---

**🚀 v12.5 — concurrency & stability (new in this tag)**

- **Concurrent sessions:** Starting a second workspace session no longer overwrites/hides the first. Open sessions now show as **tabs** above the chat (each with a live streaming dot) and the sidebar shows a per-session running indicator — background streams stay reachable. (Per-chat state was already isolated by chat id in the backend; the bug was the renderer unconditionally replacing the active chat on open.)
- **Interrupted-turn recovery:** A turn cut off by an abrupt quit, OS sleep, or crash is no longer lost. The main process throttle-persists partial assistant output to the session DB (`session_messages.status = interrupted`), force-flushes on abort / `before-quit` / `powerMonitor` suspend, and deletes the draft on clean completion. On reopen you get the partial output plus a **Continue** button that resumes the turn.
- **Keeps working while the display sleeps:** A refcounted `powerSaveBlocker('prevent-app-suspension')` is held while any stream is active, so long tasks keep progressing when the screen sleeps. (Lid-close / full system suspend is OS-enforced — partial work is flushed first.)
- **Switch-provider prompt on Core exhaustion:** Running out of the monthly Core token pool (or Core being unreachable) now shows an actionable banner — **Choose another model / Switch provider** (opens Settings → AI) + upgrade link — instead of a bare error.
- **Fixes:** the inline **"A" indicator** now persists after a turn (was vanishing when a trailing continuation message was appended); the Core token-pool stop no longer cascades into an `AI_NoOutputGeneratedError` (the agent loop hard-stops on abort); Core dispatches no longer over-prune to a 200K window on the first turn (use the real per-tier window, e.g. 1M for Core 3); **login is now required** to open a workspace (UI + backend); folder/file tools emit **plain text** (no emojis).

---

**🧠 v12.0 — the engine release**

- **One unified agent engine:** Every mode (Explore/Plan/Build/Debug/Review) runs the same `runAgentTurn` loop. The four divergent per-mode loops are gone, so cross-cutting fixes land once. Bugs found and fixed in the process: Plan mode never actually offered its plan-writing tools, loop-detection corrections never reached the model mid-round, and approving `run_tests` ran the wrong operation.
- **Native tool-call history:** Tool calls/results are carried as real provider-native blocks instead of being flattened to text. Weak and local models improve a lot, prompt caching holds across multi-step turns (byte-stable history), and `browser_screenshot` is finally visible to vision models.
- **Edit verification in the loop:** After each round's writes, LSP diagnostics feed straight back to the model, and a turn can't claim completion on top of broken code (`enableAutoFixProblems` now actually does this). Failed `edit_file` matches return the closest-candidate region with re-read guidance.
- **Per-model capability profiles:** Strong models get the full ~38-tool surface; weak/local models get a trimmed, core-first set with simpler schemas. Tool resolution is one documented 4-stage pipeline.
- **Portable permissions + hooks:** `.atlarix/permissions.json` (committable allow/deny/ask rules, Claude-Code-style `tool(glob)` patterns) enforced at the single tool-execution funnel, with a `~/.atlarix/permissions.json` global layer beneath it. File-based `.atlarix/hooks/hooks.json` adds blocking `pre_tool_use`, advisory `post_tool_use`, and a `stop` gate that can hold `task_complete` until your check passes.
- **User-defined agents:** Drop `.atlarix/agents/<name>.md` (system prompt + mode + optional model/tool allowlist) into a repo and it shows up in the mode picker — committable, so teams share them with the code.
- **Background agents:** Spawn detached agents that run a full turn into their own session — read-only by default, or write-capable with auto-captured writes behind a shadow-git **keep/revert** review. Status/cancel/keep-revert live in an Agents panel tab and survive app restarts.
- **BYOK cost estimate:** Each turn on a BYOK provider shows an estimated USD cost (provider pricing or a maintained table — never guessed).
- **Blueprint v2:** Aliased imports (`tsconfig` paths, package `#imports`) resolve to real edges; slices are relevance-ranked (BM25 over symbols fused with graph centrality) with ctags signatures inline; under-reported dynamic call sites are disclosed instead of dropped. Measured baseline: **get_blueprint precision@1 = 100%** vs 45% for raw lexical search.
- **Faster first token:** the pre-flight pipeline is instrumented end-to-end and parallelized (context-section loads run concurrently; wall-clock = slowest load, not the sum).
- **Agent-eval harness:** 55 behavioral evals drive the real chat engine against a scripted in-process LLM + a real temp DB.

---

**🌐 v11 — browser, WebMCP, Atlarix Core, document readers, much lighter app**

- **In-app browser (WebContentsView):** a real Chromium surface in the right panel (immune to X-Frame-Options) with tabs/URL bar/history, isolated session, `sandbox: true`, http(s)-only, popups/downloads/camera/mic/geo denied. Agent tools: `browser_navigate` / `browser_read_page` / `browser_screenshot` everywhere, `browser_click` / `browser_fill` in Build/Fix. Page text + screenshots reach the model wrapped in an untrusted-content envelope.
- **WebMCP:** pages that register tools via the W3C draft `navigator.modelContext` expose them through `list_webmcp_tools` / `call_webmcp_tool` (Atlarix shims the API in the browser preload; `execute` stays in the page over IPC with a 20s timeout; tools clear on navigation; treated as untrusted).
- **Document readers:** `read_attachment` now extracts **.pptx** (per-slide), **.odt**, **.rtf**, and structured **.csv** alongside pdf/docx/xlsx; spreadsheets/CSVs render a table card in chat.
- **Compass → Atlarix Core:** the three plan-gated tiers became **four Core slots (Core 1–4)**; **every plan can use every Core model**, governed strictly by the monthly token pool in Supabase (limits read from the server, never hardcoded). Legacy `compass-*` ids keep resolving.
- **Strict mid-task token enforcement:** Core usage is recorded per agent step (awaited at each boundary), so a turn stops immediately mid-task when the pool runs out — partial response saved with a note — and the old multi-step undercount is fixed.
- **ask_user ends the turn (Claude-Code-style):** questions end the assistant turn (no 30-min timeout); the model batches all its questions up front, the card survives restart, and answers become a real Q→A message that resumes the task.
- **Context-overflow self-recovery + durable compaction:** on a provider "context length exceeded", Atlarix lowers its cached window estimate, force-compacts, and retries once; compaction summaries persist and history is sliced from the last summary on reload. Real local-model context windows are queried from Ollama/LM Studio instead of hardcoded guesses.
- **Much lighter app:** system `git` instead of bundled dugite (-142MB); the `packageAfterPrune` `npm install` that was silently reconciling the full dep tree into the asar is fixed (1.28GB → reasonable); `geist` font package vendored as woff2; large knip/dead-code sweep.

---

Full technical changelog: `docs/CHANGELOG.md`. Downloads: **atlarix.dev**. As always — feedback welcome. 🙏
