# Atlarix TODO

**Current Version:** v14.8.11 (2026-07-04)
**Last Updated:** 2026-07-04

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
S18 tokenizer LRU memo (data-backed by gap attribution), local providers await real windows.
tsc/oxlint/knip clean; vitest 1652 green.

Follow-ups deferred: none — W11 escape A/B PASSED in owner smoke (DeepSeek, clean tab-indented
diff); S18 done via tokenizer memo (gap data from the smoke session).

---

## ✅ Shipped in v14.8.10 (2026-07-03) — harness refinement from live sessions

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md). Lean summary: reliable background/sub-agent
result delivery; ONE command-permission gate (dangerous = badge, revocable always-allow);
capability-derived reasoning (base high / deep max, budgets scaled per model); `wake_on` monitor +
background-job live view; continue-until-done gate fixed (Plan-mode exempt, mark-don't-redo,
hard nudge cap); repetition guard staged guide→guide→break + same-file-edits false-trigger fix;
FTS5 freshness on agent writes ("grep index is stale"); stream-scoped lifecycle events (frozen-UI
race); edit_file unicode-punctuation self-heal; plan tool weak-model-proofed (full-rewrite
canonical, checklist-in-error); new-window button → workspace chooser; Atlarix co-author trailer
on model commits; dead Blueprint UI surface deleted; headless tarball now auto-rebuilds on `v*`
tags (manual runbook step retired). tsc/oxlint/knip clean; vitest 1576 green; packaged-app smoked.

Follow-ups deferred: preflight reorder (measure-first), `.gitignore`-render profiler (3.4),
Fix 1(b) durable native-history (moot — bg procs die on quit), Atlarix GitHub account for
contributor credit (owner action — code side done).

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

## ✅ v14.8.5 — Harness hardening (DONE — landed on `main` as 3 sequential clusters, no tag)

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

## ✅ Shipped in v14.8.6 — sub-agent correctness, token-efficient "sight", polish (landed on `main`, no tag)

Built on the already-landed v14.8.5 harness hardening. Full suite green (1485 passed,
1 skipped); `ts` / `oxlint` clean; `knip` net-neutral. Verified via unit/regression tests
(packaged smoke pending as usual).

**Phase 1 — sub-agent correctness + UI (the "follow-ups", which were really a correctness bug):**
- **Writer sub-agents now actually write.** Root cause: `edit_file` only returns a
  `__permission_required` preview; the main-chat approval interceptor lands the write, but the
  sub-agent path never did — so writers produced empty worktrees while claiming edits. Added
  `applyEditProposalToWorktree` (applies the proposal into the isolated worktree, path-confined);
  the captured diff is the review surface the main agent re-approves. End-to-end regression test.
- **Sub-agent inline diffs:** emit `toolArgs` + `resultText` on nested `tool_use` events (+ forward
  through IPC) so nested cards render the same inline diff as the main chat (`buildToolExpandView`).
- **Open-file button** rewired to the real `sourceAtoms` Code-tab path (+ line-jump for read_file);
  removed the dead `selectedFileAtom`.

**Phase 2 — token-efficient visual "sight" + self-correcting loop (the headline):**
- Hybrid visual linter (`src/lib/browser/visual-lint.ts`): **axe-core** (contrast/structure, bundled
  + inlined via Vite `?raw`) + hand-rolled DOM rules (blank render, broken `<img>`, invisible text,
  collapsed/overlapping layout). Merged, ranked, capped, returned as TEXT (~500 tokens vs 5k–50k for
  an image). Two new `browser_inspect` modes: **`visual`** (defect report + CLS) and **`design`**
  (palette/type/spacing/layout for remakes).
- **CLS** via `web-vitals` `onCLS` injected at preview `did-finish-load`.
- `browser_interact` returns a **light delta** (url/element/content changed + CLS) — no full re-dump.
- **Conservative done-gate** (`getPreviewVisualFeedback`) blocks "done" only on an unambiguous
  blank/white-screen — never subjective layout — wired after the runtime-error gate.
- Decisions: adopt axe-core + web-vitals (vs hand-roll); conservative tool-first gate. Injected-JS
  over CDP for the linter (CDP stays for console/runtime capture).

