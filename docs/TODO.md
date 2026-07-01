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

## ✅ v14.8.5 — Harness hardening (DONE — implemented on 3 cluster branches, unmerged, no tag)

**Theme: v14.8.5 is NOT a feature release — it's harness hardening.** Fixing the classes
of issue below (not adding surface) is what makes a world of difference to the LLM's real
behavior: fewer wasted turns, fewer token bleeds, faster TTFT, more resilient runs. Every
item is model-agnostic. Surfaced while diagnosing a live `qwen-code` build session
(DeepSeek → Qwen → Kimi, Build mode, writer sub-agents) + a codebase/log sweep.

**Implemented (2026-07-01)** — three sequential clusters, each `ts`/`oxlint`/`knip`/vitest
green, pushed unmerged for review (no tag until all smoke-verified):
- **Cluster 1 — writers/sub-agents** (`v14.8.5-cluster1-writers`): #1 worktree seed from live
  working tree (incl. untracked); worktree teardown on cancel/timeout; writer prompt
  (`subagent-writer.md`) + Build/Debug delegation guidance; built-in agents
  explorer/architect/implementer (overlaid by workspace `.atlarix/agents/*.md`); write derived
  from effective toolset; sub-agent detail renders inline.
- **Cluster 2 — latency/grounding/mode** (`v14.8.5-cluster2-latency-grounding-mode`): #8 removed
  the dead per-turn 500-file snapshot + instrumented preflight; #10 read_file "did you mean?"
  path grounding; #15 mode-transition re-anchor; Plan-mode single-architect delegation (prompt).
  #9 (OpenRouter fallback routing) REMOVED. **#10 B3 (run_command path enrichment) DEFERRED** —
  its result path is the safety-sensitive command-execution interceptor.
- **Cluster 3 — recovery/reasoning** (`v14.8.5-cluster3-recovery-reasoning`): reasoning is a flat
  `medium` base + one binary **Deep thinking** toggle (capability-gated, in `ChatConfigDropdown`),
  unified across all providers; #6 reasoning-aware maxOutputTokens floor; #7 adaptive stall
  threshold (resume-backed, floor 180s / ceiling 600s); #12 empty-output targeted nudge; #3
  summarize-nudge counter fix; #5 "still reasoning (Xs)". Already-satisfied: #7 cheap-recovery
  (continue-from-partial, v14.8.0), #4 queue-instead-of-supersede (renderer), #11 proactive
  compaction (0.75 gate); #11 downshift re-fit MOOT (no downshift mechanism).

_Backlog detail (as diagnosed) retained below for reference._

### A. Bugs / correctness found this session (ranked by severity)

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
7. **Universal reasoning-budget + adaptive stall + cheap recovery (model-AGNOSTIC — NOT
   per-provider).** DeepSeek stalls (long silent reasoning) and bleeds tokens; Kimi does the
   same but weaker; Qwen barely. A DeepSeek-specific cap is the wrong shape (drifts,
   mis-tunes the others). **Data:** the final run (qwen3.6/3.7-plus, 3.7-max, kimi) had
   **zero stalls** and burned **~115k–176k tokens/turn regardless of model** — proving
   per-turn cost is dominated by **re-sending the accumulating context**, not by reasoning.
   So tune the mechanism, not the model. Four model-blind levers, each **triggered by
   observed behavior/capability so the benefit auto-scales with how much a model actually
   stalls**:
   - **Cheap recovery (highest leverage):** never re-send/re-run on stall or supersede —
     robust+validated continue-from-partial, resume-the-same-stream, and #4's
     queue-instead-of-supersede. This is where the token bleed actually stops, for every
     model (turn cost is context-re-send, confirmed).
   - **Bounded reasoning via a single global effort policy → each provider's NATIVE param**
     (OpenRouter unified `reasoning:{effort|max_tokens}`, Anthropic thinking budget, …).
     Replaces today's `AGENTIC_PROSE_ONLY_MAX_REASONING = Infinity` (`chat_stream_handlers.ts`
     ~6137). Express the budget as a *fraction of the output budget*, not a per-model number.
   - **Adaptive stall threshold from observed cadence** — measure this session's p95
     inter-chunk/pulse gap and set the threshold as a multiple of it, instead of the flat
     600s (`stream_chunk_tags.ts`). Self-calibrating; snappy models get tight thresholds,
     heavy reasoners loose — no model names.
   - **Capability-derived, never identity-derived:** drive all of the above off the
     models.dev catalog fields (reasoning-supported? output limit? context window?), never
     `if (model === '…')`. (Aligns with the provider-agnostic principle.)

### B. General harness improvements (grounded in this session's logs + codebase sweep)

