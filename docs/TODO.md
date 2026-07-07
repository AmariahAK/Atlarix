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

- **BUG (needs triage): not every approval wait is truly indefinite — some paths time out.**
  The agreed contract is that EVERY human-in-the-loop wait (command approval, file-write/permission
  approval, `ask_user`) blocks INDEFINITELY — the user may not answer for hours, and the turn must
  sit and wait, not proceed or abort on a timeout. Observed: some waits still have an AI/tool-side
  timeout and give up (or auto-resolve) instead of waiting. Audit every wait path for a hidden
  timeout: `waitForApproval` (permission interceptor — v14.7 was made indefinite mid-loop, verify no
  regression), the run_command permission queue, `ask_user` (should end the turn and resume on the
  next message — confirm it never times out mid-wait), MCP auth/consent waits, and any
  `AbortSignal.timeout`/`setTimeout`-backed race around these. Reproduce via a live run + the stream
  debug logs (leave a prompt pending for a long interval and watch for a timeout firing). Fix = make
  all of them wait until the user (or an explicit Stop) resolves them. NOT this session (decomposition
  first). [[atlarix-command-safety-model]]

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

- **chat_stream_handlers.ts deep decomposition — STAGE 2c IN PROGRESS (branch `decompose-chat-stream`,
  2026-07-07).** God-file 7984 → 6231 lines; 14 cohesive `chat_stream/*.ts` modules, all gated on
  check + ts:main/ts:tests + node/renderer + `--project agent-evals` (73 pass).
  - DONE: STAGE 0 (message-postprocess, permission-ui, sentry-safe, compaction-activity, tool-execute,
    network-retry, stream-misc); STAGE 1 (stream-state, stream-lifecycle); STAGE 2a
    (lifecycle-handlers, revert-handlers); STAGE 2b (context-sections). **STAGE 2c so far:**
    session-handlers (the 3 early IPC handlers); **turn-context.ts — the StreamTurnContext object is
    FORMALIZED and the ~26 Group-A accumulators/flags migrated from bare locals to `ctx.*`
    (byte-stable)**; turn-runner/prompt-bundle (buildPromptBundle, pure, via PromptBundleDeps).
  - **STAGE 2c payoff extractions — 2026-07-07 session (on `main`, one gated commit each).** God-file
    6231 → 5031 lines (−1200). Each `fn(ctx, deps)` in `chat_stream/turn-runner/*.ts`, body verbatim,
    gated (ts:main/ts:tests/check:ts/oxlint + per-project agent-evals 73 / node 1484 / renderer 58):
    - **prep A** (cf1f8fe): `pendingEmptyOutputNudge` promoted onto `ctx` (cross-closure mutable).
    - **(1) simpleStreamText** (cbef57f) → `turn-runner/simple-stream-text.ts`; ~23-field deps bundle
      built after the assembly call; both call sites pass `(ctx, deps, args)`.
    - **(2) runStreamRoundWithEmptyOutputRetry** (ca7e5a3) → `turn-runner/round-retry.ts`; per-round
      abort re-link verbatim; 3 loop consts + `isEmptyOutputStreamError` alias moved into the module;
      call sites wrap it typing `params` as the fn's own param type (method-slot bivariance).
    - **(3) processResponseChunkUpdate** (48bb4cd) → `turn-runner/response-chunk-update.ts`; keeps its
      OWN `fullResponse` param; thin bound local keeps the callback slots unchanged.
    - **(4) context-assembly IIFE + runCompressAndRebuild** (b9a3fcd) → `turn-runner/context-assembly.ts`.
      **Used return-style threading, NOT the planned `ctx.assembly` shared-mutable** — the caller passes
      the working set as `state`, the fn mutates its own locals (runCompressAndRebuild nested inside) and
      returns the final set + `proactiveContextReminderForStream` for write-back. This avoided a
      119-occurrence `ctx.assembly.*` rename across destructures/shorthands (lower risk, same behavior).
      `limitedMessageHistory` typed `any[]` (mirrors runStream: updatedChat is `any`).
  - **REMAINING — the HIGH-risk branch arms + finalization (NOT yet done).** `runAskBranch` (~757 lines,
    2274-3030), `runBuildBranch` (~1439 lines, 3031-4469), and inline `finalizeTurn` (save-gated block) +
    `handleTurnError` (main catch, needs a `() => runStream()` re-invoke thunk for the overflow arm).
    **Concrete scope measured 2026-07-07:** the ask arm alone captures ~35 module-import sources + ~40
    runStream-local free vars (many function-typed closures: `buildRoundSystemPrompt`, the `handle*`
    callbacks, `applyTierEscalation`, `logTtftOnce`, permission/tool wiring…); build arm ~2×. Each
    extraction yields a 40+-field `Deps` interface of mostly function types — line-count-only benefit,
    disproportionate regression risk vs. the tangled pieces already extracted. Invariants to hold
    verbatim: single per-turn `AbortController` + every `signal.aborted` check; save gate
    `!signal.aborted || ctx.askUserEndedTurn || ctx.turnForcedTextFinish`; `retriedAfterOverflowCompaction`
    in the OUTER shell; `ensureTerminal` idempotency latch. If revisited, consider extracting the SHARED
    sub-helpers (permission-interceptor setup, runAgentTurn-config assembly) rather than the whole arms.
  - Note: gate on PER-PROJECT vitest runs — the combined `npm test` shows load-sensitive flakes on
    git-worktree/timing tests (e.g. subagent-cancel); they pass per-project in isolation.
