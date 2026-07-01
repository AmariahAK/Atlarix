# Atlarix TODO

**Current Version:** v14.8.0 (released 2026-06-30)
**Last Updated:** 2026-07-01

> Open work + the current release only. **Full shipped-version history lives in
> [`docs/CHANGELOG.md`](./CHANGELOG.md)** (and `docs/CHANGELOG_PREVIOUS.md`).

---

## ✅ Shipped in v14.8.0 (2026-06-30) — headless preview testing, rock-steady streaming, smarter stalls

A reliability + capability pass. `ts` (main+tests+app), `oxlint`, `knip` green; full
vitest green (1441; 1 pre-existing flaky worktree-timeout that passes in isolation);
verified in a packaged build.

- **Headless `preview_test` tool + console/network completion gate.** Reuses the
  offscreen preview `WebContentsView` (Playwright is stripped from the packaged app):
  scripted navigate→click/fill→waitFor→assert → structured pass/fail, plus
  `preview-verify.ts` gate that blocks "done" on error-level console / failed-load /
  4xx-5xx network (dev-mode warnings filtered to avoid false positives). Build/Debug only.
- **Idle-stall budget 300s → 600s** (`stream_chunk_tags.ts`) + **continue-from-partial**:
  a stall now RESUMES from completed steps (AI-SDK `onAbort` capture, unified with the
  truncation-continuation path) instead of restarting and re-running every tool call.
  Capture is passive (zero effect on normal turns); only fires on a real stall.
  ⚠️ **Remaining gate: live DeepSeek A/B** — a >600s stall can't be exercised in-harness
  (code is safe-by-construction but unvalidated live).
- **Streaming UI jump-back FIXED.** Root cause was dueling scroll controllers (CSS
  `overflow-anchor:auto` vs manual stick-to-bottom), NOT a count cap. Dynamic
  `overflow-anchor` + same-frame `ResizeObserver` re-pin + `markAuto/isAuto`
  (`useStickToBottom.ts`), content wrapper (`SimpleInlineChat.tsx`), scoped end-of-stream
  fallback (`AssistantMessageBody.tsx`). Borrowed from opencode `create-auto-scroll`.
- **Redundant rolling 7-exchange session-memory summary DELETED** (`session-memory.ts`
  removed; injection/write/rebuild/prune + `ContextAssembler` plumbing gone). Model
  context defers entirely to full history + token-overflow compaction.
- **Text-tool natural-termination cadence FIXED + eval un-skipped.** Detection ran on the
  ACCUMULATED `fullResponse`, re-executing a prior round's `<tool_call>` every iteration
  (weak/local models looped until exhaustion); now detects on each iteration's DELTA
  (`run-agent-turn.ts`).

---

## 🐞 Bug backlog — TBD v14.8.5 (found 2026-07-01)

Surfaced while diagnosing a live `qwen-code` build session (DeepSeek → Qwen → Kimi,
Build mode, writer sub-agents). Not fixed this session — cataloged for a future pass.
Ranked by severity.

1. **Writer sub-agent worktree seeds from committed HEAD → blind to uncommitted work.**
   `subagent-worktree.ts` does `git worktree add --detach <path> HEAD`, so a writer never
   sees the user's *or the main agent's* uncommitted edits. **Confirmed it bit the live
   session:** the main agent wrote schedule-daemon files (uncommitted, via `edit_file`),
   then 3 writer sub-agents were cut from base `e324104c` — a tree **missing those files**,
   so they built blind. This is a **correctness** gap (highest priority). Fix: seed the
   worktree from the current working-tree state incl. **untracked-but-not-ignored** files
   (`git diff HEAD` alone misses new files). Complement: tighten the `task`/writer prompt so
   the model knows writers operate on a snapshot and diffs land back through the main
   agent's approval gate. Do NOT switch writers to the live worktree — that breaks safe
   parallelism (3 ran concurrently here) + the reviewable-diff gate.
