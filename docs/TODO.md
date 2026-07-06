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

- **chat_stream_handlers.ts deep decomposition — IN PROGRESS (2026-07-06).** 8k-line god-file.
  STAGE 0 STARTED (commit aac0f7a): `chat_stream/message-postprocess.ts` extracted (pure tail),
  full suite + 73 agent-evals green. REMAINING: rest of STAGE 0 (permission-ui @~325-501,
  network-retry @~1081-1145, stream-utils), STAGE 1 (shared-state satellites: stream-registry,
  pending-ui-state, interrupted-draft, revert, activity-emitters, tool-execute), STAGE 2 (deep:
  `StreamTurnContext` + runner/ask-branch/build-branch — the plan's highest-risk item, do with
  fresh focus). Pattern: extract to `chat_stream/<topic>.ts`, parent imports-for-internal +
  re-exports public API; gate each stage on check + vitest + `--project agent-evals`. Plan +
  StreamTurnContext field list in the design pass; compiler-driven same-file extraction to make
  the context contract a tsc checklist.
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