**Phase 3 — polish + safety cleanups:**
- `symbols.json` (+ `.ctags-filelist`) relocated to `userData/ctags-index/<key>/` (mirrors FTS5);
  no pretty-print; legacy in-workspace file cleaned up.
- Compaction-marker persistence: thread `req.workspaceSessionId` into the auto-compaction call (the
  other two sites already did) so a reload keeps the compacted history; failure-mode test.
- Provider-agnostic transient retry: honor `Retry-After` (capped 60s) over fixed backoff; narrow
  `isNetworkStreamError` so a deterministic 4xx `APICallError` isn't blindly retried.
- Force-push / `reset --hard` added to `DANGEROUS_PATTERNS` so autonomous Build must confirm them.
- `inferBlueprint` scan-root existence guarded for the `fp === "."` path; stale CLI-launcher nag
  throttled to once per unique stale launcher.

_Deferred (unchanged): live re-validation of #6 (`maxOutputTokens` floor) and the >600s stall A/B;
the broader concurrency eval harness (supersede cascade, stall-resume)._

---

## ✅ v14.8.9 — Prompting refinement pass (DONE — landed on `main`, no tag)

**Landed 2026-07-02.** A refine-*around*-the-base pass after a full read-only audit of the whole
prompt surface (3 sweeps + the owner-observed screenshot exchange). The base is sound; the problem
was **layering** — so this is overwhelmingly subtraction + relocation. Anchor failure: a model
asked "what do you see" *correctly* used `browser_inspect visual`+`text`, then added a **redundant
screenshot** — lured by every prompt-level browser steer omitting `visual` and by the "VISUAL
confirmation" wording. Built on the v14.8.8 fallback (`99f65cc`). `ts`/`oxlint`/`knip` clean; full
suite green.

- **C1 — de-duplicate.** Mode guidance was triplicated (bundled mode `.md` prepended first + compact
  bundle + AGENTS.md). Made the compact bundle authoritative; trimmed the bundled `build-mode.md`/
  `ask-mode.md` (removed the verbatim verify/browser/long-running sections; **preserved the
  workspace-override mechanism**). Verify recipe now 1 home (+ AGENTS.md pointer). Rewrote
  `BROWSER_NOTE` to finally mention `visual`/`text` as the way to SEE a page (all mode-level browser
  steers had omitted it — the root of the screenshot bug).
