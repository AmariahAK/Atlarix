# Atlarix TODO

**Current Version:** v14.8.11 (2026-07-04)
**Last Updated:** 2026-07-06

## ✅ Implemented, pending owner smoke + release (2026-07-06) — native-git reads, Code tab removal, universal language support

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[Unreleased]`. Lean summary — three
workstreams: (1) production Sentry `null.slice` fix — local git ops are native-git-only
(isomorphic-git = lazy no-binary fallback for clone/push/set-remote; `enableNativeGit` setting
deleted; `list-versions` degrades to `[]` with one warning per workspace); (2) Code tab + Monaco +
QuickFileOpen DELETED (single-consumer Monaco was the largest un-chunked renderer dependency;
shiki chat highlighting, SmartDiffView diffs, Errors tab, approve flow all unchanged; @ mentions
kept; copy-code-chip pipeline removed with its only producer); (3) universal language gates —
ctags allowlist deleted (auto-detect + 2 MB size guard), `SymbolRecord.language`, ctags-only
blueprint engine (no more null cliff), workspace-analyzer consolidated onto the ctags index with
one universal import-pattern pass. Then (4) ast-grep/blast-radius/dead-blueprint-chain MAXIMAL
prune — consumer trace proved grep reranking is ctags+FTS5 only and edges fed ONLY the (silently
broken in packaged builds) blast-radius line; watcher slimmed to `search-index-watcher.ts` with
the FTS5 refresh decoupled from the dead cache refresh; 3 native deps + worker + forge grammar
machinery gone; run_command now steers find/grep → glob/grep tools. tsc/oxlint clean; vitest
1578 green. Then (5) **Automations SHIPPED** (Codex-app-shaped): migration 0066, schedule
(node-cron) + GitHub-poll + MCP-poll triggers (deterministic, cursor-seeded, no LLM in loops),
unattended agent runs via the headless fake-sender/auto-approve spine in-process (dangerous
ALWAYS denied, 10-min budget, concurrency 1), read-only default + opt-in worktree-write
proposals (git apply --3way from the feed), triage feed tab with unread badge +
nothing-to-report auto-archive, sonner/OS notifications, background chat_sessions transcripts
(v12 kind="background" scaffold finally written), boot recovery of interrupted runs. vitest
1600 green.

---

## ✅ Shipped in v14.8.11 (2026-07-04) — attachment fidelity, edit re-indentation, honest compaction, real context windows, ordered stream UI

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md). Lean summary — 12 workstreams in 4 clusters,
all observed live failures (DeepSeek v4 pro session + five-sweep investigation): edit_file fuzzy
matches re-anchor new_content to the file's REAL indentation (fixes opencode's own ported
verbatim-splice gap — references, not goals); deterministic attachment ids + persist-retry +
edit-path modelContent regeneration (interrupted turns no longer replay empty stubs);
read_attachment pages the FULL extraction (200K total caps gone, read_file-parity offset/limit,
extract cache, shared preview whitelist, rawBase64 bloat dropped); attached images ride the
screenshot media pipeline (shape-gated, vision-gated) AND embed directly in the user message as
native image parts on vision dispatches (no tool round-trip);
compress_context truthful (forces past the 60% gate, meter-scope ratio, ONE exact counter,
success-gated banner); context limits provider-uniform (per-model hardcode table DELETED —
override → OpenRouter catalog → provider row → models.dev → logged fallback; native DeepSeek
sees its real 1M); dead positive-id legacy branches removed (+ auto-memory & self-correction
husks); sub-agent thought segments rotate at tool boundaries (cards interleave like the main
chat); IPC-only compaction cards weave inline by timestamp; edit-box keeps attachment chips;
preflight gap attribution (`gap-after-*`). Post-smoke batch (same release): provider-agnostic
vision detection via models.dev modalities (native DeepSeek v4 sees images; placeholder forbids
filename-guessing), sub-agent popup summary unwrap, tab-title rename sync, lazy PDF pre-extract,
S18 tokenizer LRU memo (data-backed by gap attribution), local providers await real windows;
attachments are chat/session-scoped (session UUID primary — no cross-session leaks, survives
relaunches) and edit-resends rebuild the attachment directive + re-embed images.
tsc/oxlint/knip clean; vitest 1658 green; owner-smoked across 4 packaged-app rounds.

Follow-ups deferred: none — W11 escape A/B PASSED in owner smoke (DeepSeek, clean tab-indented
diff); S18 done via tokenizer memo (gap data from the smoke session).

---

## Open follow-ups

- **BUG (needs triage): model reports a background command "done" while it is still running.**
  Observed live on DeepSeek — the model repeatedly polls the background job, narrates
  "waiting"/"still running", then prematurely claims the task completed (and in one case declared
  "zero regressions" / marked plan steps done) before the background `run_command` had actually
  exited. Unknown root cause: (a) prompting (the background-command / `run_command background:true`
  guidance may invite optimistic "done" narration), (b) harness (background-result delivery / the
  wake-on-exit event — does the model get a clear, unambiguous "job still running" vs "job exited"
  signal? is the exit result actually re-injected before the model concludes?), or (c) DeepSeek
  behavior (weak at honoring async tool state). Investigate via a live DeepSeek run + the stream
  debug logs; determine which layer, then fix at that layer. NOT this session (decomposition first).

- **chat_stream_handlers.ts deep decomposition — STAGE 2c REMAINING (branch `decompose-chat-stream`,
  2026-07-07).** God-file 7984 → 6452 lines; 12 cohesive `chat_stream/*.ts` modules extracted, all
  gated on check + ts:main/ts:tests + node/renderer + `--project agent-evals` (73 pass).
  - DONE: STAGE 0 (6 pure-leaf modules: message-postprocess, permission-ui, sentry-safe,
    compaction-activity, tool-execute, network-retry, stream-misc); STAGE 1 (stream-state = the
    shared Maps + ActiveStreamRegistry + `let`-accessors; stream-lifecycle = resolveModeChange /
    resolveAskUserToolResult / interrupted-draft trio / clearChatStreamStateForChat / abortAllStreams
    / cancelStreamForAutomation); STAGE 2a (lifecycle-handlers = cancel/abort/reconnect/edit-message;
    revert-handlers = the 8 snapshot/revert IPC handlers); STAGE 2b (context-sections = the 7
    per-turn prompt-section loaders, taking an explicit ContextSectionParams).
  - **REMAINING = STAGE 2c (highest risk, DEDICATED SESSION).** Everything left is inside
    `chatStreamHandler` → nested `runStream` (~4500 lines). The blocker is a ~90-field IMPLICIT turn
    context — bare `let` accumulators (`fullResponse`, `nativeTurnMessages`, `filesWrittenInThisExchange`,
    `turnInput/Output/CachedInput/CacheCreation/ActualCost` tokens, `maxTokens/ReasoningUsed`), control
    flags (`askUserEndedTurn`, `turnForcedTextFinish`, `turnParked`, `streamTerminated`,
    `stopAgentOrchestrator`), and compaction-REASSIGNED assembly locals
    (`systemPrompt`/`limitedMessageHistory`/`contextAssemblerBlob`/`dispatchEstimate`/`budgetTracker`).
    Every meaningful closure (ask-branch, build-branch, `runStreamRoundWithEmptyOutputRetry` incl. the
    per-round abort re-link listener-in-finally, `runCompressAndRebuild`, `simpleStreamText`,
    `processResponseChunkUpdate`, finalization/persistence) mutates these — so extraction REQUIRES
    formalizing them into a mutable `StreamTurnContext` object (fields, not value params) FIRST, then
    rewiring runStream to `ctx.field`. Invariants to preserve verbatim: the single per-turn
    `AbortController` + every cooperative `signal.aborted` check-point; `retriedAfterOverflowCompaction`
    stays in the OUTER shell (overflow re-invokes runStream). Deferred here (not this session) because a
    ~4500-line ctx rewire can't be completed with byte-stability safety in one pass — attempt it with
    fresh focus, one closure at a time, agent-evals byte-stability gate between each.
  - Note: full combined `npm test` (node+renderer+agent-evals together) shows load-sensitive flakes on
    git-worktree/timing tests (e.g. subagent-cancel) — they pass per-project in isolation; gate on the
    per-project runs, not the combined one.
- `.gitignore`-render profiler (carried from v14.8.10 §3.4).
- Atlarix GitHub account for contributor credit — owner action; code side done (v14.8.10).
- User-message multimodal content parts for HISTORICAL turns (current + edited turns embed
  since v14.8.11; history still round-trips via read_attachment on tool-media-capable APIs).
- **Dependency deprecation triage (own its own session).** Scoped, NOT a blanket "zero
  warnings" chase (dangerous here: @ai-sdk/anthropic MUST stay 2.x w/ ai@5 [[atlarix-ai-sdk-version-trap]];
  zod mid-v4-migration; 3 deliberate patch-package patches; ABI-pinned better-sqlite3/node-pty/keytar).
  Worklist = `npm outdated` (DIRECT deps only) + `npm audit` + own-code deprecated-API usage + CI
  action deprecations (those hard-break on EOL date, unlike lib warnings) + genuinely-abandoned
  deps. Fix (a) ours, (b) security, (c) EOL; consciously LEAVE pinned/transitive with a note.
  Safety net = the packaged `--self-test` smoke (Phase 2 of the current release). Own branch.

> Open work + the current release only. **Full shipped-version history lives in
> [`docs/CHANGELOG.md`](./CHANGELOG.md)** (and `docs/CHANGELOG_PREVIOUS.md`).