2. **`superseded_stream` (and other stream-stop sentinels) leak past Sentry `beforeSend`.**
   Sentry's own `onunhandledrejection` integration captures the benign abort independently
   and doesn't always attach the DOMException as `hint.originalException`, so
   `isStreamStopAbort(original)` misses it → benign aborts email as errors.
   **Fixed locally this session (pending release):** `textHasStreamStopSentinel()` text
   fallback in `stream-stop-sentinels.ts` + a check in `sentry-before-send.ts` + regression
   test. (Committed with this backlog; ships next release.)
3. **Two token counters disagree ~4×; the "suggest summarize" nudge uses the inflated one.**
   `proposal_handlers.ts:283` computes `totalTokens = estimateMessagesTokens(raw history) +
   codebaseTokenCount` (~550k in the live session, incl. the ~168K codebase estimate) and
   fires the summarize nudge off it — while the **accurate** context meter (model-facing
   *dispatched* size, `chat_stream_handlers.ts:3485`) read **126k/262k = 48%**. Reconcile so
   the nudge keys off the accurate meter (else it over-eagerly suggests summarizing).
   Cosmetic, not a truncation.
4. **UX: resend/edit blindly supersedes an actively-progressing turn.** The per-chat
   single-flight guard (`chat_stream_handlers.ts` ~1366–1385) aborts the in-flight turn on
   any new send with `superseded_stream`. During a slow reasoning turn (Qwen/DeepSeek think
   silently 20–50s between visible events) this reads as "refuses to stream," and each
   resend kills healthy, progressing work (it had already run tools). Consider
   **queue-instead-of-supersede** when the current turn is actively progressing — the queued
   message mechanism already exists (`useStreamChat.ts:1534`). (Guard is correctly
   per-`chatId`, so parallel sessions are unaffected.)
5. **UX: no strong "still reasoning (Xs)" affordance** during long silent reasoning phases,
   so a healthy-but-slow turn looks frozen and users interrupt it (feeds #4).
6. **UNVERIFIED: per-step `maxOutputTokens` 8192 floor may truncate long outputs.**
   `getMaxTokensWithFloor` (`token_utils.ts:184`) falls back to 8192 when the catalog has no
   output limit; on OpenRouter reasoning models `max_tokens` can include reasoning tokens.
   Confirm the resolved value for `qwen3.7-plus` / `kimi-k2.6` and whether it truncates a
   single long reply mid-stream. Only remaining harness-side candidate for a *literal* cut.

**Ruled out this session (do NOT re-chase):** DeepSeek "refuses to stream" = manual resends
starving a slow reasoning turn + single-flight working as designed (see #4), no provider
errors. Qwen "repeating itself" = the model spinning on `git status`/re-commits; the
loop-guard correctly force-finished it. Qwen "cutting off from context overflow" = **false
alarm** from the #3 counter; real context was 48%, never overflowed (even the Kimi 262k
window was fine).

---

## 🔭 Open / deferred

- **Delete the dead task-ledger module** (`src/lib/tasks/task-ledger.ts`). Inert for turn
  completion (`shouldCreateTaskLedger = false`), but **NOT fully dead**: a live path in
  `permissions/interceptor.ts` (`refreshPlanLedgerFromWrittenFile`) still drives the
  **PlanCard UI + `ATLARIX_PLAN.md` sync** on plan-file writes. So deletion is really a
  *decision* — remove only the truly-dead creation path (keep PlanCard), or remove the
  PlanCard/plan-sync feature too. Gotchas: `sanitizeLedgerDirSegment` is load-bearing for
  snapshots (move, don't delete); `streamTurnId` already named (no rename); no tests
  reference the ledger. A prior sub-agent fork caused collateral damage here — do it as
  its own careful pass with ts/oxlint/knip green after each step.
- **Headless `ask_user` equivalent.** The Electron interactive-card routing is live; in
  headless/autonomous runs `ask_user` is dropped (no responder), so an autonomous agent
  can't ask a clarifying question. A headless answer channel is still deferred.
