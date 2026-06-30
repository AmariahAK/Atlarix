# Atlarix TODO

**Current Version:** v14.8.0 (released 2026-06-30)
**Last Updated:** 2026-06-30

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