8. **Cut per-turn latency (every turn pays it).** Preflight totals **3.5–6.2s/turn** but the
   *accounted* portion is tiny (system-prompt ~3–16ms cached, prompt-bundle ~200ms) → **~3–5s
   of UNACCOUNTED TTFT overhead per turn**, plus a **full 500-file workspace snapshot created
   every turn** (53 this session). Instrument + close the unaccounted preflight gap
   (biggest recurring invisible cost); make snapshots **incremental** (changed-files vs a
   base) if they're currently full copies. Faster TTFT is the most-felt quality signal in an
   agentic harness and compounds over long multi-tool turns.
9. **~~Model-fallback routing on rate-limit / upstream errors.~~ REMOVED (2026-07-01).**
   Original: `[Alibaba] qwen/qwen3.7-max temporarily rate-limited upstream` fired 3× and the
   turn errored instead of recovering. **Dropped:** the proposed fix leaned on OpenRouter's
   native provider routing, and Atlarix should not bet reliability on a specific gateway
   (future versions may not stay on OpenRouter). The only provider-agnostic remnant worth
   keeping — a generic transient-429 backoff-retry so a turn doesn't hard-error — folds into
   #7's "cheap recovery" lever, NOT its own item. Do not re-add gateway-specific routing.
10. **Live file/symbol grounding to kill self-inflicted model errors.** The model ran
    `vitest naturalLanguageCron.test.ts` **after it had just renamed** that file to
    `natural-language-cron.test.ts` → test failed → wasted turn (plus several git
    commit/push failures it had to recover from). Add a cheap **"path exists? did-you-mean-X?"
    guard on tool inputs**, backed by the file index Atlarix already maintains (`@`-mentions /
    Blueprint). Weaker open-weight models make exactly these mistakes → cutting them improves
    bench economics directly.
11. **One source of truth for context accounting + PROACTIVE compaction.** (Extends #3.)
    Unify the summarize-nudge counter with the accurate model-facing meter, AND compact
    **proactively at ~70–80% of the ACTIVE model's window** (not only reactively near
    overflow) + **mandatorily re-fit on a downshift to a smaller-window model**. Keeps long
    sessions coherent and prevents overflow-on-model-switch.