- **C2 — decision-point steers.** `browser_inspect` reframed: `visual`(+`text`) IS the answer to
  "what do you see" (don't add a screenshot); `screenshot` = LAST RESORT literal image; steer on the
  `mode` enum. Dropped the "VISUAL confirmation" lure. Also `edit_file` operation enum (replace-first),
  `web_search` (one `deep` switch), `task` subagent_type write-escalation, `read_url` reciprocal steer.
- **C3 — contradictions/terminology/stale.** Scoped AGENTS.md memory-write to write-modes (was
  contradicting the Explore/Review edit_file block); fixed the `<mode_system>` tag reference; unified
  "ledger"→"session plan" + named the `plan` tool; deleted dead `stripHeadlessUnboundBullets`.
- **C4 — density.** Build `<work_mode>` wall → 4 weighted bullets; `tool_contract` re-ordered
  (native-FC/anti-XML rule leads); `BROWSER_NOTE` scoped out of Plan; trimmed the per-turn ledger tail.
- **C5 — sub-agent fixes.** `implementer` now keeps `web_search`/`read_url` (parity with a generic
  `write:true` writer); sub-agent prompts now document the `<system-reminder>` convention; `task`
  gained a when-to-delegate cue. (The subagent-`.md`-vs-builtin-constant merge was descoped —
  re-routing would lose the override surface; not worth the churn.)

_Follow-up (unchanged from v14.8.8): validate the edit_file escape handling live; only reopen on an
observed failure._

---

## ✅ v14.8.8 — Out-of-band harness messages + per-tool guidance relocation (DONE — landed on `main`, no tag)

**Landed 2026-07-02.** A two-cluster refinement pass after cross-checking three v14.8.7 follow-up
concerns against how opencode, Claude Code, Codex, AND qwen-code (the harness where the escape bug
was observed) *actually* work. Two survived; one was ruled out. `ts`/`oxlint`/`knip` clean; targeted
+ full suite green. Built on the v14.8.7 fallback commit `e1c1b9e`.

- **Cluster 1 — out-of-band `<system-reminder>` framing.** Harness-injected messages (the
  `prepareStep` block, stall/truncation/sub-agent continuations, force-finish, gate feedback,
  text-tool results, `otherAppsCodebaseInfo`) previously rode as `role:"user"`, so recency-biased
  open-weight models could read a harness nudge/resume as a fresh user request. New
  `systemReminder()` helper (`src/lib/streaming/system-reminder.ts`) wraps all 8 sites in a visible
  `<system-reminder>` tag (kept `role:"user"` — Anthropic rejects mid-conversation `role:"system"`);
  convention documented once in the `<tool_contract>`. This is Claude Code's mechanism and
  generalizes v14.8.7's A3. Genuine user turns stay untagged.
- **Cluster 2 — per-tool guidance relocation.** The `AGENTS.md` "Tool surface" + "Code retrieval"
  sections were fully redundant with the tool descriptions; deleted them (opencode ships no tool
  enumeration in its system prompt — it self-describes per tool). Relocated the only unique bits
  (run_command auto-background/end-turn/preview-auto-load) onto the `run_command` description. Result:
  per-tool guidance is capability-gated for free (a mode without a tool never sees its guidance).
  Kept cross-cutting workflow (Working principles, the glob→grep→read recipe, Secret handling,
  Context layers, Memory, identity) in `AGENTS.md`.
- **Ruled OUT — edit_file rewrite / apply_patch.** NO reference harness — including qwen-code (the
  source of the bug) — auto-repairs over-escaped *write* content; all use tolerant matching + an
  error nudge, which Atlarix already exceeds (v14.8.7). apply_patch is transport-not-format
  (`patchText` is still a JSON string under native FC) and opencode gates it *away* from `oss`/
  open-weight models. **Follow-up: validate v14.8.7's escape handling live** (drive a real Qwen
  through an over-escaping edit); only reopen edit_file on an observed live failure. Optional future:
  a `sed`-fallback parser (qwen-code parity); apply_patch as an opt-in tool for GPT-5/Codex BYOK.

---

## ✅ v14.8.7 — Task-state tracking for open-weight models + edit fidelity + cancel responsiveness (DONE — landed on `main`, no tag)

**Landed 2026-07-02.** All six workstreams (A–F) implemented as sequential clusters; full suite green
(1514 passed, 1 skipped), `ts`/`oxlint`/`knip` clean. Packaged `.app` smoke pending as usual. Two
front-loaded spikes resolved the ledger authority (plan-artifact is the live, UI-wired ledger — the
dead `task-ledger` stays only for `sanitizeLedgerDirSegment`) and the escape-bug fix layer (write path
applies zero transforms + faithful SDK JSON round-trip ⟹ model over-escape ⟹ fix in `edit.ts`).

- **C1 — B+D (`edit_file`):** collapsed to `write`+`replace` (removed `insert`/`delete`/`section`);
  over-escape repair with a safe 3-way policy (ok / auto-repair-if-confident / hard-block-ambiguous,
  `edit-escape.ts`); self-healing match cascade ported from opencode (`edit-match.ts`, uniqueness +
  disproportion rails). Docs swept (`AGENTS.md`, `README.md`).
- **C2 — A (task-state, the 5):** compact live ledger block re-injected every turn from the plan
  artifact (`formatPlanChecklistForPrompt`); `update_step`/`set_status`/`append_step` `planId` now
  optional (A1a); `buildContinuationPrompt` re-asserts the task on resume (A2/A3); mode→goal
  re-anchor (A4); minimal semantic text loop-guard (A5, `recordText`). Deferred concurrency evals
  built: supersede-cascade + stall-resume (new `{kind:"stall"}` scenario primitive +
  `ATLARIX_TEST_STALL_MS` override — the stall path was live-only since v14.8.0).