- **BUG (needs triage): Shift+Tab mode switch doesn't fire while the app is busy.**
  Shift+Tab cycles the work mode (Build ↔ Explore ↔ Plan ↔ Debug ↔ Review), but it is
  unreliable when something is in progress — e.g. while typing in the composer, or while a
  turn/stream is running the keybind is dropped, so the user can't flip modes mid-flight the
  way Claude Code lets you. Suspected cause: the shortcut is bound in a context/scope that
  loses focus or is disabled during active work (composer capturing the key, a global-shortcut
  registration gated on idle state, or an input-focus guard). Fix = make the mode-cycle
  keybind global and always-live (fire regardless of composer focus or in-flight stream),
  matching Claude Code's behavior. NOT this session (decomposition first).

- **BUG (needs triage): the "vision model" gate on the attach path is stale — modern non-vision-tagged
  models still see images everywhere EXCEPT our attachments.** The current attachment system was built
  on the outdated assumption that only models tagged as vision-capable can see images. By today's
  standards most models can — and the owner confirms it concretely: **DeepSeek v4 pro, DeepSeek 3.2,
  Qwen 3.7, Qwen 3.6 (both "plus")** are NOT tagged as vision models, yet (a) they read website
  **browser screenshots** fine in Atlarix, and (b) they read uploaded images fine on the models' own
  official web UIs. Only Atlarix's **attached-image** path fails for them. So the failure is our
  vision-tag gate, not a model limitation. Two same-model comparisons pin it:
  - **Browser screenshot vs. attachment (same model, same app):** screenshots ride the tool-result
    media path and reach the model; attachments (v14.8.11) only EMBED as native image parts "on vision
    dispatches" — i.e. gated on the models.dev vision/modality tag — so for these untagged models the
    embed is skipped and the image never goes out. Find why the screenshot path reaches them but the
    attach path is gated off, and deliver attachments the same way regardless of the vision tag.
  - **Their official web UI vs. us:** the vendors accept images for these same untagged models, so the
    tag-based "is this a vision model" check is the wrong gate — replace it with something that matches
    real capability (or drop the gate and let the provider reject if it truly can't).
  Verify live: attach an image + ask "what do you see?" on DeepSeek v4 pro / Qwen plus, then screenshot
  the same image via browser tools; capture both outbound requests from the stream/network debug logs
  and diff where the attach path drops the image. Fix = attach path delivers the image the way the
  working screenshot path does, for every model that can actually see — not just tagged ones. NOT this
  session (decomposition first). [[atlarix-v14-8-11-fidelity-release]]

- **FEATURE: notification sound when Atlarix needs the user (permission / action / question).**
  When the user is looking away from the app, they have no way to know Atlarix is blocked waiting
  on them — a command/file-write approval, an `ask_user` question, or any human-in-the-loop gate.
  Add an audible notification (plus, ideally, an OS notification if the window is unfocused) that
  fires whenever a turn enters a waiting-on-user state. Should be a setting (on/off, maybe volume),
  respect OS "do not disturb", and not double-fire with the existing sonner/OS notifications from
  Automations. OPEN QUESTION for owner: provide a sound asset or have Claude generate/source one —
  owner is fine with either. NOT this session (decomposition first).

- **CONSIDER (evaluate, don't commit): `browser-use` repo/extension vs. our current browser tools.**
  Evaluate whether the open-source `browser-use` project (LLM-driven browser automation) would be a
  better foundation than Atlarix's current in-app browser interactions
  (`browser_navigate`/`browser_inspect`/`browser_interact` over the native WebContentsView +
  `browser_*` tools). Compare: reliability of element targeting, how the page is represented to the
  model (accessibility tree / DOM snapshot vs. our snapshot-first visual sight), token cost, whether
  it needs a separate runtime/process (Python) that doesn't fit an Electron desktop app, and
  approval/sandboxing integration. If it's a clear win, scope a migration; if not, leave our current
  approach as-is and close this note. Just parking the consideration for now.
  [[atlarix-preview-webcontentsview]]

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