12. **Smarter empty-output recovery.** `AI_NoOutputGeneratedError: No output generated`
    appeared **4×** (swallowed as benign) — reasoning models sometimes emit *only* reasoning
    and no text/tool. Replace the blind retry with a **targeted nudge** ("emit a tool call or
    a final message") instead of re-running the whole round.
13. **Sub-agent diff review, inline.** Surface each writer sub-agent's captured diff as a
    **reviewable card** before the main agent lands it (pairs with #1's worktree seeding).
    Makes the parallel-writer feature trustworthy + debuggable.
14. **Eval coverage for the concurrency / recovery failure modes.** Add eval-harness
    scenarios for the supersede cascade (#4), stall-resume (still "unvalidated live" — see
    the v14.8.0 ⚠️), and compaction-on-model-switch (#11) — the modes that only surface under
    real concurrency, so regressions get caught before shipping.
15. **Mode-transition adherence — weaker models follow the PREVIOUS mode after a switch.**
    Observed (esp. on smaller/weaker models; qwen3.6/kimi2.6 mostly cope): after switching
    modes, prior-mode history dominates. E.g. Plan mode after Build → "you can start carving
    things out" is read as *implement*; Explore mode → model attempts a write and the gate
    *refuses* it (a wasted turn, not a safety breach — the gate holds). **Root cause (grounded
    in code):** the active-mode block (`renderModePromptBundle`, `system_prompt.ts:170,318`)
    lives ONLY in the cached system prompt at the TOP of the message array; all prior-mode
    turns sit between it and the latest user message, so (a) there is **no recency re-anchor**
    of the current mode near the newest turn, and (b) there is **no mode-changed signal** to
    the model — even though the app already records a `mode_change` activity event
    (`chat-activity-normalize.ts:31`, `sourceAtoms.ts:161`). **Fix (model-agnostic prompt
    plumbing, not a redesign):** (i) inject a short active-mode CAN/CANNOT re-anchor right
    before the latest user turn so it is the LAST thing read; (ii) when current mode ≠ previous
    turn's mode, prepend a one-line "work mode changed to X since the last message; ignore
    prior-mode behavioral norms, follow Current mode: X." Auto-helps weakest models most (they
    over-weight recency); no downside for strong models. Not a blocker — a wasted-turn/UX fix,
    same family as the rest of v14.8.5.

### C. Sub-agents — mature to Claude-Code-grade (writers, planning, UI)

Direction confirmed against `atlarix-references/claude-code`: Claude Code **independently
converged on the same core Atlarix already has** — worktree isolation for concurrent
writers + markdown-defined, tool-scoped agents (`.atlarix/agents/<name>.md`, parsed by
`user-agents.ts` with `name`/`description`/`tools?`/`model?` + body). So this is
*maturation, not redesign*.

**Writers** (borrow Claude Code's `EnterWorktree`/`ExitWorktree` + shared-checkout rule):
- **Foreground/background split.** Main agent edits the shared checkout **directly**; only
  **parallel/background** writers get a worktree. (Claude Code now *blocks* shared-checkout
  edits for background agents → they must `EnterWorktree` first.) A single delegated writer
  can work serialized in the shared tree; reserve worktrees for genuine **N>1 parallel**
  writes. Today Atlarix gives *every* writer a worktree — over-isolated.
- **Seed the worktree from CURRENT working-tree state** (= item #1) — CC's `EnterWorktree`
  carries uncommitted work; Atlarix's bare-`HEAD` seed is the real correctness bug.
- **Robust worktree lifecycle.** CC had to fix **leaked worktree registrations** from killed
  agents — Atlarix will hit the identical bug at scale. Add orphan cleanup, clean merge-back,
  and agent-visible "you are in worktree X" state.
- **Declare write via the `tools:` allowlist, not a `write:true` flag.** An agent whose
  frontmatter lists `edit_file` *is* a writer (matches CC's model; `user-agents.ts` already
  parses `tools?`). Ship 2–3 built-ins (explorer=read-only, architect=planner,
  implementer=writer) like CC's plugin agents.
- **Reviewable diff on merge-back** (= #13) — surface the worktree diff as an approval card
  (CC's `ExitWorktree` merges; keep Atlarix writes reviewable through the gate).

**Planning sub-agents:** keep planning **single-threaded by default** — 1 planning agent (or
Plan *mode*) is correct and matches Claude Code (its main loop plans in its own context;
a single Plan/architect agent is delegated selectively; it does **not** fan out N planners
for one task — planning needs one coherent thread). So the current "Plan mode = 1 sub-agent"
is right. *Optional, advanced:* an opt-in **"design panel"** (N agents propose different
approaches → judge → synthesize) for genuinely hard problems only — not the default.

**UI (incomplete):** the sub-agent detail view **groups** thoughts & tool calls instead of
rendering them **inline** like the main chat now does. Reuse the main-chat inline thread
pipeline (`buildToolExpandView` / `StreamThreadItemView`) for the sub-agent view so a
sub-agent reads like a mini main-chat. Currently inconsistent.

### D. Minor cleanups spotted
- **`inferBlueprint: scan root does not exist`** (2×) — guard the Blueprint scan-root edge.
- **"atlarix CLI launcher is stale and not writable — offering reinstall"** (3×) — recurring
  env nag; one-time fix.
- **3× `git push --force-with-lease` auto-exec'd** in autonomous Build mode — add a
  confirm / dry-run preview for destructive git ops even when autonomy is on.

**Biggest-leverage now** (help every model on every turn, independent of the stall work;
#9 removed): **#8 per-turn latency**, **#10 path grounding**, **#15 mode-transition adherence**.

**Ruled out this session (do NOT re-chase):** DeepSeek "refuses to stream" = manual resends
starving a slow reasoning turn + single-flight working as designed (see #4), no provider
errors. Qwen "repeating itself" = the model spinning on `git status`/re-commits; the
loop-guard correctly force-finished it. Qwen "cutting off from context overflow" = **false
alarm** from the #3 counter; real context was 48%, never overflowed (even the Kimi 262k
window was fine).

---

## 🔭 v14.8.6 — Token-efficient "sight" + self-correcting visual build loop (planned)

**Theme:** give any model VISUAL sight of the running app **without burning tokens on
screenshots**, and close the build→see→fix loop. This is Atlarix's structural edge — a native
preview + browser tools the agent drives — that terminal agents (Claude Code / opencode)
**fundamentally cannot match**. (Direction set 2026-07-01; glass-box "trust panel" idea ruled
out — any LLM narrates naturally, low value.)

**Why not screenshots:** an image chunks into ~5k–50k vision tokens; the **accessibility tree
(AXTree)** is ~10× cheaper (~500 tokens) and is how every production browser agent (Browser Use,
MultiOn, the 2025 MCP wave) "sees" — via Chrome DevTools Protocol. **Atlarix already has the
foundation:** `browser_inspect(mode:"snapshot")` (AXTree refs), `browser_interact` (ref-based,
not pixel coords), `preview_test`, and the `preview-verify` done-gate.

**Core model — two buckets, one perceive-surface (decision 2026-07-01):** everything the agent
might "see" is either **(A) a page Atlarix RENDERS itself** (the user's localhost preview, or a URL
in the in-app browser — Chromium `WebContentsView`, so Atlarix owns the render tree) or **(B) flat
pixels** (a user-attached screenshot/mockup, raster/canvas/WebGL content). Rule: **if we render it
→ READ it (structured, cheap); if it's flat pixels → LOOK (vision, unavoidable).** For (A),
reading the structure is not only ~10× cheaper than a screenshot but *more accurate* — it yields
exact hex/position/font that vision can only guess. So vision stops being the default for live
pages and becomes the exception (user-attached image, or the raster/aesthetic remainder).

**Do NOT add a new `visual_audit` tool — MERGE into the existing browser tools** (fits the
simplify-the-surface principle; one "perceive + act" loop):
- **`browser_inspect` (target:"preview"|"browser")** returns, cheap→rich:
  1. **AXTree snapshot** (have it) — semantic structure + interactable refs.
  2. **Visual linter (new)** — DOM geometry + computed styles (injected JS
     `getBoundingClientRect`/`getComputedStyle`, or CDP `DOMSnapshot.captureSnapshot` /
     `Accessibility.getFullAXTree` via `webContents.debugger`) → rules → a TEXT defect report:
     blank render, sibling overlap, off-screen/clipped, invisible text (color≈bg / opacity0 /
     display:none-where-content-expected), collapsed zero-size layout, broken `<img>`
     (`naturalWidth===0`); + console/network errors (have it) + **CLS** (single number).
  3. **Design snapshot (for remakes)** — palette, type scale, spacing, layout hierarchy as TEXT
     (from computed styles) so "look at this URL and remake it" reads the source of truth, not pixels.
- **`browser_interact`** acts on refs and returns a **LIGHT DELTA** ("clicked #login → URL changed,
  2 new fields"), NOT a full page re-dump — re-surface the rich view only on material change / on
  request. (Full-dump-per-interaction is the ONLY real token-burn path — avoid it.)
- **Screenshots = escalation-only + user-attached.** Agent-requested only for the irreducible
  vision cases: raster imagery, canvas/WebGL/video (no DOM), or subjective "does it look polished".
  Downscale / crop to the changed region. Never auto-screenshot a live page to "see" it.
- **Off-the-shelf deps to evaluate:** `axe-core` (inject → contrast/overlap/structure), `web-vitals` (CLS).
- **Self-correcting loop:** build → open the built route (route discovery from the diff) →
  `browser_inspect` (text) → if defects, feed report back → fix → re-inspect. Extends
  `preview-verify` from "runs without errors" to "renders correctly." Vision only as bounded last resort.
- **Token discipline (the whole point):** return findings + summaries, never raw geometry for
  every node; deltas on interact; images as the exception. Net effect vs today's screenshot-to-see
  habit is LESS token burn, not more.

_Refs: accessibility-tree token economics + browser-agent architectures (AXTree via CDP;
Browser Use / MultiOn / MCP); DOM-downsampling (arXiv 2508.04412)._

### Queued polish fixes (green-lit 2026-07-01, not yet built)
- **`symbols.json` → userData** (currently `<workspace>/.atlarix/symbols.json` — pollutes foreign
  repos / git-LFS risk; the `.atlarix` gitignore only protects Atlarix's own repo). Relocate under
  `userData/` like the FTS5 index (`ctags-index.ts` `symbolsCachePath`/`saveDiskCache`, also the
  `.ctags-filelist`); drop pretty-print; best-effort clean up the old in-workspace file. Accuracy-preserving.
- **Open-file button is dead** — `OpenFileButton` (`ToolCardActions.tsx`, on read_file + edit_file
  cards) writes to unread atoms (`selectedFileAtom`/`isPreviewOpenAtom`). Wire it to the real
  Code-tab open path (`selectedErrorForCodeAtom` + `previewTab="code"` + right-panel visible +
  show-preview intent), mirroring `QuickFileOpen.openFile`; add optional line-jump for read_file.
- **Compaction-marker persistence** — investigate whether `[COMPACTION MARKER]` reliably persists
  (`workspace.ts:152/277`, handler 691/700). If it fails, an already-compacted session reloads
  FULL history and re-summarizes on EVERY re-entry (compaction itself is correctly threshold-based
  at ≥75% of the model's real window — not a re-entry trigger).
- **Provider-agnostic transient retry** — gateway-neutral backoff-retry on transient 429/5xx
  (honor `Retry-After`) so a turn doesn't hard-error on a rate limit (the reliability remnant of
  removed #9, done provider-agnostically — NOT OpenRouter-specific routing).

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