- **C3 — cancel/abort:** every sub-agent (foreground scouts too) now gets an abort controller;
  abort signal threaded into the heavy worktree git ops so cancel kills them (the CPU-spike source),
  cleanup left unsignaled.
- **C4 — F:** `ToolRegistry.execute` now normalizes bare `{error}` returns (edit_file/plan legacy
  convention) to real failures with the recovery-suggestion overlay; read_file's "did-you-mean"
  generalized to `edit_file` path-not-found.
- **C5 — E (conservative diet):** deleted mechanically-enforced prose (`Approvals` line, "What Atlarix
  CANNOT do") + deduped Memory section. Scoped down from wholesale relocation after discovering the
  web/viz rules are already capability-gated and AGENTS.md injects wholesale — wholesale relocation
  would trade surface-for-surface with weak-model regression risk (against the harness filter).

_Backlog detail (as planned) retained below for reference._

**Theme:** open-weight models lose the thread — after a resume/network event they re-anchor on the
LAST user message as "the task," and they re-DERIVE done-vs-pending every turn (re-reading git,
re-summarizing) instead of TRACKING it. Externalize task state (Claude-Code `TodoWrite` model) and
make resume re-assert the task. Plus two harness-fidelity bugs surfaced in live runs (a live
`qwen-code` build session, 2026-07-02): `edit_file` escape mangling and a cancel-time hang. Then a
set of **surface simplifications aligned with how Claude Code / opencode actually work** (D–F) — net
LESS surface, not more. All model-agnostic + capability-scaling (help weak models most, cost strong
ones ~nothing). _Ruled OUT of this set (2026-07-02 discussion): bespoke tool-result eviction (CC/oc
just cap single outputs + compact — Atlarix already does both); capability-derived scaffolding
tuning (not a CC/oc pattern); and harness-owned compaction / deleting `compress_context` (the model
chooses compaction well today — leave it to the model)._

### A. Task-state tracking (the 5, do all — from the 2026-07-02 discussion)
1. **Live model-maintained TODO ledger, re-surfaced at high salience** near the newest turn (the
   biggest win). Substrate already exists — `plan` tool, `ATLARIX_PLAN.md`, `PlanCard`,
   `task-ledger.ts` — but it's under-used as a LIVE progress tracker. Needs: (a) cheap per-item
   status updates (one call marks done) so it's maintained mid-task; (b) re-inject as a compact
   block right before the latest turn EVERY turn (same slot as the #15 mode re-anchor) so
   "what's left" is the freshest, most-authoritative thing read; (c) prompt discipline: consult +
   update the ledger before deciding the next action (replaces re-reading git/re-summarizing).
2. **Resume/continuation re-asserts the TASK, not the last user turn** (`continuation-handler.ts`
   `buildContinuationPrompt` + the network-retry re-entry): "continuing task X; done […]; remaining
   […]; do NOT restart or treat the prior user message as a new request." Direct fix for "it takes
   my last prompt as what it's doing" after network events. Pairs with #1 (the ledger IS the state
   to re-assert).
3. **Tag turns new-instruction vs system-continuation** so a recency-biased model doesn't read a
   harness-injected resume as a fresh user request (a resume ≠ a new user turn).
4. **Generalize the #15 recency re-anchor from mode → active GOAL** (same pre-latest-turn slot).
5. **Semantic (not byte-identical) loop-guard on repeated status re-statements** — the qwen
   transcript re-emitted the same "4 done, 1 remains" table repeatedly. Band-aid; #1 largely removes
   the need. (Today's guard is the 3×-byte-identical doom-loop.)
   _Note: reviving `task-ledger.ts` as the live ledger is its OWN careful pass (this supersedes the
   old "delete the dead task-ledger module" deferred item — we KEEP + repurpose, not delete). A prior
   sub-agent fork caused collateral damage there; `sanitizeLedgerDirSegment` is load-bearing for
   snapshots (move, don't delete); the live path `refreshPlanLedgerFromWrittenFile`
   (`permissions/interceptor.ts`) already drives the PlanCard UI + `ATLARIX_PLAN.md` sync on plan-file
   writes — build on that, don't break it. Keep ts/oxlint/knip green after each step._

### B. `edit_file` escape fidelity (open-weight correctness bug, live-observed)
- **Symptom:** content written with literal backslash-n (`\n`) instead of real newlines in template
  strings; `/ // ///` comment/slash sequences mangled. **3 different Qwens + DeepSeek could not
  self-recover** (had to copy-paste or fall back to `sed`/python); the model itself blames
  `edit_file` escaping. High-impact for the open-weight bench economics (weak models make exactly
  these mistakes and can't dig out).
- **Investigate, in order:** (a) native tool-call ARGUMENT decoding double-escapes / mis-unescapes
  backslashes for certain OpenRouter/open-weight providers — a **model-agnostic infra layer, highest
  value**; (b) `edit.ts` content transforms (fuzzy-match CRLF-normalize / `trimStart` paths)
  corrupting escapes; (c) the model over-escaping in native FC and the tool writing verbatim.
- **Directions:** a lenient tool-arg escape-repair at the decode layer; post-write anomaly detection
  (literal `\n` where newlines expected) that **REPAIRS or hard-blocks**, not just nudges (nudging is
  useless — the model can't fix it, as the transcript proves); consider preferring surgical/diff
  edits to shrink blast radius. Reference Claude Code / opencode arg-parsing + `apply_patch` robustness.

### C. Cancel / abort responsiveness (live-observed)
- **Symptom:** mid-task, when the UI looks stuck and the user cancels, the app hangs briefly + spikes
  CPU (laptop "loads a lot") before it closes. Possibly amplified by running Atlarix + another agent
  on a spec-limited laptop (CPU contention), but the hang is real.
- **Investigate:** abort teardown cost — is cancel synchronous/heavy on the main thread (worktree
  removal, git ops, snapshot flush, sub-agent teardown, stream reset)? Cancel should be **immediate**
  (stop the stream + free the UI now) with teardown moved async/best-effort. Confirm the abort
  propagates promptly to the in-flight provider fetch AND any running sub-agents.

### D. `edit_file` surface simplification — match Claude Code, borrow opencode's robustness
Claude Code's edit surface is tiny — `str_replace` (old→new, unique match) + `write` (full file);
**no line-number `insert`/`delete`, no `section`** (models can't count lines reliably, so line-number
ops are the most error-prone thing you can hand them). opencode instead invested in making the
replace ROBUST — a cascade of match strategies (exact → line-trimmed → block-anchor →
whitespace-normalized → indentation-flexible). Atlarix's `fuzzyFindString` (3 strategies) is a lighter
version of the same idea.
- **Collapse `edit_file` to `write` + `replace`** (drop `insert`/`delete`/`section`) → fewer failure
  modes for weak models, less prompt spent explaining ops. Pairs with **B** (smaller surface = smaller
  escape-bug blast radius).
- **Deepen `replace` matching toward opencode's cascade** so a near-miss self-heals instead of erroring.

### E. System-prompt diet — guidance rides on tools, not the monolith
CC/opencode keep the system prompt LEAN and push per-tool behavioral guidance into the **tool
descriptions**. Since `mode-tool-registry` already resolves the toolset per mode, guidance attached to
tools is **capability-gated for free** (a mode without browser tools never sees browser guidance — no
conditional logic). Not new machinery — a move + a trim.
- **Audit the system prompt; relocate per-tool/per-mode behavioral guidance onto the tools themselves;
  delete anything the harness now enforces mechanically** (gates/permissions needn't also be prose).
  A long prompt hurts weak models most (signal lost in noise).

### F. Universal, consistent tool-error → recovery
CC is disciplined: every tool failure returns a specific, actionable next step ("read the file first";
"old_string not found — it may have changed, re-read and retry"). Atlarix has the best example already
(path "did-you-mean" grounding). Lowest-complexity item — pure quality, no new machinery.
- **Make EVERY tool's failure message actionable + consistent** so a weak model always has a concrete
  next step and never dead-ends (kills self-inflicted wasted turns, e.g. the run-a-just-renamed-file case).
