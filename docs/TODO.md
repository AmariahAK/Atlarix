# Atlarix TODO

**Current Version:** v13.7.0 (released)
**Last Updated:** 2026-06-18

---

## v13.7.0 — SHIPPED (2026-06-18): silent-grep Blueprint, `@` chips, hardened agent loop + headless CLI

> See `docs/CHANGELOG.md` [13.7.0]. ts (main/app/tests) + oxlint clean (0/0 across the whole tree),
> full suite green (1226 tests), headless bundle smoke-tested, packaged + boot-smoked.

| Item | Status |
|------|--------|
| **`get_blueprint` tool removed; Blueprint = silent grep substrate** — FTS5+Ctags index, ast-grep edges, token-free grep reranker, edit-time blast-radius all stay; only the agent-facing tool affordance moved into `grep`. | ✅ Done |
| **`@` mentions render as removable chips** — `MentionAttachmentChip`, `src/lib/chat/mention-attachment.ts`; scoped/capped extraction unchanged. | ✅ Done |
| **Editable plans before & during build** — "Quick add step", `plan({operation:"append_step"})` + `plans:append-step` IPC; build re-reads the plan mid-run. | ✅ Done |
| **`task_complete` completion tool** — first-class build/debug-only read-only tool replaces the `<task_complete>` XML sentinel as the done-signal. `src/lib/tools/task-complete.ts` + completion-detector. | ✅ Done |
| **Edit & command mutation verifiers** — `run_command` failure guidance (exit 127/126/timeout/missing-file) symmetric with post-write edit verification; failed mutations block a premature `task_complete`. `mutation-verify.ts`, `run-command-guidance.ts`. | ✅ Done |
| **Natural termination, no hard stoppers** — repetition hard loop-break demoted to advisory + bounded prose-only safety net (≤3 nudges); unintended per-tool iteration caps / loop-stoppers removed across the loop. | ✅ Done |
| **Headless agent CLI + benchmark harness** — `npm run build:headless` (Electron-free bundle, native FC, no browser tools); Terminal-Bench (Harbor) + SWE-bench adapters under `benchmarks/` + `tests/bench/`; distributed via the `headless-bench` pre-release on `atlarix-releases`. | ✅ Done |
| **Fewer Supabase pings, OAuth-token log scrub, MCP env encrypted at rest, stale-worktree reaping, macOS GPU sandbox kept.** | ✅ Done |
| **Cleanup** — flaky `snapshot_shadow_git` stabilized (file-scoped 30s timeout), 19 src + 7 non-src oxlint warnings/errors cleared, two safe deprecation swaps (`rmdirSync`→`rmSync`, `substr`→`slice`). Refactor-deep deprecations + breaking dep upgrades (eslint v9, ts-eslint v7) deferred. | ✅ Done |

## v13.6.0 — SHIPPED (2026-06-16): surface simplification

> See `docs/CHANGELOG.md` [13.6.0]. Implemented in one working-tree pass; ts (main/app/tests) + oxlint
> clean, full suite green (1222 tests), packaged + boot-smoked.

| Item | Status |
|------|--------|
| **Scoped `@` mentions** — `@file:` injects capped contents, `@dir:` injects a file listing only (agent greps within scope); `workspace:list-paths` IPC, `parseContextMentions`/`extractMentionedContext`, `@`-only composer autocomplete. Replaces the old `@app:` whole-codebase dump. | ✅ Done |
| **`/` slash-command system removed** — handlers/lib/IPC/settings UI deleted; `custom_commands` table dropped (migration 0065). | ✅ Done |
| **Tiers → Core 1–4** — Fast/Balanced/Thinking abstraction removed; every plan uses every Core model; legacy persisted selections coerced forward. | ✅ Done |
| **Deploy connectors removed** — Supabase/Neon/Vercel/GitHub-Actions panels + handlers + e2e fixtures deleted; terminal-first + MCP-only SaaS. **Prod Supabase auth/metering untouched.** | ✅ Done |
| **Security review merged into Review mode** — `security_handlers` deleted; one reviewer covers correctness + security. | ✅ Done |
| **Live BYOK context limits** — per-provider windows resolved from each API, nothing hardcoded. | ✅ Done |
| **Session-resume prompt, model-switch notice, stale-Core fix, MCP OAuth marketplace connect, README↔JSON.** | ✅ Done |
| **`ask_user` cross-session leak + `AbortError: ask_user_pending` Sentry noise** fixed. | ✅ Done |

## Retrieval — SHIPPED in v13.5.0 (2026-06-13): FTS5 scale, sharp grep, embeddings removed

> See `docs/CHANGELOG.md` [Unreleased]. Validated on a real giant multi-repo: "find the signup code"
> went ~63K → ~26K turn tokens with verified-accurate (zero-hallucination) results.

| Item | Status |
|------|--------|
| **Disk-backed FTS5 lexical index** (per-workspace SQLite, constant low memory, kills the OOM ceiling; candidate-set rerank; per-package lexical scoping). Public API unchanged behind facade. | ✅ Done |
| **Sharp symbol-aware `grep`** — `findEnclosingSymbol` (ctags) annotates each hit with its function/class; defaults cut (max_bytes 120K→24K, max_results 50→20, per-file 30→5, context→0); most-relevant file first; match card badge. | ✅ Done |
| **Browser snapshot-first steering** — `browser_screenshot`="visual confirmation only", `browser_snapshot` for find/interact; Explore+Build skills. | ✅ Done |
| ~~Local semantic-recall lane (Model2Vec / embeddings)~~ | ❌ **Removed** — code retrieval doesn't need a vector index (the LLM is the NL layer). Deleted the lane, the 62 MB model, `semanticRecall`, `emb_src`. |
| **Blueprint** | ✅ **Audited — leave as-is.** It is the **best version for models**; tight + accurate (40-room cap, 300-line/48 KB markdown, BM25+centrality+proximity, ~2–4K tokens). **Do not touch until further notice** — no accuracy/bloat problem to solve; query-intent routing + embedding fusion intentionally not pursued. |

## v13.0.0 — SHIPPED in v13.5.0 (2026-06-11): mass simplification

> The full v13 program shipped in one working-tree pass (8 phases, each left ts/tests/knip green + boot smoke).
> See `docs/CHANGELOG.md` [13.0.0] for the user-facing breakdown.

| Phase | Notes |
|------|-------|
| **1. Templates removed** | ~2,600 lines: hub picker + route, git-clone/cache pipeline, bundled `scaffold/`, `create-app` IPC chain, `selectedTemplateId` setting, TEMPLATE_TOKEN (.env.example + release.yml). **Manual: delete the `TEMPLATE_TOKEN` GitHub secret + local `.env` line.** Orphaned Neon connector UI deleted with it (deeper Neon plumbing untouched). |
| **2. Activity/Agents tabs + background agents deleted** | Panels, PanelTab entries, `agents:background:*` IPC, runner, hydrate, auto-approve branch. activity-stream lib KEPT (feeds inline UI). Migrations 0060/0061 stay; columns no longer written. |
| **3. One parallel `task` tool** | `run-subagent.ts` (streamText) replaces `runDelegation`: live `subagent_thought` reasoning/narration upserted into SubAgentRunCard (renderer already had the `thought` item kind). 5-slot delegation-limiter keeps parallelism; specialist roster/handoff schemas/presets/corrections/bus + the structured Plan/Debug/Review report rewriting DELETED. Mode prompts amped (debug = hypothesis-first as prose). `task` offered in EVERY mode. |
| **4. Tool surface 38 → 22** | New `glob`/`grep` (renderer match-list card reuses `ui.groups`); plan tools 5→1 (`operation:` param); memory.md + installed skills auto-injected; progressive reveal + ToolSessionLoader deleted (pipeline now 3 stages); read_file offset/limit paging; run_command output cap → 1MB; AGENTS_COMPACT/MODE_BASE + mode skills + blueprint guide rewritten for the new names; legacy names annotated in renderer maps; deleted-tool history replay eval added (graceful "unavailable tool" feedback verified). Goldens re-pinned: ask/plan = 17, build = 22. |
| **5. Tool cards show the work** | `defaultOpenFor` (shared live + hydrated): done writes/edits open their diff, commands open output + exit-code badge (`command` expand kind + ToolCommandExpand, last-10-lines clamp), errors open, reads stay collapsed; running mutating tools render a fixed skeleton. |
| **6. Status line replaces the long-task banner** | SlowStreamWarningBar + atom deleted; InlineStreamStatus prioritized states: waiting chip → "Reconnecting…" (10s quiet) → "· still working (1:23)" (60s+) → tool label. Terminal restore notice → dim separator. |
| **7. Background commands + waiting UI** | `run_command background:true` returns immediately (timeout still enforced); exit result delivered via prepareStep injection (mid-turn) or next-turn context drain (`background-commands.ts`, take-once) — no polling tool. Foreground command >10s → `chat:stream:phase waiting_on_command` → chip with timer (click opens Terminal tab; stop affordance), square→send flip, ONE queued message flushed on stream end. Eval: immediate return + next-turn delivery. |
| **8. Verification** | 169 test files / 1173 tests green, ts + ts:tests + app/e2e tsconfig clean, knip 0 unused files, boot smoke clean per phase. |

### v13.1 follow-up — SHIPPED in v13.5.0 (2026-06-11): plan tab, full LSP removal, web search, harness parity

> Six items, each left ts/check:ts/tests/knip green + boot smoke. See `docs/CHANGELOG.md` [13.0.0] Added/Removed (v13.1).

| Item | Notes |
|------|-------|
| **1. Plan = coexisting tab** | `'plan'` dropped as a PanelType; appended to code-preview tabs when `workspacePlanPanelAtom.planId` set; `mapIntentToView('show-plan') → 'code-preview'`; PanelContent renders PlanExecutionPanel for activeTab `plan`; first-activation only steers tab+visibility (no takeover, terminal stays usable). |
| **2. Always-queue while streaming** | SimpleChatInput textarea always enabled; submit queues one msg on any `isStreaming` (single slot, flushed on stream end by useStreamChat); stop square + send both shown. |
| **3. AGENTS.md/CLAUDE.md interop** | `readProjectInstructions()`: atlarix.md → AGENTS.md → CLAUDE.md, same inject cap, read-only; loadAtlarixMdSection labels per source (atlarix heading byte-identical for ttft eval). |
| **4. Web search upgrades** | turndown HTML→Markdown (fallback to stripHtml); read_url 20K/50K + `max_length`/`timeout` params; deep-fetch 20K; `fetchWithCfRetry` (403 cf-mitigated → browser UA, once); 20s timeouts; snippets 300→500. `turndown` dep added (bundled by Vite, no forge work). |
| **5. Revert-turn checkpoint** | `listSnapshotFiles` restored; `snapshot:files` IPC + `revert:snapshot {filesOnly}` (skipMessageFlags); `turnSnapshotTurnIdByMessageIdAtom` populated in useStreamChat onEnd; SimpleMessage RevertTurnAction + AlertDialog. **Session-lifetime only** (snapshotTurnId not persisted). |
| **6. ALL LSP deleted** | Engine: postWriteVerify seam removed, stop-hook gate preserved (counter renamed `gateBlockedBreaks`, `permission-ruleset.eval` green). Setting `enableAutoFixProblems` + AutoFixProblemsSwitch gone. Editor: `src/lib/lsp/*` + lsp_handlers + preload/ipc_client methods + FileEditor LSP lifecycle deleted (preview-marker reset moved into the preview effect's cleanup). Deps `typescript-language-server`/`vscode-langservers-extracted`/`vscode-jsonrpc`/`vscode-languageserver-types` uninstalled; forge keepRoots/strip blocks + knip ignores removed (~6–8 MB). Prompts/docs/README de-LSP'd; stale v13 tool refs (record_debug_hypothesis, diagnose_issue, update_plan_*) fixed. edit-verify eval → `edit-nomatch-guidance.eval.test.ts` (no-match test only). Errors tab + dev-server TS watcher KEPT (independent). |

**Release checklist (when ready to tag v13.0.0):** bump `package.json` version; manual test pass (parallel sub-agents with visible thinking, waiting chip + queued message, background command result delivery, old-session rendering incl. deleted-tool parts, template-free flow, MCP call, browser tool, plan-tab ↔ terminal switching, queue-while-streaming, revert-turn, AGENTS.md repo); launchpad copy AFTER release; delete `TEMPLATE_TOKEN` secret; `git tag v13.0.0` + push.

**Deferred (consciously, from the v13 plan):** drop `maybeTruncateToDisk` for plain offset-paging; extract chat_stream_handlers.ts (7.4K lines) branch bodies; drop ToolCategory enum + cost field (stats-only); remove the capability-trim stage entirely at 22 tools; full removal of legacy handoff renderers after a soak release; stale `stream_terminal_output` comparisons in the handler (dead, benign).

---

## v13.2 — SHIPPED in v13.5.0 (2026-06-12): all-provider prompt caching + blueprint accuracy + send/stop swap

| Item | Notes |
|------|-------|
| **1. FIX: direct Anthropic BYOK was broken** | `@ai-sdk/anthropic@^3.0.71` is a v3-spec provider; `ai@5.x` throws `AI_UnsupportedModelVersionError` on dispatch (broken since ≥v12.10.0; unnoticed because Compass/OpenRouter dominate). Downgraded to `@ai-sdk/anthropic@^2.0.81` (v2-spec, pairs with ai v5). Keep on the 2.x line until the `ai` package moves to v6. |
| **2. Cache markers for ALL providers** | `anthropic-cache-breakpoints.ts` generalized: `resolveCacheMarkerPlacement` gates on Claude-family models on ANY route (direct, OpenRouter/Compass, Bedrock, Vertex, custom proxies); marker carries all provider option keys at once (opencode pattern); message-level (anthropic/bedrock/vertex) vs content-level (rest) placement; breakpoints = header + last TWO history messages. Wired into main stream + `run-subagent.ts`. OpenAI gets `promptCacheKey` per chat. Tests: per-provider matrix in `anthropic-cache-breakpoints.test.ts`. |
| **3. Cache-aware BYOK cost meter** | `byok-pricing.ts`: cache read/write rates (static table + OpenRouter row `input_cache_read/write`); anthropic-style (input EXCLUDES cache) vs OpenAI-style (includes) token semantics; OpenRouter actual `providerMetadata.openrouter.usage.cost` wins outright. Accumulators `turnCachedInputTokens`/`turnCacheCreationTokens`/`turnActualCostUsd` in chat_stream_handlers. |
| **4. BM25 sub-token matching** | `tokenizeForBm25` emits full token + camelCase/snake_case sub-tokens (docs AND queries via definePrepTasks) — "auth callback" now matches `handleAuthCallback`. In-memory index → no schema bump needed. `bm25-tokenizer.test.ts`. |
| **5. Zero-hit grep fallback** | grep with 0 ripgrep hits → `suggestClosestIndexedSymbols` (Blueprint BM25, ≤5 one-line file:line suggestions, 1.5s timeout, degrades silently). Saves the wasted retry round. |
| **6. Send/stop button swap** | SimpleChatInput: ONE action slot — Stop replaces Send while streaming and vice versa; Enter still queues (placeholder carries the hint); queued chip unchanged. |
| **7. Harness comparison** | `docs/HARNESS-COMPARISON.md` — Atlarix vs Claude Code/Codex/opencode/Cursor/Antigravity per harness dimension with ▲◆▼ verdicts + invest-next list. |

**Deferred from the caching audit:** → all caching items shipped in v13.3 below. Still open: microcompact (drop stale tool results, no LLM call); sandbox network default-deny option; parallel tool execution within a step; persist `snapshotTurnId` (checkpoints across restarts).

---

## v13.3 — SHIPPED in v13.5.0 (2026-06-12): ai@6 migration + caching round 2

| Item | Notes |
|------|-------|
| **1. ai@6 + provider v3 majors** | `ai@^6.0.203`, `@ai-sdk/anthropic@^3.0.84` (**back on latest** — supersedes the v13.2 downgrade), openai 3.x / google 3.x / vertex 4.x / bedrock 4.x / openai-compatible 2.x / azure 3.x / xai 3.x / provider 3.x / provider-utils 4.x / mcp 1.x / `@openrouter/ai-sdk-provider@^2.9.1`. No v3-on-ai5 shim exists (vercel/ai#8249) — migrating `ai` IS the fix. Code: streamText getters are now `PromiseLike` (run-agent-turn `bundle.response`, no_usable_model_output); `ModelClient.model` widened to `LanguageModelV2 \| LanguageModelV3`; vertex/azure providerOptions key renames (google→vertex, openai→azure) in the reasoning patch. elastic/cohere adapters stay V2 via the SDK's compat wrapper (console warning; V3 rewrite = follow-up). |
| **2. ai@6 token semantics** | Flat `usage.inputTokens` is now the cache-INCLUSIVE total for EVERY provider (verified in `asLanguageModelUsage`: `inputTokens.total`; anthropic total = input + cacheCreation + cacheRead). `byok-pricing` dropped the per-family branch → uniform `fullRate = input − cacheRead − cacheWrite`; reads `inputTokenDetails.{cacheReadTokens,cacheWriteTokens}` first (deprecated `cachedInputTokens` fallback). Handler cache accounting + `reasoningTokensFromAiUsage` (`outputTokenDetails`) updated likewise. |
| **3. Per-step breakpoint advancement** | `advanceCacheBreakpointsForStep` (strips ONLY our cache keys — preserves co-resident providerOptions like reasoning_content — then re-marks the step's last two non-system messages; system header untouched). Wired into main `prepareStep` (after take-once injections) and a new sub-agent `prepareStep`. Matches opencode's per-request re-transform behavior (their loop re-applies `applyCaching` every request; AI SDK's inner loop needed this seam). 3 breakpoints/step, ≤4 Anthropic limit. |
| **4. Anthropic 1h TTL on header** | Direct Anthropic only: header breakpoint `{type:"ephemeral", ttl:"1h"}` (write 2x, survives >5min between-turn gaps; ≥3 turns/hour breaks even). History stays 5m; passthrough routes stay plain (ttl passthrough undocumented). |
| **5. OpenAI 24h retention** | `providerOptions.openai.promptCacheRetention:"24h"` next to `promptCacheKey`, gated `/^gpt-5\.[1-9]/` (SDK docs: GPT-5.1 family; free per OpenAI docs). |
| **6. OpenRouter sticky sessions** | `x-session-id: atlarix-chat-<chatId>` header on openrouter/compass dispatches — pins the upstream provider so cache reads land on the warm instance (openrouter.ai prompt-caching guide; `session_id`, NOT `user`). |
| **7. 55% reminder off the tail** | Reminder no longer mutates the dynamic tail mid-session (was a one-time prefix re-write); delivered via the prepareStep take-once injection seam (step-input-only, like corrections). Tail is now byte-stable for the whole session. |
| **8. Gemini explicit CachedContent — REJECTED** | Break-even fails for chat cadence: storage $4.50/MTok/hr (2.5/3.1 Pro) vs free implicit caching at the same 90% discount → needs ~4 same-prefix req/hour. Implicit hits now accounted via `inputTokenDetails.cacheReadTokens`. Do not revisit unless a fixed-corpus, high-frequency feature appears. |
| **9. Stream-stop sentinels → AbortError DOMExceptions** | ai@6/undici reject in-flight work with the abort reason VERBATIM; bare-string sentinels (`ask_user_pending` etc.) fail `isAbortError` and surfaced as uncaughtException after turn finalization. New `src/lib/stream/stream-stop-sentinels.ts` = single source for the 4 sentinels + `streamStopAbortReason()` (wraps in AbortError) + `abortReasonSentinel()` (comparisons) + `isStreamStopAbort()` (benign-swallow in main.ts nets AND tests/infra/setup-agent-evals — that setup's rethrow was converting the rejection into vitest's "Uncaught Exception"). |

**Follow-up:** rewrite `elastic_agent_builder_adapter.ts` + `cohere_chat_adapter.ts` to `LanguageModelV3` (currently compat-wrapped with a console warning).

### Multi-repo alignment sprint — SHIPPED in v13.5.0 (2026-06-13)

One-identity rewrite across Atlarix/launchpad/releases: **"the open-weight frontier harness"** (DeepSeek/Qwen/Kimi/MiniMax + any-model BYOK + local-first) is now the canonical one-liner everywhere (README, package.json description, FirstRunWizard, base-provider legacy prompt, website hero/meta/Terms, releases README). Accuracy fixes: verified-edits claim softened to behavior-language (README only — never existed on the site); per-workspace permission scoping added as a stated feature (verified `workspace_file_permissions` appId-keying); pricing unified to Core 1–4 / all-plans-all-models / quota-differs + MCP 1-free-per-workspace, 10-paid (matches `mcp_handlers.ts` enforcement); website privacy now discloses GTM+GA4 and disclaims PostHog (app PostHog disclosure kept, scoped); Windows presented as available+unsigned on all surfaces (Setup.exe confirmed in v13.1.5 release assets); releases README Core-1 fixed to kimi-k2.6 (last Gemma ref purged); Nairobi pilot funnel removed (Pilot page+route deleted, CTAs/stub blog removed, OfflineSection reframed to open-weight economics; identity/legal Nairobi kept); orphans deleted (PainSolutionTable, SecurityBadges, KnowledgeDrainCalculator, PilotTeaserCard), ProviderFreedom re-themed + wired in as the landing open-weight section; PostHog debug hardcode → EU. **`auto_routed_tier` finding:** the column was ALREADY dropped with the legacy `messages` table in 0058 — no migration needed (an attempted 0063 drop broke fresh-DB creation and was reverted). "Model Bridge" survives only in historical docs (TODO history, CHANGELOG_PREVIOUS) — intentionally not rewritten.

### Harness parity — invest-next (2026-06-13)

> Fulfills v13.2 item 7: `docs/HARNESS-COMPARISON.md` written — Atlarix vs Claude Code / opencode /
> Cursor / Antigravity / Codex at the harness level (▲ superior / ◆ parity / ▼ lacking). Verdict:
> leading on open-weight support, structural retrieval (Blueprint), all-provider caching, in-harness
> browser, eval harness, local-first; at parity on loop/sandbox/permissions/MCP/verification; lacking on
> parallel writing sub-agents, background/cloud agents, deep extensibility, public SDK. The single
> keystone for the "frontier open-weight harness" identity is an **open-model quality eval loop** —
> today the claim is architectural, not measured. Backlog below; full reasoning in the report.

> **Implementation pass 2026-06-13** shipped most of this backlog. Detailed seam-grounded
> follow-ups now live in **`docs/HARNESS-ROADMAP.md`**. Status below.

| Pri | Item | Status |
|:--:|---|---|
| **P0** | Open-model eval suite (real tasks through Atlarix on DeepSeek/Qwen/Kimi/MiniMax) | **Open** — the keystone; still the highest-leverage item (→ roadmap). |
| ~~P0~~ ✅ | ~~Writing sub-agents (worktree-isolated, review+apply)~~ | **Done** — `task({ write: true })` in an isolated git worktree; diff returned for review+apply. |
| ~~P1~~ ✅ | ~~Windows AppContainer sandbox (was unbundled/unsandboxed)~~ | **Done, pending Windows-CI validation** — Rust helper + CI build/sign + bundling. |
| ~~P1~~ ✅ | ~~Microcompact (no-LLM stale-output drop)~~ | **Done** in `runSteppedCompaction` (mid-loop native-pairing variant → roadmap). |
| ~~P1~~ ✅ | ~~Blueprint Tier-1 (RRF + proximity + field reweight)~~ | **Done** (query-intent routing → roadmap). |
| ~~P1~~ ✅ | ~~Keep-awake on idle-sleep + concurrent sessions~~ | **Done** — already built; verified + `keepAwakeDuringRuns` toggle added. |
| ~~P1~~ ✅ | ~~Auto-updating open-weight model catalog~~ | **Done** — dynamic live `/models` → models.dev. |
| ~~P1~~ ✅ | ~~Background *task* agents~~ | **Done (already was)** — `task({ background: true })` + mid-turn injection + keep-awake = async-while-away works; restart-persistence polish skipped as low-value. |
| ~~P2~~ ❌ | ~~Local semantic-recall lane (Model2Vec)~~ | **Removed 2026-06-13** — shipped then deleted. Code retrieval doesn't need embeddings (claude-code/opencode use none); the lane only engaged under a 40K cap and chased recall when the bottleneck was token volume. Kept disk-backed FTS5 + candidate rerank; made `grep` sharp + symbol-aware instead. See HARNESS-ROADMAP. |
| ~~P2~~ ✅ | ~~Persist context checkpoints across restarts (`snapshotTurnId`)~~ | **Done** — migration 0063 + persist/rehydrate; revert-turn survives restart. |
| ~~P2~~ ✅ | ~~Verifiable artifact layer~~ | **Done** — browser session-recording walkthrough (renderer card → roadmap). |
| ~~P3~~ ✅ | ~~Removals (capability-trim → cost/ToolCategory)~~ | **Done** — trim stage + `cost` + `ToolCategory` removed; weak/local models keep schema-simplification, lose only the tool-count cap. |
| **P3** | Public "build-on-Atlarix" agent SDK | **Deferred** (user) — strategic/large; revisit if a third-party ecosystem becomes a goal. |

**De-scoped by the user (not pursued):** approval-triage/Guardian, per-model system prompts, whole-harness swapping.

---

## Known issues

> Both fixed in the 2026-06-13 backlog pass.

- ✅ **Plan tools failing on a lost stream-transport session binding** — FIXED. `src/lib/tools/plan.ts` now auto-rebinds via `resolveOrBindWorkspaceSessionForStream` (falls back to the latest session for the chat's app) when `workspaceSessionId` is empty, and returns a clear "start a new chat in this workspace" message only when nothing can bind.
- ✅ **`@ast-grep/lang-{go,python}` not unpacked from the asar** — FIXED. Added `**/@ast-grep/lang-python/**`, `**/@ast-grep/lang-go/**`, and `**/.vite/build/astgrep_worker.js` to the `asar.unpack` glob in `forge.config.ts` (packaged-only; verify on a real build).

---

## Audited, intentionally left (de-hardcode sweep, v12.9.7)

> Hardcoded values reviewed during the v12.9.7 sweep and deliberately kept — they're intentional tuning, not bugs. Recorded so the trail exists.

- **Compaction tuning knobs** — `COMPACTION_THRESHOLD 0.75` / `PRUNE_THRESHOLD 0.60` / `MODEL_CONTEXT_SAFETY 0.8` (`compaction.ts`), the `0.85` soft cap (`tier_context_budget.ts`), fill ratios `0.5/0.7/0.85` (`context-budget-tracker.ts`), the 24-round compaction loop + 3-protected-exchanges (`tier_context_budget.ts`). Co-tuned with v11/v12 per-step token enforcement; changing them risks destabilizing compaction for no clear win.
- **Reasoning effort `"medium"`** (`reasoning-detector.ts`) — a feature request (expose high/low), not a bug.
- **Git log depth `100_000`** (`version_handlers.ts`) — display/cache only, no prod logic impact.

---

## v12.10.0 — SHIPPED (2026-06-09): streaming-UI crash fixes + runtime Core models + project-check verification

> **Streaming-UI defects** on top of the v12.10 working-tree work (chronological card ordering, no spurious "Summarizing" cards — both kept). (A) React #185 infinite render traced to `useWorkspacePlanPanel` (fresh `.map()` messages + unguarded `setPanel` write every render) — memoized + equality-guarded; sidebar narrowed to a derived `backgroundStreamingSessionIdsAtom`. (B) Accepted edit/write cards vanished because `ipcTimelineTailItems` only kept `running` tools — now keeps completed tools not in content parts; frozen-view tail filter broadened too. (C) Fatal main-process `Object has been destroyed` on quit — `broadcastToAllWindows` now guards at the webContents level via `safeSend` (+ Sentry ignore safety net). (D) `invalid pattern in look-behind` flood from `onigasm` — `OnigScanner.findNextMatch(Sync)` wrapped to degrade to no-match.
>
> **Then, this cycle:** (E) **Runtime Core-tier model config** — Core 1–4 resolve from a hosted `core-models.json` (atlarix-releases), fetched+cached at startup with build-time env fallback, so Core models change without a repackage (`core-model-override-store.ts` + `core-model-overrides.ts`, `core-models:refresh` IPC). (F) **Build/Debug verify with the project's own tooling** — both modes run the project's real checks/tests via `run_command` and write tests for non-trivial logic, not LSP-only (`mode-prompt-bundle.ts` + mode skills). (G) **Lighter prompt loader** — removed the runtime-unused full `AGENTS.md`. (H) Fixed the `.atlarix/plans/_index.md` scaffold (atlarix.md = instructions, memory.md = knowledge). All tests green (171 files / 1198 tests); released as v12.10.0.

---

## v12.9.7 — SHIPPED (2026-06-09): ask_user options render correctly + de-hardcoded context-window logic

> Two user-reported issues from OpenRouter testing (deepseek/minimax/qwen), plus an approved "go broad" de-hardcoding sweep. Minimax emitted options as `{label, description}` objects → `String()` → `[object Object]`, then Set-dedup collapsed them to one. Separately, the proposal token-usage % was capped at a hardcoded 100K instead of the real model window.

| Area | Notes |
|------|-------|
| **ask_user options** | `ask_user_options.ts`: new `coerceOptionLabel` extracts `label/value/title/name/text/option` from object options before stringifying (was `String(x)` → `[object Object]`, deduped to one). Hardened normalizer: question resolves from `question/prompt/text/header/title/label` aliases, options also accept `answers`, and empty-question-but-options synthesizes a generic title (never leaks options into the headline). Single source of truth — handler already routes through it. |
| **Proposal context window** | `proposal_handlers.ts`: dropped `Math.min(getContextWindow(), 100_000)` cap (only caller that clamped) → real per-model window + pass `chatId` for Compass. Informational/suggestion-only, never gated dispatch. |
| **Context heuristics** | `resolve-model-context-limit.ts` catalog-miss heuristics modernized: deepseek 16K→128K, qwen 32K→128K, llama/mistral 8K→128K, added minimax→1M, unlisted floor 16K→128K. Bias-high is safe (overflow loop self-corrects). |
| **Tier fallbacks** | `tier-context-limits.ts`: unified `FALLBACK_LIMIT` 100K→200K (both miss paths agree). `agent.ts` delegation fallback 32K→128K. Live limits unchanged. |
| **Tests** | New `ask-user-options.test.ts` (object options, aliasing, dedup, empty fallback, real minimax shape) + `context-window-heuristics.test.ts` (modern heuristics, 200K fetch-failure fallback). |
| **Release** | docs → 12.9.7; launchpad copy/version updated (no git); `docs/discord-release-12.9.7.md`; tag `v12.9.7` + push. |

## v12.9.6 — SHIPPED (2026-06-09): Terminal opens for real (correct asar.unpack key)

> v12.9.5 added node-pty to an `asarUnpack` array — an **electron-builder** key that electron-forge/electron-packager ignores. Verified against the shipped 12.9.5 build: `spawn-helper` was still inside `app.asar`, so `posix_spawnp` still failed.

| Area | Notes |
|------|-------|
| **Terminal spawn** | `forge.config.ts`: replaced `asar: true` + the dead `asarUnpack: [...]` array with `asar: { unpack: "{**/@lydell/node-pty-{darwin,linux,win32}-*/**}" }`. `AutoUnpackNativesPlugin` merges it with `**/*.node` (verified via minimatch + local `electron-forge package`: `spawn-helper` now in `app.asar.unpacked`). No app code change. |
| **Release** | docs → 12.9.6; launchpad copy/version updated (no git); `docs/discord-release-12.9.6.md`; tag `v12.9.6` + push. |

## v12.9.5 — SHIPPED (2026-06-09): Terminal opens in packaged builds (node-pty spawn-helper)

> Follow-up to v12.9: with the crash gone, the packaged Terminal showed "Interactive shell unavailable: posix_spawnp failed". node-pty's macOS `spawn-helper` (a non-`.node` Mach-O sibling of `pty.node`) was left inside `app.asar` by `AutoUnpackNatives` (which only unpacks `*.node`); node-pty resolves it to `app.asar.unpacked/.../spawn-helper` → ENOENT → `posix_spawnp failed`.

| Area | Notes |
|------|-------|
| **Terminal spawn** | `forge.config.ts` `asarUnpack`: added `**/@lydell/node-pty-{darwin,linux,win32}-*/**` (same pattern as `@ast-grep` platform pkgs) so `spawn-helper` + Windows conpty/winpty binaries land in `app.asar.unpacked` and get signed. No app code change — `pty-session-manager.ts` already degrades gracefully. |
| **Release** | docs → 12.9.5; launchpad copy/version updated (no git); `docs/discord-release-12.9.5.md`; tag `v12.9.5` + push. |

## v12.9 — SHIPPED (2026-06-09): Terminal crash fix (keytar removed) + packaged system prompt

> Prod-only crash: clicking the right-panel Terminal force-closed the app. Crash minidump (`Crashpad/completed/*.dmp`, lldb-symbolicated) showed **keytar** throwing an uncaught C++ `Napi::Error` on the main thread (`Napi::CallbackData::Wrapper` → `__cxa_throw` → `std::terminate` → `abort`) — uncatchable from JS, so v12.8's `uncaughtException` handler couldn't help. keytar (deprecated) was the sole Supabase session-store backend; opening the Terminal coincided with a session read/refresh that hit it. Separately, the packaged app was running on a degraded fallback prompt.

| Area | Notes |
|------|-------|
| **Terminal crash** | Removed `keytar` entirely. `supabase-secure-storage.ts` now uses Electron `safeStorage` (already the fallback; raises catchable JS errors) + encrypted `supabase-auth.enc` + one-time legacy-json migration. Existing users re-login once (old sessions lived only in keytar). Also dropped keytar from `package.json`, `forge.config.ts` (ignore + 2 rebuild lists), `src/types/keytar.d.ts`, `knip.json`. |
| **System prompt in prod** | `AGENTS.md`/`AGENTS_COMPACT.md`/`AGENTS_MODE_BASE.md` weren't packaged (root files excluded by the packager `ignore` allowlist) → `system_prompt.ts` fell back to a minimal prompt. Now shipped via `extraResource` and loaded from `process.resourcesPath` first when packaged (mirrors `src/skills`). |
| **Release** | docs → 12.9.0; launchpad copy/version updated (no git); `docs/discord-release-12.9.md`; tag `v12.9.0` + push. |

## v12.8 — SHIPPED (2026-06-08): stability fixes + crash hardening

> Three production issues from 12.7.0.

| Area | Notes |
|------|-------|
| **Token count** | `token_count_handlers.ts`: a torn-down ephemeral chat (deleted session) no longer throws `Chat not found: <id>` on a debounced `chat:count-tokens`; returns `computeTokenCountResult(req, [], null)` → no Sentry event, no error toast. |
| **Delete session** | `WorkspaceSessionList.handleDelete`: deleting the **active** session now calls `startNewWorkspaceConversation({ workspaceId, navigate })` (reuses empty default session via `pickSessionReuse`) so the user stays in the workspace instead of dropping to the selector. Background-session delete unchanged. |
| **Crash hardening** | `main.ts`: added `process.on("uncaughtException")` (report to Sentry + keep alive, mirrors `unhandledRejection`); wrapped `before-quit` chain in `try/finally` (always `app.quit()`). `supabase-secure-storage.ts`: wrapped the native `safeStorage.encryptString`/`writeFileSync` write. Converts hard `std::terminate` aborts into reported, survivable events. |
| **Release** | docs → 12.8.0; launchpad copy/version updated (no git); `docs/discord-release-12.8.md`; tag `v12.8.0` + push. |

## v12.7 — SHIPPED (2026-06-08): tool-schema sanitizer + chat-config cleanup + Sentry quieting

> A Mistral-routed Core turn 400'd with `"Invalid tool schema: False is not of type 'array'"`. Root cause was real (not a provider quirk): hand-written tool schemas with JSON-Schema-invalid `required: true/false` booleans, plus bare property-map schemas that lost all params to the permissive fallback. Fixed at the normalizer choke point.

| Area | Notes |
|------|-------|
| **Schema sanitizer** | New `sanitizeJsonSchemaForProvider` in `src/lib/ai/normalize-tool-schema.ts`: wraps bare prop-maps (`live_preview`/`rename_file`/`create_workspace` were being sent param-less to every provider) and repairs `required` booleans (strips them, hoists `required:true` names into the top-level `required` array). Wired into `normalizeToolInputSchemaForAiSdk` (Ask-tier path) and the 2nd tool-wiring path at `chat_stream_handlers.ts:~5173`. Unit-tested in `normalize-tool-schema.test.ts`. |
| **Chat config** | Removed the unused "Manage MCP tools" entry + MCP section from `ChatConfigDropdown.tsx`; cleaned up the now-dead `onOpenMcpTools`/`configSubView`/Popover wiring in `ChatInputControls.tsx`. MCP management stays in Settings → MCP Servers. |
| **Sentry** | Benign empty-output family (`AI_NoOutputGeneratedError`/`NoContentGenerated`/`EmptyModelOutputAfterRetry`) dropped via `sentry-before-send.ts` (`isNoUsableModelOutputError`) + `sentry-ignore-patterns.ts`. Scope: benign-only — other provider errors stay visible. |
| **Release** | docs → 12.7.0; launchpad copy/version updated (no git); `docs/discord-release-12.7.md`; tag `v12.7.0` + push. |

## v12.6 — SHIPPED (2026-06-08): sign-in UI fix

> Sign-in surfaces had regressed to the animation-only `AtlarixSignInHero` (Google-only). Restored real Google + GitHub OAuth buttons; added logout/login from the welcome screen.

| Area | Notes |
|------|-------|
| **OAuth buttons** | New `src/components/auth/OAuthSignInButtons.tsx` (recreates the deleted `AuthButton.tsx@3277e7a` UI — GoogleIcon SVG + lucide `Github`, "Continue with Google/GitHub") driven by `useAuth()`. Supabase path unchanged: `useAuth().signIn*` → `auth:sign-in {provider}` → `SubscriptionManager.signIn` → Supabase OAuth. `oauthPending`/`oauthProvider`/`oauthStatusLabel` drive the disabled/spinner state. |
| **Sidebar** | `app-sidebar.tsx` logged-out dropdown now renders `OAuthSignInButtons` (was `AtlarixSignInHero`, Google-only). Removed now-dead `handleSignIn`/`signInWithGoogle`/`useCallback`. |
| **Welcome screen** | `welcome-launcher.tsx`: signed-out gate shows the OAuth buttons (decorative `AtlarixAnimation` kept); signed-in header adds a **Sign out** control next to "Settings & account". |
| **Sign-in page** | `sign-in.tsx` swapped to `OAuthSignInButtons` for consistency (GitHub now offered there too). |
| **Release** | docs → 12.6.0; launchpad copy/version updated (no git); `docs/discord-release-12.6.md`; tag `v12.6.0` + push. |

## v12.5 — SHIPPED (2026-06-08): stability + concurrency batch, first tagged release

> Six reported issues + one UI fix, then the v12.5.0 release (the first real tag — folds in all the never-tagged v11/v12.0 work).

| Area | Notes |
|------|-------|
| **Concurrent sessions** | Renderer no longer overwrites the active chat when a second session opens. New `openChatTabsAtom` + `ChatTabStrip` (tabs with live streaming dots); sidebar already shows a background-stream spinner; tab cleanup on session delete. Per-chat state was already isolated by `chatId` in the backend — bug was purely renderer navigation (`open-workspace-session.ts` unconditional `activeChatIdAtom` overwrite). |
| **Interrupted-turn recovery** | New `session_messages.status` column (`complete`/`interrupted`, idempotent boot migration). Main process throttle-persists partial assistant text during streaming (crash/quit/sleep-safe), force-flushes on abort + `before-quit` + `powerMonitor suspend`, deletes the draft on clean completion. Renderer shows an "interrupted" banner + **Continue** (promotes the draft via `messages:mark-complete`, then resumes). |
| **Keep running on display sleep** | `powerSaveBlocker('prevent-app-suspension')`, refcounted by subclassing the `activeStreams` Map so all delete sites are covered. `powerMonitor` suspend/resume logging. (Lid-close suspend is OS-enforced — documented.) |
| **Compass stop cascade** | After a token-pool abort the agent loop fired another request → `AI_NoOutputGeneratedError` unhandled rejection. `runAgentTurn` now guards both the outer turn loop and the inner continuation loop on `abortController.signal.aborted` (throws → existing abort path). |
| **Compass budget/context** | Context window no longer over-pruned to 200K on the first turn (resolves the real per-tier window from the warmed OpenRouter catalog via `getCachedOpenRouterModelRow`). Added preflight (`tier/monthlyLimit/used/remaining`) + stop-cause (`rpc-limit_exceeded` vs `local-tally`) diagnostics. **Follow-up (server-side, NOT in this release):** reconcile the Supabase `record_compass_usage`/`get_compass_usage_state` monthly_limit so workforce accounts aren't metered at a free-tier cap — see `docs/compass-limits.md`. |
| **Login gate** | `requireAuthSession()` on `sessions:start`/`sessions:create` (backend) + renderer `ensureSignedInForWorkspace()` prompt before opening any workspace. |
| **Folder/file tool emojis** | Stripped from `file.ts` (buildTree, get_project_structure, list_files markers, get_file_outline, read_file tip) and `repo-overview.ts`. Legacy `📄` grep parser kept for old persisted results. |
| **Settled "A" indicator** | Anchored to the last *assistant* message (not last array element) so it persists after a turn even when a trailing synthetic/user message is appended. |
| **Release** | `package.json`/`README`/`CHANGELOG`/`TODO` → 12.5.0; new `docs/discord-release-12.5.md`; launchpad copy/version updated (no git on launchpad); `git tag v12.5.0` + push triggers the release Action. **`ATLARIX_CORE_MODEL_4` repo secret must be set.** |

## Post-register batch (approved 2026-06-07): sessions 16–22

> The four clusters the register left open: S16 security+follow-ups, S17/S18 TTFT perf (Tier 5 "perf is identity"), S19 tool-resolution consolidation (3.10), S20/S21 Blueprint tail + retrieval eval, S22 release v12.0.0 PREP (no tag — manual test first). Decisions recorded: single v12.0.0 version; worktree-per-agent DEFERRED; browser_navigate stays scheme-gated (consent follow-up CLOSED as conscious decision); renderer `file:read-content` stays ungated (user-initiated opens).

### v12 session 22 — shipped (2026-06-07): release v12.0.0 PREP (no tag — manual test first)

| Area | Notes |
|------|-------|
| **Version** | `package.json` 10.1.0 → **12.0.0** (decision: the never-tagged v11 work folds into one v12.0.0 release). `npm run verify:lockfile` clean. |
| **Changelog** | `[12.0.0] — Unreleased (pending manual test)` section written: the engine release (unified loop, native history, edit-verify, capability profiles, permissions+hooks, user agents, background agents, Blueprint v2 + measured baseline, TTFT work, eval harness) + Fixed/Changed including the **legacy DB hooks retirement release note** (migrate to `.atlarix/hooks/hooks.json`). The v11 section retitled "included in 12.0.0 above". |
| **README** | Current release → v12.0.0; new bullets: background agents, user agents + portable `.atlarix`/`~/.atlarix` config, verified edits, native tool history. |
| **CI sanity** | release.yml `ATLARIX_CORE_MODEL_1..3` fall back to legacy `COMPASS_MODEL_*`; **CORE_MODEL_4 has NO fallback — set the repo secret before tagging**. Bundled migrations cover 0061 (62 total). |
| **`docs/v12-manual-test-checklist.md`** | The pre-tag deliverable: engine parity per mode, prompt-cache hold + native replay across reload, edit-verify gate on/off, ruleset/hook enforcement (incl. global layer + Settings pointer), background agents incl. restart-revert, capability trim on a 7B, Blueprint v2 on real repos, **wall-clock TTFT on the largest real workspace** (the human verification of S17/S18), packaged-build + migration-on-real-profile checks, then the tag command. |
| **NOT done on purpose** | No `git tag`, no push to atlarix-releases, no launchpad edits (launchpad copy aligns AFTER the release is live — checklist item 10). |

### v12 session 21 — shipped (2026-06-07): retrieval eval — the Tier-6 "measure it" baseline

| Area | Notes |
|------|-------|
| **Fixture repo** | `tests/fixtures/blueprint-eval-repo/` — synthetic TS+Python shop (27 files, known call graph): tsconfig `@lib/*` alias imports, a computed-callee dynamic dispatch (`handlers[jobType]()`), thin Python small-modules (worker/) — exercises S12 alias edges, S20 dynamic-call counter + density override. Excluded from `npm run ts` (tsconfig.tests.json `exclude`) and oxlint (`tests/fixtures/**`) — it's DATA, not project code. |
| **Ground truth** | `ground-truth.json`: 20 tasks `{id, category, section, task, topic, targetFiles[]}` across exact/fuzzy/structure/python categories. `topic` uses get_blueprint's documented `\|`-alternates form (a model following the tool docs). |
| **`retrieval.eval.test.ts` (report mode)** | Drives the REAL retriever (ctags + in-process ast-grep + BM25-fused centrality slice) via `ToolRegistry.execute("get_blueprint")` + `searchBlueprintBm25` directly — no chat loop needed for P@1. Emits the per-category JSON summary (the paper dataset). |
| **BASELINE (2026-06-07, deterministic)** | **get_blueprint P@1 = 100%** (room-level, all 4 categories — including fuzzy synonyms and Python) vs **raw BM25 P@1 = 45% / P@3 = 50%** (file-level; fuzzy 20%, camelCase tokenization gap: query "hashing" can't match token "hashpassword"). The thesis in data: sectional structural retrieval with topic filtering beats lexical search. Found while authoring: space-separated topics score FAR worse than `\|` alternates — the tool-doc guidance materially matters. Regression floors pinned well under baseline (gb ≥ 75, bm25 ≥ 25; room for ctags-version variance). |
| **Consciously deferred** | calls-to-target (needs REAL model runs — the fake-LLM can't reason its way to a target); file-level get_blueprint precision (room-level is the current contract); embedding comparison (Tier 5 guardrail: measure absolute, no embeddings added). |
| **Verification** | 55 agent-evals (+1), `npm test` 1165/1165 (+1), `npm run ts` clean, oxlint 8 (baseline), knip 0 unused files. Boot smoke N/A — zero `src/` changes this session (S20's verified binary is byte-identical). |

### v12 session 20 — shipped (2026-06-07): Blueprint v2 tail — dynamic-call honesty, BM25 stoplist, density override

| Area | Notes |
|------|-------|
| **Dynamic calls counted, not silent (Tier 6)** | `scanCallsForFile` counts call sites whose callee fails the bare-identifier regex (member `a.b()`, computed `obj[fn]()`, expression callees) instead of dropping silently. Threaded the whole chain: `{edges, dynamicCalls}` return → worker message → pool tally (`get/resetAstGrepDynamicCalls`, same per-scan lifecycle as the Tier-6 #4 error counter) → `StructuralScanResult.dynamicCallCount` → `RTEParseResult` → blueprint disk-cache manifest (persists across reloads) → section meta → **`get_blueprint` output**: a markdown note ("~N call sites use member/computed callees … treat missing edges as 'unknown', not 'no relationship'") + `dynamicCallCount` field. Incremental single-file updates keep the whole-scan count (delta not worth manifest churn — documented). |
| **BM25 generic-identifier stoplist (Tier 6)** | `name:4` KEPT for specific names; symbols whose WHOLE name is a generic word (`handle`, `process`, `get`, … ~45 entries) index the name under a new `nameGeneric:1` field instead. camelCase/snake_case names tokenize as single tokens so they're unaffected. `isGenericIdentifierName` exported. IDF damping deferred (stretch). |
| **Thin-graph density override (Tier 6)** | `assessBlueprintRichness`: a graph with `functions/files ≥ 2`, `files ≥ 3`, and ≥1 confirmed edge is NOT thin regardless of absolute counts — idiomatic Python (many small modules) no longer degrades to file-tree backfill. Absolute thresholds stay the floor; disconnected or too-few-file graphs never take the escape hatch. |
| **Tests** | `blueprint-s20.test.ts` (8): real ast-grep scan counts ≥3 dynamic callees + bare call still resolves + zero-count control; stoplist classification + a bare `process` symbol no longer outranks contextual matches (wink ≥3-docs + string-id gotchas); density override positive + ratio/min-files/no-edge negatives. All 26 existing blueprint tests green. |
| **Verification** | 54 agent-evals, `npm test` 1164/1164 (+8), `npm run ts` clean, oxlint 8 (baseline), knip 0 unused files, boot smoke OK. |

### v12 session 19 — shipped (2026-06-07): resolveToolsetForSession — 3.10 CLOSED

| Area | Notes |
|------|-------|
| **`src/lib/tools/resolve-toolset.ts`** | The ONE assembly of the 4-stage pipeline (registry metadata → mode allowlist → session loader → capability trim) + the plan-tool union (S4 fix), user-agent `tools:` intersection (7A), and the **delegation-surface decision** (trim + user-agent gates) — returned as `{tools, capabilityProfile, delegationAllowed, preTrimCount}`. Branch differences are explicit params, not drift: ask starts from `getToolsForAskMode` + `includeToolForSession` mode filter; build starts from `getToolsForContext` + loader/core/ws-integration filter (mode gating at execute time). |
| **Both sites replaced** | Ask (~L4285) and build (~L4990) assembly collapsed to a resolver call each; duplicated `getCapabilityProfile`/trim/intersection/delegation-gate code deleted; 5 imports dropped from the handler. `askLoadedNames` snapshot for the per-round manifest re-declared post-resolve (`getLoadedToolNames` returns a copy — assembly-time semantics preserved). |
| **Golden A/B gate (the refactor proof)** | Pre-refactor capture of the EXACT offered tool list per mode (ask=31, plan=32, build=38) → refactor → re-capture → **byte-identical diff**. The "two sites were never actually identical" risk did not materialize. |
| **`toolset-golden.eval.test.ts` (permanent)** | The exact per-mode offered surface is now a pinned CONTRACT (3 evals, exact-list equality against the embedded golden). Future tool additions/pipeline changes must update the golden consciously. Pipeline doc in mode-tool-registry.ts header updated to point at the resolver. |
| **Verification** | 54 agent-evals (+3), `npm test` 1156/1156 (+3), `npm run ts` clean, oxlint 8 (baseline), knip 0 unused files, boot smoke OK. |

### v12 session 18 — shipped (2026-06-07): TTFT parallelization — sum(loads) → max(loads)

| Area | Notes |
|------|-------|
| **Network pre-flights overlapped** | `getContextWindowDetailed` depends only on `effectiveModel` — started CONCURRENTLY with `getModelClient`, awaited at its original `[budget]` log site. The **Compass usage Supabase RPC** starts the moment the provider is known and is awaited at the original limit-check site — it now overlaps the tier/window work instead of serially blocking dispatch (the limit-exceeded early-return semantics are unchanged; per-step metering still enforces mid-turn). Noop `.catch` guards suppress unhandled-rejection if the turn throws before the await (the await still rethrows). |
| **Context-section loads concurrent** | The six independent loads (mode-skill, repo-skills, workspace-caps, plan-artifact, fs-truth, atlarix-md) became loader functions returning section-or-null, run via ONE `Promise.all`, pushed in one place. Per-loader try/catch preserves the old error isolation; `assembleContextSections` sorts by priority (all distinct), so assembly output is byte-identical to the serial path. `streamTurnIdForLedger` verified stable (its reassignments live under the disabled `shouldCreateTaskLedger` block). The S17 spans now measure concurrent wall time. |
| **Mode-aware deferral consciously DROPPED (plan step 3)** | After parallelization, deferring a section saves only `max(loads) − second-max`, and the seconds-scale offender (`fs-truth`) was ALREADY build-gated; skipping workspace-caps in ask would change ask-mode prompt content (model knows less about the stack) for marginal latency. Revisit only if the user's real-repo waterfall numbers show one section dominating. |
| **Evals** | `ttft-assembly.eval.test.ts` (2): a build turn carries the concurrently-loaded sections (mode skill + atlarix.md canary) in priority order in the dispatched system prompt; a second fresh chat produces the identical section order (prompt-cache determinism guard). The 4 native-history byte-stability canaries stay green — round-to-round cache stability untouched. |
| **Verification** | 51 agent-evals (+2), `npm test` 1153/1153 (+2), `npm run ts` clean, oxlint 8 (baseline), knip 0 unused files, boot smoke OK. Real-repo before/after waterfall comparison = S22 manual checklist (the harness workspace is too small to show the win). |

### v12 session 17 — shipped (2026-06-07): TTFT pre-flight instrumentation (measure first)

| Area | Notes |
|------|-------|
| **`src/lib/agent/preflight-timing.ts`** | `PreflightTimer` — `time(name, fn)` WRAPS an awaited step (never reorders, rethrows; records even on failure), `reportOnce(chatId)` emits ONE greppable `[perf] preflight-breakdown chat=… total=…ms accounted=…ms step=…ms …` line at the FIRST dispatch of the turn (the `ttftStartRef` site inside `simpleStreamText` — per-round calls after the first are no-ops). |
| **Wrapped steps (17 spans)** | auth, session-bind, custom-commands, persist-user-msg, model-client, context-window, **compass-preflight** (the Supabase RPC), app-lookup, system-prompt, mode-skill, priority-skills, workspace-caps, plan-artifact, fs-truth, atlarix-md, prompt-bundle, max-tokens, temperature. `accounted` vs `total` exposes untimed (sync) pre-flight — harness already shows a ~1s unaccounted gap worth chasing in S18. |
| **Presence gate** | `preflight-timing.eval.test.ts`: a real build turn emits EXACTLY ONE breakdown line carrying the core spans. Gotcha discovered: electron-log invokes hooks once PER TRANSPORT — the eval keys on `transportName === "console"`. Wall-clock thresholds are environment-dependent → manual release checklist (S22), not CI. |
| **Conscious scope** | Measurement only — zero reordering (S18 parallelizes against these numbers). The standalone perf-smoke script was dropped in favor of the eval: the harness drives the REAL handler in-process, and app-boot scripts proved flaky under the dev environment. |
| **Verification** | 49 agent-evals (+1), `npm test` 1151/1151 (+1), `npm run ts` clean, oxlint 8 (baseline), boot smoke OK (direct-electron recipe). |

### v12 session 16 — shipped (2026-06-07): security hardening + ruleset global layer + bg-agent restart fix

| Area | Notes |
|------|-------|
| **find_file secret denylist** | `find_file` glob results filtered through `isBlockedSecretBasename` (file.ts) — enumerating `.env*`/key/credential names leaked that secrets exist (read_file/list_files/search were already gated; find_file was the gap). Unit: `find-file-secret-denylist.test.ts` (2). |
| **Global `~/.atlarix/permissions.json` (2.2 follow-up)** | `ruleset.ts`: loader generalized to `loadRulesetFile` (same per-file mtime cache), `globalRulesetPath()` (+ `setGlobalAtlarixDirForTests` seam), `mergeRulesets` (deny/ask union, allocation-free when one side empty), `loadEffectiveRuleset` = merge(global, workspace) — wired at the single funnel call site. Deny error text now source-agnostic ("workspace or global ~/.atlarix"). Eval: global deny blocks a native run_command with no workspace deny; unit: 4 merge cases. |
| **Legacy DB hooks RETIRED (2.2 follow-up)** | `hooks-manager.ts` + `hooks_handlers.ts` DELETED end-to-end (runtime read, 5 IPC channels, preload entries, ipc_client methods, settings-page editor → replaced with a static pointer to `.atlarix/hooks/hooks.json`, interceptor's `runAdvisoryHooks` + 7 call sites — the run_command `try/finally` became a bare block, session-4 pattern). `atlarix_hooks` TABLE + migrations KEPT (chain integrity, counsel precedent). Release note in S22: migrate to file hooks. |
| **bg-agent restart-revert FIX (2.3 deferred)** | `snapshotTurnId`/`changedFiles`/`mode`/`reverted` lived only in the in-memory map — keep/revert was silently LOST on app restart. Migration **0061** adds `chat_sessions.agent_meta` (JSON); persisted on done/error/revert, restored in `hydrateBackgroundAgentsFromDb`. Eval: write → simulated reload → `resolve('revert')` still deletes the file (pre-S16: "No snapshot to revert"). |
| **Agents tab auto-surface (2.3 deferred)** | Latent bug found: the `agents` tab was UNREACHABLE — session 15 wired type/icon/render arm but never added it to `PANEL_TABS['code-preview']`. Fixed + auto-surface: `agents:background:start` broadcasts `agents:background:started` to all windows; RightPanel listener opens the panel on the Agents tab (`onBackgroundAgentStarted` in ipc_client, preload receive channel added). |
| **Verification** | 48 agent-evals (+2), `npm test` 1150/1150 (+8), `npm run ts` clean, oxlint 8 (baseline), knip 0 unused files, migration applies (eval temp DB + boot), boot smoke OK. |

---

## v12 — Hardening & Core-Loop Rewrite (roadmap)

> **Goal:** close the gap between Atlarix and a real AI IDE (Cursor / Claude Code / opencode / Codex / Antigravity) where any model is brought into a workspace and *just works*. This register is grounded in two long build sessions, three parallel audits (defect sweep, opencode/Claude-Code reference extraction, test-suite audit), and direct spot-verification. References live in `atlarix-references/opencode` and `atlarix-references/claude-code`.
>
> **Session 1 (2026-06-05) SHIPPED: the Tier 4 agent-eval harness + quick wins 1.1 / 1.4 / 2.4.** **Session 2 (2026-06-05) SHIPPED: 0.2 native tool-call history + multimodal tool results (build mode)** **Session 3 (2026-06-06) SHIPPED: 0.1 — `runAgentTurn` engine extracted, BUILD **and ASK** migrated behind `enableUnifiedAgentLoop` (default OFF), vestigial agent path DELETED + legacy coercion, ask gains native history via the engine** **Session 4 (2026-06-06) SHIPPED: 0.1 CLOSED OUT — legacy ask+build loop bodies AND the flag DELETED (the engine is the only path), mid-round correction reinject via AI-SDK `prepareStep`, plan-tool defect FIXED (plan-write tools offered in ask+plan), `isTaskComplete` deduped, eval matrix collapsed to one leg** **Session 5 (2026-06-06) SHIPPED: quick-wins + purge batch — 1.5 aux-Compass notice, Tier 3 batch (3.1/3.2/3.3/3.4/3.5/3.6/3.7/3.8/3.9), 2.6 dead knobs deleted, 2.7 purge (counsel scaffold, blueprint codegen, agent-lightning), `ts:tests` typecheck coverage** **Session 6 (2026-06-06) SHIPPED: 0.3 edit-verify loop — postWriteVerify seam wired (LSP diagnostics on each round's writes, fed back in-loop; premature `<task_complete>` on broken code BLOCKED), `enableAutoFixProblems` finally has logic (1.2), edit_file structured no-match retry guidance, 2.5 re-scoped to optional post-turn deep review** **Session 7 (2026-06-06) SHIPPED: 0.4 phases C1+C2 — structured contracts (legacy `__PERMISSION_REQUIRED__` text format deleted, `run_tests` fixed to the structured envelope, marker inventory documented) + single id space (`sessionRowId` rides on ephemeral messages; edits target DB rows DIRECTLY — ordinal mapping is now the legacy fallback only)** **Session 8 (2026-06-06) SHIPPED: 0.4 CLOSED (pragmatic) — ordinal edit fallback DELETED (sessionRowId is the only edit path; the ask_user Q→A gap closed), ephemeral-chat renamed to `src/lib/chat/stream-transport.ts` with the turn-buffer contract, `docs/message-store.md` written, buffer↔DB lockstep eval-pinned** **Session 9 (2026-06-06) SHIPPED: 2.1 model-capability profiles — per-model toolset trim (resolves 1.6), schema simplification for weak models, cost-field wiring (3.9 follow-up), the documented 4-stage tool-resolution pipeline (3.10 partial), 0.2's media gate absorbed** **Session 10 (2026-06-06) SHIPPED: 2.2 permissions + Tier 7B hooks — portable `.atlarix/permissions.json` allow/deny/ask ruleset + blocking file-based `.atlarix/hooks/` (pre_tool_use deny, post_tool_use advisory, stop gate on task_complete), both at the SINGLE runToolExecute funnel (closes the native-tool gate-coverage gap)** **Session 11 (2026-06-06) SHIPPED: Tier 7A/C/D — user-defined agents from `.atlarix/agents/<name>.md` (system block + tool-allowlist intersection + model override, picker-selectable), the portable `.atlarix/` contract doc, BYOK per-turn spend estimate** **Session 12 (2026-06-06) SHIPPED: Tier 6 Blueprint v2 — alias edge resolution (tsconfig paths/baseUrl + package imports), centrality-ranked slices with a summarized tail, ctags signatures in slice + markdown** **Session 13 (2026-06-06) SHIPPED: 2.3 background agents V1 (read-only) — detached `chat:stream` turn via a synthetic recording sender into its own session, main-side assistant-message persistence, in-memory status; design spike in docs/background-agents.md. THE v12 COMPLETION REGISTER (Tiers 0–7) IS NOW CLOSED.** **Session 14 (2026-06-06) SHIPPED: Blueprint v2 completion — BM25 text-relevance fusion into slice ranking (the partial Tier-6 #2 closed), getRoomKey 2-level granularity (api/v1 ≠ api/v2), edge confidence (import-inferred down-weighted vs call-confirmed), worker-crash edge recovery, slice cache** **Session 15 (2026-06-06) SHIPPED: 2.3 background agents V2 — write-capable detached agents (in-process auto-approve via the interceptor + microtask defer; `shouldAutoApprovePermissions` untouched), shadow-git approval gate (keep/revert), kind/status migration + restart hydration, per-agent cancel, Agents RightPanel tab; fixed buildLiveWorkMode to honor per-turn workModeOverride** — see the session tables below.

### v12 session 15 — shipped (2026-06-06): 2.3 background agents V2 (write + approval gate)

| Area | Notes |
|------|-------|
| **Auto-approve crux** | A detached write agent has no human mid-turn. `setBackgroundAutoApprove(chatId)` flags the chat; the interceptor's `permission-request` listener (which broadcasts to BrowserWindows for foreground) instead microtask-defers `executeBufferedPermission(chatId, opId)` — the production approval path. Microtask defer dodges the re-entrancy hazard (registers `waitForApproval` first). `shouldAutoApprovePermissions` stays hard-`false` (locked) — this is a separate per-chat opt-in. |
| **workModeOverride fix** | `buildLiveWorkMode` re-read `readSettings().workModePreference` (persisted) to catch mid-turn picker changes — which silently defeated a per-turn `workModeOverride` (a detached `build` turn ran read-only). Now `req.workModeOverride ?? readSettings().workModePreference ?? effectiveWorkMode` — explicit per-turn override wins. |
| **Isolation = existing shadow-git** | The build interceptor auto-captures a snapshot (keyed by the ledger turn id) before every write. New `ChatResponseEnd.snapshotTurnId` (set in `ensureTerminal` via a captured var + the build epilogue) carries it to the runner; `listSnapshotFiles` (snapshot-manager) reads the changed-file manifest. |
| **Approval gate + cancel** | `agents:background:resolve(keep\|revert)` → `revertSnapshot` (created files deleted) / no-op; `agents:background:cancel` → `abortChatStream(chatId)`. Both delegate to lib functions (`resolveBackgroundAgent`/`cancelBackgroundAgent`) so evals drive them without the renderer. |
| **Persistence** | Migration `0060` adds `chat_sessions.kind`/`status`/`status_error` (hand-authored — drizzle-kit's interactive rename prompt blocked generation; journal + bundled regen + seed-verification case added). `createBackgroundWorkspaceSession` sets kind=background/status=running; runner UPDATEs status on finish; `hydrateBackgroundAgentsFromDb()` rebuilds the map on boot (running-at-boot → error: interrupted). |
| **UI** | `AgentsPanel.tsx` + an `agents` RightPanel tab: poll `listBackgroundAgents()`, show status, cancel, keep/revert, changed-file count. |
| **Evals** | `background-agent.eval.test.ts` +3: write-mode auto-approves with NO `during` callback (file on disk + `changedFiles` recorded); `resolve('revert')` deletes the created file / `'keep')` leaves it; status survives a `_resetBackgroundAgents()` + `hydrateBackgroundAgentsFromDb()` reload. |
| **Verification** | 46 agent-evals (+3), `npm test` 1142/1142 (+3), `npm run ts` clean, oxlint 8, knip 0 unused files, migration applies in temp DB, boot smoke OK. |

### v12 session 14 — shipped (2026-06-06): Blueprint v2 completion (post-closure follow-ups)

| Area | Notes |
|------|-------|
| **#1 BM25 fusion (closes the partial)** | `get_blueprint` (async) queries `searchBlueprintBm25` on the topic before slicing; `bm25HitsToRoomScores` reduces file-hits → a per-room 0..1 relevance map by matching `hit.file` against `room.functions[].file` (normalized-posix; reuses the room→file linkage, no key re-derivation). `buildSlice` gains an OPTIONAL trailing `bm25ScoreByRoom` arg; comparator = matched-first, then `bm25Norm*2 + degreeNorm`. Absent map → byte-identical centrality ordering (locked tests pass). |
| **#2 getRoomKey granularity** | `rte_to_blueprint.ts` `roomKeyFromParts`: generic roots descend 2 levels only when the 2nd segment is a directory (`parts.length > 3`) so `src/api/v1/handlers/x` → `api/v1` ≠ `api/v2`, while shallow `src/auth/login.ts` stays `auth` (no per-file over-split). Non-generic roots unchanged. |
| **#3 edge confidence** | Import edges marked `inferred:true`, call/api `inferred:false`, threaded through `mapRteEdge` + the room-edge builder (a confirmed call upgrades an earlier import between the same pair); slice centrality counts inferred edges at 0.5. |
| **#4 worker-crash recovery** | `worker-pool.ts`: a crashing/exiting worker now resolves its in-flight batch immediately (`[]`, counted) instead of hanging to the 60s timeout; `getAstGrepScanErrors()`/`resetAstGrepScanErrors()` + a per-scan warning in `runStructuralScan` when connectivity is under-reported. |
| **#5 slice cache** | `blueprint-slice-cache.ts`: LRU(32) of built slices keyed `(workspaceId|focus|topic|scope|path|depth)`; `markBlueprintSliceDirty(workspaceId)` called beside `markBm25Dirty` in `setCachedBlueprint` drops a workspace's slices on reparse. |
| **Tests** | `blueprint-v2.test.ts` +9 (BM25 outranks a hub + non-empty-map guard + path-normalize + no-map-identical; import/call inferred wiring; api/v1≠api/v2 + no shallow over-split; cache hit+dirty; scan-error counter). |
| **Verification** | 43 agent-evals, `npm test` 1139/1139 (+9), `npm run ts` clean, oxlint 8, knip 0 unused, boot smoke OK. |

### v12 session 13 — shipped (2026-06-06): 2.3 background agents V1 (read-only)

| Area | Notes |
|------|-------|
| **Design spike** | `docs/background-agents.md`: verified the streaming path supports detached turns (concurrent streams keyed by chatId; `safeSend` no-ops on a synthetic sender; the engine binds its own workspace + persists the user message). Surfaced two real prerequisites — both fixed here. Verdict: clean → V1 built. |
| **Prereq fixes** | (1) The one unwrapped `event.sender.send` (compass error path, chat_stream_handlers ~L3869) would throw on a synthetic sender → wrapped in `safeSend`. (2) The assistant message is persisted by the RENDERER on response:end; extracted `addSessionMessageDirect` in workspace_session_handlers (the `messages:add` handler now delegates) so a renderer-less turn can persist it. |
| **Runner** | `src/lib/agents/background-agent.ts`: `startBackgroundAgent({appId, prompt, title, startedAt})` → `createBackgroundWorkspaceSession` (fresh session + bound transport, no empty-reuse) → dispatch the captured `chat:stream` handler (`getChatStreamHandler()`) with a synthetic recording sender + `workModeOverride:"ask"` (READ-ONLY — no writes/run_command, sidesteps the worktree-isolation decision) → await the sender's `chat:response:end` (the handler returns immediately via `void runStream()`) → persist the assistant message from the captured buffer. In-memory status map (`running`/`done`/`error`) via `listBackgroundAgents`. |
| **IPC** | `agents:background:start` (fire-and-forget) + `agents:background:list` (poll) + preload + ipc_client. A finished agent appears in the normal session list titled `🤖 …`; a dedicated "agents" panel is the documented next increment (data is already exposed). |
| **Eval** | `background-agent.eval.test.ts` (2): a detached turn runs the real engine to completion and persists BOTH the engine's user message and the runner's assistant message into its own session (status `done`); a missing-scenario turn ends in a terminal state, never stuck `running`. |
| **Deferred (documented)** | write-capable background agents (need worktree/shadow-git isolation — separate decision), a dedicated agents view, persistent status across restart, per-agent cancel. |
| **Verification** | 43 agent-evals (19 files, +1), `npm test` 1130/1130 (+2), `npm run ts` clean, oxlint 8, knip 0 unused files, boot smoke OK. |

### v12 session 12 — shipped (2026-06-06): Blueprint v2 — alias edges, ranked slices, signatures

| Area | Notes |
|------|-------|
| **#1 alias edge resolution** | `resolve-edges.ts`: non-relative TS/JS imports now resolve via tsconfig `paths`/`baseUrl` (+ one level of `extends`) and package.json `#imports` BEFORE returning null. JSONC-tolerant reader (strips comments + trailing commas); per-root config cache (`clearAliasConfigCache` test seam); longest-prefix-first pattern match + extension/index probing. Recovers the cross-module edges that `@/lib/x`-style aliases previously dropped silently — for a structural-graph retriever, missing edges = the model follows dead ends and over-reads. |
| **#2 centrality-ranked slices** | `buildSlice`: kept rooms ranked (directly-matched first, then edge-degree) and capped at 40, with the dropped tail summarized in `omittedRooms` (count + top labels) instead of truncated arbitrarily; edges re-pruned to the final kept set. Functions within a room ranked signature-rich-first before the 50-cap. `get_blueprint` appends a "+N more rooms (lower centrality): …" line to the model markdown. |
| **#3 signatures** | `simpleDescription` (the ctags signature, source "pattern"/"jsdoc") now rides slice `functions[]` as `signature` and renders in tool-mode markdown in place of the bare name when it looks like a signature (`includes("(")`, not AI-generated) — ~same tokens, lets the model pick the right function without an extra read. |
| **Conscious deferral** | Full BM25 text-relevance fusion into slice ordering needs the query/topic + the async index threaded into the (sync) `buildSlice` — deferred; centrality (the structural half of "rank by relevance × centrality") shipped. Recorded in the Tier 6 register. |
| **Tests** | `blueprint-v2.test.ts` (6): tsconfig-`paths` + package-`#imports` resolution (+ JSONC strip), unresolvable-bare-import still null, signature on slice functions, centrality cap keeps the hub + summarizes the 5-room tail, markdown renders the signature. All 9 existing blueprint tests stay green. |
| **Verification** | 41 agent-evals, `npm test` 1128/1128 (+6), `npm run ts` clean, oxlint 8, boot smoke OK. |

### v12 session 11 — shipped (2026-06-06): Tier 7A/C/D — user agents, .atlarix contract, BYOK spend

| Area | Notes |
|------|-------|
| **7A user agents** | `src/lib/agents/user-agents.ts`: `.atlarix/agents/<name>.md` frontmatter `{description, mode, model?, tools?}` + system-prompt body. Resolved in the stream handler right after `settings` (before model + work-mode resolve): patches the work mode to the agent's base mode, sets `req.modelOverride` from `model:` (provider/name split), prepends the rendered system block into BOTH the build `baseSystemPrompt` and the ask rebuilt header, and intersects `tools:` with the offered set at both capability-trim sites (delegation also suppressed when the allowlist omits it). Selectable via `req.agentOverride` OR the persisted `settings.selectedAgent`. Frontmatter parser handles unquoted YAML inline arrays (`[a, b]`). Path-traversal guarded; reserved `<mode>-mode.md` names skipped (those are skill-loader's mode overrides). |
| **7A picker** | `ChatIntentSelector.tsx` gains a "Workspace agents" group (loads via new `agents:list` IPC); selecting an agent sets `selectedAgent`, picking a built-in mode clears it. New `selectedAgent` settings field. |
| **7C contract doc** | `docs/atlarix-contract.md`: the full committable-vs-cache `.atlarix/` spec (atlarix.md, memory.md, agents/ + mode-skill distinction, permissions.json, hooks/, skills/, reference-projects.json, .atlarixignore vs the generated caches), the user-agent format, a suggested `.gitignore`, follow-ups (`~/.atlarix/` global layer, agent editor UI). |
| **7D BYOK spend** | `src/lib/routing/byok-pricing.ts`: per-turn USD estimate from SDK `response.usage` input/output split × pricing — OpenRouter cached-row `pricing` first, then a static table (Claude rates from the claude-api skill: Opus $5/$25, Sonnet $3/$15, Haiku $1/$5 per MTok; +GPT). Returns null for Compass/Core (metered separately) and unknown models (never a guessed number). Tokens accumulate across rounds in `onFinish`; `turnCostUsd` rides `chat:response:end`; TokenBar shows an "Est. cost (last turn)" line (`<$0.01` floor) via a new per-chat atom (cleared on delete). |
| **Evals/tests** | `user-agent.eval.test.ts` (agent system block reaches the model + tool intersection to exactly its 2 tools); `user-agents.test.ts` unit (10: frontmatter, mode default/coerce, reserved-name + traversal guards, list ordering); `byok-pricing.test.ts` unit (8: usage shapes, static pricing, Compass/unknown → null). |
| **Verification** | 42 agent-evals (18 files, +1), `npm test` 1122/1122 (+19), `npm run ts` clean, oxlint 8, knip 0 unused files, boot smoke OK. |

### v12 session 10 — shipped (2026-06-06): 2.2 permission rulesets + 7B blocking file hooks

| Area | Notes |
|------|-------|
| **`src/lib/tools/permissions/ruleset.ts`** | Portable `.atlarix/permissions.json` (`{deny, ask}`) — Claude-Code-style `tool_name(glob-over-target)` / bare-tool-glob patterns; target = command for run_command/run_tests, path for file tools. `deny` ENFORCED (structured tool error the model sees, deny>ask precedence); `ask` parsed+logged (v1: mutating tools already prompt via the interceptor; the per-workspace command/file permission stores already do auto-allow — not duplicated). mtime-cached; missing file ⇒ EMPTY ⇒ behavior identical to pre-2.2. |
| **`src/lib/hooks/file-hooks.ts` (rewrite, not the dead DB manager)** | `.atlarix/hooks/hooks.json` — `pre_tool_use` (blocking: non-zero exit denies the tool, model sees the stderr tail), `post_tool_use` (advisory fire-and-forget), `stop` (gate on `<task_complete>`). `match` reuses the ruleset pattern syntax; hooks run with cwd=workspace + `ATLARIX_TOOL/TARGET/TRIGGER` env, 20s timeout. Lean: `/bin/sh -c`, globs, no AI. The legacy DB `atlarixHooks` table is untouched (advisory; retire via a release note later). |
| **Single funnel = gate-coverage FIX** | Both insert at `runToolExecute` (chat_stream_handlers.ts:~846) — the ONE path for ask+build, native AND text-tool execution. NATIVE tools previously bypassed `runCommandGateResult`/`debugWriteGateResult` (those lived only in the text-tool wrappers); the ruleset/hook check now covers them. The legacy wrapper gates still apply ON TOP (defense in depth). Keys on the injected `workspace` arg (present in both ask L4321 and build execArgs). |
| **Stop gate composes with 0.3** | New `AgentProfile.taskCompleteGate` seam (beside postWriteVerify): when the model claims complete, a red stop hook suppresses the break (SAME bounded `MAX_VERIFY_BLOCKED_BREAKS` counter — a permanently-red gate can't wedge a turn) and the failure feeds back as the next nudge. Engine break-gate refactored to evaluate diagnostics AND the stop hook before honoring `<task_complete>` or ledger-complete. |
| **Evals/tests** | `permission-ruleset.eval.test.ts` (3): deny glob blocks a NATIVE run_command (no approval prompt; structured error in the next request); pre_tool_use hook denies with its stderr tail; stop hook blocks `<task_complete>` round 1 → model creates a sentinel via approved write → passes round 2. + `permission-ruleset.test.ts` unit (11: target extraction, glob/precedence/malformed). |
| **Verification** | 40 agent-evals (17 files, +3), `npm test` 1103/1103 (+14), `npm run ts` clean, oxlint 8, knip 0 unused files, boot smoke OK. |

### v12 session 9 — shipped (2026-06-06): 2.1 capability profiles (+1.6, 3.9, 3.10-partial)

| Area | Notes |
|------|-------|
| **`src/lib/routing/model-capability-profile.ts`** | `getCapabilityProfile({name, provider, builtinProviderId})` → `{maxTools, schemaComplexity, supportsToolMedia}`. Catalog-first: known-strong families (claude/gpt/gemini/deepseek/grok/72B+ …) ALWAYS full — incl. their small variants (gpt-4o-mini/haiku/flash are competent). Heuristic fallback: ≤13B param-count in the id on an UNKNOWN family → LOW (12 tools, simplified schemas); small-words hint (`mini/nano/tiny`) trims only on LOCAL providers (ollama/lmstudio). **DEFAULT = full surface — never degrade what we can't classify** (over-trim breaks tasks; under-trim = today's behavior). |
| **Trim wired at both assembly sites (resolves 1.6)** | The documented LAST stage of the tool-resolution pipeline (registry metadata → mode allowlist → session loader → capability trim; pipeline doc in mode-tool-registry.ts header = the 3.10 consolidation down-payment). Keep-priority: core tools first, then ascending registry `cost` (3.9's follow-up — cost finally weights the toolset); output preserves input order (manifest rendering stable). Delegation tools are NOT attached on trimmed profiles (a weak model orchestrating sub-agents of itself is the 1.6 failure mode; their schemas are the heaviest on offer) — found because the first eval run counted 15 (the post-trim delegation attach). |
| **Schema simplification** | `simplifyToolParametersForProfile`: "simplified" profiles drop OPTIONAL params beyond the first 3 — required params + wire format untouched (structural rewrites would break tool handlers; every emitted call still executes). Applied at both `inputSchema` build sites. |
| **0.2 media gate absorbed** | `providerSupportsToolMedia` moved to the profile module (single source of truth); tool-model-output.ts re-exports for existing importers (native-history regate untouched). |
| **Evals/tests** | `capability-trim.eval.test.ts` (3): weak model (`tiny-llm-7b-instruct` on a second fake-server provider) → ≤12 tools with core surface present; strong/default → full surface (>12); simplified schemas on offered tools. + `model-capability-profile.test.ts` unit (21: catalog, hints, locality, trim ranking/order, simplify caps). |
| **Verification** | 37 agent-evals (16 files, +3), `npm test` 1089/1089 (+24), `npm run ts` clean, oxlint 8, boot smoke OK. |

### v12 session 8 — shipped (2026-06-06): 0.4 pragmatic close — single store of record, documented turn buffer

| Area | Notes |
|------|-------|
| **Scope decision (conscious)** | Full physical deletion of the in-memory store was evaluated by a dedicated design pass and REJECTED: the buffer is load-bearing (the whole turn mutates one `Message[]` in place; the renderer renders `chat:response:chunk` snapshots; `get-chat` mid-stream must see in-flight chunks the DB doesn't have). Deleting it would rebuild the same structure under a new name with DB round-trips on hot paths. C2's id unification already made the DB the store of record — C3 closes 0.4 by CONTRACT: delete what's redundant, document what remains. What full deletion would still buy (the <1,500-line handler goal) is recorded as a revisit-with-2.3 candidate. |
| **Last `sessionRowId` gap closed** | `chat:submit-user-question-answer` now persists the Q→A row FIRST and threads its UUID into `insertAskUserAnswerUserMessage` — every persisted message kind carries its row id. |
| **Ordinal fallback DELETED** | `persistEditedSessionMessage` + `computeSessionEditTarget` (+ its unit test) gone; `chat:edit-message` collapses to `persistEditedSessionMessageById` only. A message with no `sessionRowId` was never persisted → the visible "Edit not saved" warning stays (honest failure, no silent divergence). |
| **`stream-transport.ts` rename + contract** | `src/lib/ephemeral-chat.ts` → `src/lib/chat/stream-transport.ts`; exports renamed (`createStreamTransport`/`getStreamTransport`/`getStreamTransportAppId`/`isStreamTransportId`/`deleteStreamTransport`/`hydrateStreamTransport`/`appendTransportMessage`/`setTransportMessageDisplaySnapshot`/`editTransportUserMessage`); header = the turn-buffer contract; the in-memory edit truncation documented as "mirror only — DB tail-delete is authoritative". 21 files renamed mechanically; the `chat:hydrate-ephemeral-messages` channel STRING kept (zero renderer churn). |
| **Dead weight deleted** | `clearEphemeralChatMessages` + `chat:clear-ephemeral-messages` handler + preload entry + `ipc_client.clearEphemeralChatMessages` + the orphaned `deleteMessages` wrapper (a no-op precursor chain — hydrate replaces the buffer wholesale). |
| **`docs/message-store.md`** | The canonical two-layer contract: id spaces, persistence timing table (user at dispatch / assistant at renderer onEnd / abort partial-save / Q→A persist-then-insert / direct-row edits), hydration flow, eval-pinned invariants, conscious deferrals (typed compaction rows, structured task_complete, physical deletion). |
| **Evals** | NEW `stream-transport-contract.eval.test.ts` (2): buffer↔DB lockstep after a turn + row-id invariant; ask_user Q→A row-id gap. `session-edit-boundary` updated (fallback case reframed: "never persisted → warning"). |
| **Verification** | 34 agent-evals (15 files, +2), `npm test` 1065/1065 (−5 deleted ordinal tests, +2), `npm run ts` clean, oxlint 8, knip 0 unused files, boot smoke OK. |

### v12 session 7 — shipped (2026-06-06): 0.4 phases C1 + C2 — structured contracts + single id space

| Area | Notes |
|------|-------|
| **C1: legacy permission TEXT format deleted** | Exploration finding: the `"__PERMISSION_REQUIRED__"` string fallback was NOT vestigial — `run_tests` (shell.ts) still produced it, and the interceptor's legacy parser didn't even recognize its wording ("Run Tests" ≠ "Run Command:"), falling through to a bogus `write_file`/path:"unknown" operation — approving run_tests was broken. `run_tests` now returns the structured `{__permission_required, operation:"run_command", preview}` envelope (approval executes through the normal command path); `parseLegacyPermissionRequest` + both `.includes("__PERMISSION_REQUIRED__")` fallbacks DELETED (−56 ln). The renderer-side legacy chat-only page (`atlarix-chat.tsx` → `lib/providers/*`) keeps its own private string variant that never reaches the interceptor. |
| **C1: marker-contract inventory** | `docs/marker-contracts.md` — canonical producers/parsers/escaping table for the structured tool-result contracts, loop-control text markers (`<task_complete>`, `[COMPACTION MARKER]` — conversion deferred to C3 with the store work), the renderer content-tag family (string contract by design), and the B2 native-history envelope. |
| **C2: `sessionRowId` — one id space without re-keying the renderer** | `Message` gains optional `sessionRowId` (session DB row UUID): set at persist time on streamed user messages (`persistWorkspaceSessionUserMessage`'s returned row), threaded through hydration (`sessionMessagesToUiMessages` keeps the DB id it used to DROP → hydrate payload → ephemeral store). Renderer keeps its numeric id keying — zero atom churn (the riskiest surface untouched). Survives `editEphemeralUserMessage`'s derived-state strip. |
| **C2: ordinal mapping demoted to legacy fallback** | NEW `persistEditedSessionMessageById(rowId, content)`: direct row update + chronological tail delete — the 3.3 window-boundary failure is STRUCTURALLY impossible on this path (eval: an edit ordinal math could never map now persists correctly). `chat:edit-message` prefers the direct path; the ordinal path + its 3.3 warning remain ONLY for pre-C2 messages without `sessionRowId` (deleted with the store in C3). |
| **Also: last two Date.now() id sites** | The handler's `newUserMessage`/`placeholderMessage` ids now use the monotonic counter (exported `nextEphemeralMessageId`), allocated in array order (user < placeholder) so id-order keeps matching display order. |
| **Evals** | `session-edit-boundary.eval.test.ts` rewritten (3): C2 boundary edit persists via direct id; C2 reload round-trip (sessions:get → hydrate with row UUIDs → direct edit); legacy fallback still warns (3.3). |
| **Verification** | 32 agent-evals (14 files), `npm test` 1068/1068, `npm run ts` clean, oxlint 8 (baseline), boot smoke OK. |

### v12 session 6 — shipped (2026-06-06): 0.3 edit-reliability + auto-verify (wires 1.2, re-scopes 2.5)

| Area | Notes |
|------|-------|
| **postWriteVerify seam wired end-to-end** | New `src/lib/agent/post-write-verify.ts` (`buildPostWriteVerify(workspacePath)`): per round, `requestLspDiagnosticsAfterSync` on the round's written files (reuses the existing `filesWrittenInThisExchange` side channel via a new `TurnRuntime.getFilesWrittenThisTurn` closure + a high-water mark — text-tool writes land after a round's verify point and are covered by the NEXT pass), ERRORS-only filter (severity 1; warnings would drown weak models), 10-diags/file + 8-files/round caps, compact `<diagnostics file=>` blocks. Seam signature changed to `Promise<string \| null>` — the ENGINE appends the feedback as a user message (transient round input, NOT mirrored into the B2 envelope — same semantics as loop corrections; eval-pinned). |
| **Premature `<task_complete>` is BLOCKED on broken code** | KEY ordering fix found during implementation: the engine's task-complete break ran BEFORE any verify could — a model writing broken code + `<task_complete>` in one round escaped verification entirely (the exact 0.3/2.5 failure). Verify now computes BEFORE the break gate; outstanding diagnostics suppress the break (max 3 suppressions/turn — a model that keeps claiming done on broken code isn't nagged forever) and the diagnostics feed back instead. A fix round with no new writes (or clean writes) releases the gate. |
| **1.2 RESOLVED — `enableAutoFixProblems` has logic** | The seam is attached to the build profile only when the toggle is on (default on). OFF → no LSP calls, no injection (eval-pinned). Ask never gets the seam (no write tools). |
| **edit_file structured no-match guidance** | On no-match: the closest-candidate REGION (5 lines around the heuristic hit) is included verbatim with explicit "the file likely changed — re-read (start_line/end_line given) and retry with the EXACT current content" guidance + a structured `retry: {reason: "no_match", nearMiss}` field; a no-candidate variant suggests re-read/search. (Heuristic keys on the first 30 chars of old_content — documented in the eval.) |
| **2.5 re-scoped (conscious decision)** | `runAutonomousBuildVerificationAfterTaskComplete` (post-turn reviewer+debugger sub-agents) KEPT as the optional semantic deep review behind `buildVerification.enabled` — its prose-regex issue detection is its surface, not compile detection, so nothing to retire there; compile-level breakage is now caught IN-LOOP before `<task_complete>` by postWriteVerify. Relationship documented at the function. |
| **Evals** | `edit-verify.eval.test.ts` (3): blocked task_complete → `<diagnostics>` block in the next recorded request → finish (LSP layer partial-mocked — spawning real language servers isn't viable in the harness; engine wiring/gate/side-channel all real); toggle-off negative control; no-match guidance flow. + `post-write-verify-format.test.ts` unit (4: errors-only, caps, first-line, clean→null). B2 purity asserted (no `<diagnostics` in the persisted envelope). |
| **Verification** | 30 agent-evals (14 files, +3), `npm test` 1066/1066 (148 files, +7), `npm run ts` clean, oxlint 8 (baseline), boot smoke OK. |

### v12 session 5 — shipped (2026-06-06): quick wins + dead-code purge (1.5, Tier 3, 2.6, 2.7, Tier-4 remainders)

| Area | Notes |
|------|-------|
| **1.5 aux-Compass limit notice** | The post-turn aux usage record (sub-agents + compaction) is now AWAITED (was fire-and-forget) and a `limit_exceeded` result emits a visible `chat:activity` error notice ("Monthly Atlarix Core token limit reached") before `chat:response:end` — the next turn's pre-flight hard-block no longer surprises the user. Transient RPC failures never block the turn end. (No eval: the harness's custom provider bypasses Compass metering by design — documented limitation.) |
| **3.4 context-overflow detection** | `isContextOverflowError` now checks STRUCTURED provider error codes first (`data.error.code/type`, recursing into `cause` for RetryError/APICallError wrapping; `context_length_exceeded` et al) and scans `responseBody` in the regex fallback. 4 new unit cases in `compaction_hardening.test.ts`. |
| **3.1 collision-free ids** | Ephemeral message ids: `Date.now()` → monotonic counter seeded from the clock (`nextEphemeralMessageId`; stays NUMERIC — renderer atoms key by numeric id, so no UUIDs here). `questionId` → `crypto.randomUUID()`. Unit: 50 same-ms inserts → unique + strictly increasing. |
| **3.8 + 3.3 edit-integrity (interim — 0.4 deletes both seams)** | `editEphemeralUserMessage` strips stale `displaySnapshot`/`modelContent` from the rewritten message (3.8). `persistEditedSessionMessage` returns `"updated" \| "no_session" \| "unmapped"`; the `chat:edit-message` handler surfaces `"unmapped"` (window-boundary ordinal miss) as a visible warning activity + `persistedToSession:false` instead of silently diverging (3.3). Eval: `session-edit-boundary.eval.test.ts` forces an unmappable ordinal and asserts warning + DB untouched. |
| **3.2 / 3.6 / 3.7** | workspace-analyzer's 8 probe catches log non-ENOENT failures (`logProbeFailure` — malformed package.json no longer silently skips detection). `runCommandGateResult` fail-closed on invalid `workMode` (zod safeParse gate). NEW `src/lib/pending-work.ts` (`trackPendingWork`/`drainPendingWork`): self-correction dispatch, build-complete snapshot, and post-turn build-verify are tracked and drained (5s bound) in main.ts's before-quit pipeline. |
| **3.9 / 3.5 resolved as documentation** | Tool `cost` IS read (getToolStats reporting) — commented informational-only, becomes a 2.1 trim input. Browser `executeJavaScript` trust boundary documented at the template site (JSON.stringify escaping is the invariant; restricted DOM API stays the long-term direction). |
| **2.6 dead knobs DELETED** | Schema + UI + defaults for: `experiments` (deprecated, zero reads), `aiConfiguration.agentLightning` (12-LOC stub; `src/lib/agents/agent-lightning.ts` deleted), `aiConfiguration.projectUnderstanding` (zero logic reads), `activityStream.detailLevel` (unused), the `counsel` settings group + its Settings-page section (the toggle had NO runner behind it — pure lying knob). KEPT (enforced, verified): `delegation`, `selfReview`, `contextSummarization`; `autonomous` stays as documented settings-JSON compat. Old persisted rows parse (z.object strips unknown keys). |
| **2.7 purge: counsel scaffold (−~150 ln)** | The dead end-to-end counsel plumbing deleted: ipc_client methods + 4 preload channels + ipc_types payloads, activity types/labels in chat-activity-normalize + sourceAtoms + chatAtoms (`counselPhaseActive`), the `kind:"counsel"` stream-thread variant (`isRunningBackgroundOrCounsel`→`isRunningBackground`), InlineStreamStatus/AssistantMessageBody display arms, ContextAssembler section names + pruning arm. KEPT: `counsel_sessions` DB migration history (chain integrity). `suppressNativeThinkingForDeepCounsel` renamed → `...ForForcedTier` (it was about forced thinking tier, not counsel). |
| **2.7 purge: blueprint codegen + dead types/files** | `blueprint:generate-combined` + `blueprint:codegen` IPC handlers, their ipc_client methods + preload channels, `src/lib/blueprint/codegen.ts` + `combined-generator.ts` (238 ln), and the orphaned `CombinedBlueprint`/`ProjectBlueprint`/`CrossProjectEdge`/`BlueprintNodeSummary`/`ProjectMarker` type cluster DELETED (zero UI callers, never reached from the loop). Also: knip's 2 unused files (`compass-plan-access.ts`, `problem_prompt.ts`). knip now reports 0 unused files. |
| **Tier-4 remainder: `ts:tests`** | Broken `ts:workers` script (pointed at the removed v9.1 TSC worker tsconfig) replaced by `ts:tests` (`tsconfig.tests.json`: `tests/` + `testing/` + the src ambient d.ts files) — the eval/infra/fake-server code is now typechecked by `npm run ts`. Fixed 2 latent type errors it caught (variadic `messages:add` casts in evals). DROPPED consciously: physically moving `src/__tests__` (churn, collides with upcoming session test additions). |
| **Verification** | 27 agent-evals (13 files, +1), `npm test` 1059/1059 (146 files, +8), `npm run ts` (main+tests) clean, oxlint 8 errors (baseline), knip 0 unused files, boot smoke OK (0 errors). |

### v12 session 4 — shipped (2026-06-06): 0.1 close-out — flag flipped + deleted, legacy bodies deleted, correction reinject, plan-tool fix

| Area | Notes |
|------|-------|
| **Legacy loop bodies + flag DELETED (−680 lines)** | After a last full-matrix parity run in both flag states (the soak), the legacy ask `while(true)` (~200 ln) and build `for(;;)` (~430 ln) bodies, the `enableUnifiedAgentLoop` flag (schemas + both check sites + `ATLARIX_UNIFIED_LOOP` env), and the now-dead handler state (`agenticProseOnlyStreak`, `agenticMessages`, `allToolResults`, `streamContinuationAttempts`, `askAgenticIteration`, `askTierStreamLoopStartMs`, the `buildSystemPromptWithManifest` outer `let`, ~10 orphaned imports) were deleted. The engine calls keep bare `{}` block scopes (indentation untouched, `turnResult` stays scoped). Old persisted settings rows carrying the flag parse fine (plain `z.object` strips unknown keys). `chat_stream_handlers.ts`: 7,507 → **6,891 lines** (<1,500 target still needs 0.4's state extraction). KEPT (shared, verified): `execBuildTextToolCalls`, `handleAgenticRepetitionOutcome` / `handleAskAgenticRepetitionOutcome` (called from the surviving tool wrappers), the shared post-loop epilogue + catch/finally. |
| **Mid-round correction reinject (`prepareStep`)** | Repetition corrections are queued by tool wrappers INSIDE the SDK's multi-step inner loop, where the round-boundary injection can't reach until the round ends — which a runaway model never lets happen (so corrections previously NEVER reached the model; only the 3rd-strike abort did). `simpleStreamText` gains an optional `repetition` param; when present, a `prepareStep` hook takes the pending correction at the next step boundary and appends it as a user message to THAT step's input. Verified against `ai@5` source: step input is rebuilt per step (`initialPrompt.messages + responseMessages`) and `response.messages` accumulates only step OUTPUTS — the injected message is a **transient one-step nudge**, never persisted to history, so B1/B2 native-history slice math and byte-stability hold (eval-asserted). `takePendingCorrection()` is take-once → the engine's round-boundary injection stays as the non-duplicating text-tool-path fallback; `loop_abort` sets `loopBreakPending` only (never `pendingCorrection`) → no spurious inject before the hard abort. Eval: `correction-reinject.eval.test.ts` (build + ask): correction text appears in a recorded mid-round request; 3rd strike still aborts; envelope purity. |
| **Plan-tool defect FIXED** | In ask+plan, the toolset assembly now unions `write_implementation_plan` + `update_plan_status` + `update_plan_step` into `askModeTools` (they're `isReadOnly:false` + `allowInAskMode:false`, so `getToolsForAskMode()` drops them; `includeToolForSession`'s mode filter keeps them plan-only; the execute-time gate already passed). Found-by-eval bonus fix: the wrapper's dedicated `write_implementation_plan` artifact handling parsed `planId` at the top level, but `runToolExecute` wraps results in the ToolRegistry `{success, result, cost}` envelope — it was dead code that never fired; now unwraps the envelope ("Plan saved" activity + artifact marker work). Evals: surface eval flipped to assert the three ARE offered (write/run tools still excluded); NEW full-flow eval (tool call → "Plan saved" activity + `atlarix-plan-artifact` marker in the persisted reply). |
| **`isTaskComplete` deduped** | The `<task_complete>` text-marker check is now ONE canonical export: `responseHasTaskCompleteTag` in `src/lib/tasks/completion-detector.ts` (named to not shadow the ledger `isTaskComplete` in the same file); engine + handler import it (`as isTaskComplete`), both local twins deleted. |
| **Eval matrix collapsed to one leg** | The flag-state conditional in `ask-parity` (B2 envelope ON / prose OFF) is now unconditional engine expectations; stale "parity baseline" doc-blocks updated. The suite runs once — no env needed. Zero `ATLARIX_UNIFIED_LOOP` / `enableUnifiedAgentLoop` references left in `src`/`tests`/`testing`. |
| **Known delta (deferred, conscious)** | Truncation-continuation rounds (the inner "length" finish-reason retry loop) skip mid-loop compaction/escalation — legacy ask had it, build never did. Restore as an engine feature when 0.4's state extraction makes it clean, if real-world truncation loops ever surface. |
| **Verification** | 26 agent-evals green (24 pre-existing+plan-surface-flip + 2 new reinject; flow eval makes it +3 total this session), `npm test` 1051/1051 (144 files), ts:main clean, **oxlint 8 errors (one BELOW the 9 pre-existing** — the deletion removed a pre-existing unused import), boot smoke OK (clean launch, 0 errors). Gate sequence: baseline matrix → plan fix (ON+OFF) → reinject (ON+OFF) → flag flip (default-engine + `=0` legacy = the LAST off-leg run) → delete → engine-only suite + boot smoke. |

### v12 session 3 — shipped (2026-06-06): 0.1 — unified engine, build+ask migrated behind the flag, agent path deleted

| Area | Notes |
|------|-------|
| **Engine extracted (`src/lib/agent/run-agent-turn.ts` + `agent-profile.ts`)** | Faithful CONTROL-FLOW port of the build `for(;;)` loop, parameterized by `AgentProfile` (data flags: `honorTaskCompleteBreak`, `proseOnlyStreakMax` — `undefined` = ask's "prose ends the turn", `escalationMode`, labels; capabilities: `tools`, `repetition`, `buildRoundSystemPrompt`, text-tool fallback trio, **`postWriteVerify?` seam left unset for 0.3/1.2**). State stays in `runStream` — the engine receives handler closures via a `TurnRuntime` param (full state extraction is 0.4). Cycle-free (no handler import). No separate `process-step.ts` — the break decisions live inline until they earn extraction. |
| **BUILD migrated behind a flag** | `enableUnifiedAgentLoop` (schemas.ts) + `ATLARIX_UNIFIED_LOOP=1` env override, **default OFF**. The text-tool execution block was extracted into handler-local `execBuildTextToolCalls` shared by BOTH branches; legacy loop byte-for-byte unchanged behind the `else`; shared post-loop epilogue stays common. Engine reproduced the legacy loop on first run — full eval matrix green flag ON and OFF, incl. the 4 native-history byte-stability canaries. |
| **Vestigial agent path DELETED (+289 lines)** | `selectedChatMode === "agent"` block removed (incl. inline compress_context, generate-code meta-tool, static "OK." continuation). Killed by deletion: **double-dispatch every turn**, **no workspace injection**, no permission/repetition/delegation wiring (the session-1 harness findings). Coercion: `readSettings` rewrites persisted `"agent"` → `"build"` (compass-alias pattern); custom-command `modeOverride: "agent"` coerces at the accept set; dead `=== "agent"` arms simplified; `"agent"` stays in `ChatModeSchema` so old rows parse (coercion comment). Renderer/work-mode coercion arms kept as defense-in-depth. |
| **Ask parity baselines (Phase A)** | `tests/agent-evals/ask-parity.eval.test.ts` (5): read-only flow + toolset surface (write tools NOT offered, ask_user IS), plan-workMode surface (**pins a real defect: `write_implementation_plan` is never offered** — `getToolsForAskMode` excludes it though the ask wrapper has dedicated handling at ~L4205; fix = profile-level plan-tool inclusion during the ask migration), repetition abort, ask_user end-turn, round-trip persist. Pinned against the OLD ask loop pre-migration. |
| **Coercion eval (Phase D)** | `tests/agent-evals/agent-mode-coercion.eval.test.ts`: `mode:"agent"` turn → exactly 2 requests (single dispatch), workspace injection works, build toolset surface, `<task_complete>` honored. |
| **(Phase E) ASK migrated onto the engine** | Key insight: the legacy ask outer `while(true)` was purely a TRUNCATION-CONTINUATION loop — a completed round ends the turn, tools or not (the SDK inner loop does the multi-step tool work). Profile: `singleRound: true` (engine breaks after the first completed round, captures the round's natives for B2, checks the repetition loop-break, skips iteration-progress events), `honorTaskCompleteBreak:false`, no text-tool callbacks, `sanitizeTextDelta` identity (ask streams deltas unstripped), async `buildRoundSystemPrompt` returning `{systemPromptOverride, dynamicSystemTail}` (stable header + dynamic tail stay separate system blocks for the prompt cache). **Ask GAINS 0.2's between-turns native history via the engine** (the shared tail persists `nativeTurnMessages`; legacy ask never populated it) — pinned by a flag-state-aware `ask native history` eval (envelope ON / prose OFF). Known deltas when ON (documented at the gate): truncation-continuation rounds skip mid-loop compaction/escalation/correction-injection (rare path). |
| **Harness fix: scenario routing was first-match** | `findScenarioId` scanned messages in order, so multi-turn evals routed turn N to turn 1's EXHAUSTED scenario (build multi-turn evals only survived because the dynamic system tail happened to leak the live `sc=` id at `messages[0]`). Now scans in REVERSE — the live prompt (last user message) wins, deterministically. |
| **Verification** | 23 agent-evals green flag ON+OFF, `npm test` 1048/1048, ts:main clean, oxlint at the 9 pre-existing errors, boot smoke OK (×2: post-D and post-E). |

~~**Still open in 0.1 (next session):**~~ → **ALL CLOSED in session 4** (flag flip + deletion, correction reinject, plan-tool fix, `isTaskComplete` dedupe; truncation-round compaction/escalation consciously deferred — see the session-4 table). Post-deletion size: 6,891 lines (the earlier ~3,500–4,500 estimate over-counted the legacy bodies' share); the <1,500 target needs 0.4's state extraction.

### v12 session 2 — shipped (2026-06-05): 0.2 native tool history

| Area | Notes |
|------|-------|
| **(A) Typed tool outputs + screenshot fix (1.3 DONE)** | `src/lib/ai/tool-model-output.ts`: `toModelOutput` wired into all 3 ToolSet sites; `browser_screenshot` returns its structured result → `{type:'content', value:[text, media]}` on vision providers (anthropic/openai/google allowlist; 2.1 capability profiles will own this), text fallback elsewhere; base64 redacted from activity cards (`redactToolMediaForDisplay`); `browser_screenshot` added to `NEVER_TRUNCATE` (disk truncation was corrupting the base64 — the tool was doubly broken). |
| **(B1) In-turn native history** | The build loop's per-iteration reflatten (stripped-prose assistant push + synthetic XML user msg) replaced for the NATIVE path: each round's `response.messages` (assistant tool_use + `role:"tool"` results) folds into `agenticMessages` + a STATIC continuation user message — history is byte-stable across rounds (prompt cache holds) and weak models see real tool blocks. Text-tool fallback path byte-identical (negative-control eval). NEW truthful signal `hasNativeToolParts(respMsgs)` — the old `hadNativeToolExecution` (permission-op count) MISSES read-only native calls, which also mis-fired the prose-only nudge. |
| **(B2) Between-turns native history** | Turn's native messages persist as a versioned envelope (`src/lib/ai/native-history.ts`, `{v:1, kind:"native-history", messages, producedBy}`) on the assistant message's `modelContent` (ephemeral + `chat:response:end.assistantModelContent` → renderer `messages:add` extras). Next-turn assembly expands the envelope into native ModelMessages at the ModelMessage build (slicing/truncation stays string-based on the single slot); `regateNativeMediaForProvider` strips media on provider shift. Old sessions (no envelope) fall back to the string path. |
| **Compaction/token interaction (known limitation)** | String-based compaction can't count/summarize native-part messages: `estimateModelMessageTokens` handles array content + flat ~1.6k/image estimate (tier escalation no longer counts native messages as 0); `flattenNativeForCompaction` degrades native→prose ONLY as compaction's input — when compaction fires, the compacted view wins (lossy by design). Lossless native compaction → 0.1/0.4. |
| **Evals** | `tests/agent-evals/native-history.eval.test.ts` (4): B1 multi-round native fold, B2 2-turn cross-turn native replay + byte-stability assertion, B2 full reload (session persist → rehydrate → native replay), text-tool negative control. + `tool-model-output.test.ts` unit (7). All 16 evals + 1,041 tests green; boot smoke OK. |

**Out of scope / deferred from 0.2:** ask/agent-path native HISTORY (they got the `toModelOutput` plumbing only — 0.1 unifies); lossless native compaction; `read_attachment` media parts; `ATLARIX_FORCE_TEXT_TOOLS=1` note: custom providers default to native (no text fallback) since `builtinProviderId` is undefined.

### v12 session 1 — shipped (2026-06-05)

| Area | Notes |
|------|-------|
| **Agent-eval harness (Tier 4)** | `tests/agent-evals/` (own vitest project, `fileParallelism:false`, Node-ABI better-sqlite3 via `tests/infra/package.json` alias) drives the REAL `chat:stream` handler: real temp-dir sqlite w/ embedded migrations + real temp workspace + in-process fake-llm-server on an ephemeral port (custom-provider DB row routes `getModelClient`); fake `IpcMainInvokeEvent` records every `safeSend` as the assertion surface. 7 evals: probe, SDK-protocol canary, single-tool flow, edit-with-approval (approve+reject via real `execute-permission`), loop-detection→abort, ephemeral→session round-trip, session-delete cleanup; + cache-breakpoint unit eval. |
| **Fake-server scenario loader** | `testing/fake-llm-server/scenario.ts`: `sc=<id>` multi-turn scripts (text / native tool_call / fixture / error / repeatLast), per-scenario step counter + raw request recording; HTTP routes `POST /scenario`, `GET /scenario/:id/requests`; `createApp()` factory (`app.ts`/`chunks.ts` split so in-process import doesn't bind :3500). All `tc=`/`[429]`/`[dump]` e2e behavior untouched. |
| **tests/infra fixtures** | `workspace` / `db` (real migrations in temp userData) / `ipc` (recording sender + `waitFor`) / `settings` / `scenario` builder / `assert` helpers / `turn.ts` (full-turn driver); setup file partial-mocks `@/paths/paths` userData + supabase `getSession`, mirrors main.ts's NoOutputGenerated rejection swallow. |
| **BUG FIXED: loop guard couldn't abort (found by eval 3)** | The repetition guard's `consumeLoopBreak()` only ran at outer-round boundaries — unreachable while the AI-SDK multi-step loop (`stopWhen` never true) keeps stepping, so a runaway model looped unbounded (the 30-min cap is also round-boundary). `loop_abort` now aborts the in-flight stream (`LOOP_REPETITION_STREAM_STOP`, ask + build handlers) with a partial-save stop note. |
| **1.1 compaction dedupe** | `src/lib/context-compaction.ts` DELETED; still-used exports (`isContextOverflowError`, `getUsableBudget`→alias of `getTierContextLimitSync`, `summarizeMessagesWithCompactionPrompt`, `runCompaction`+`CompactionRunOutcome`) folded into `context/compaction.ts` on its exact-token internals; dead always-null `getContextSummary` pre-load in the stream handler removed. |
| **1.4 fuzzy-edit drift signal** | `edit_file` fuzzy matches now return “Applied with indent/EOL tolerance at line N …” in the permission preview `notice` (new schema field) + card description; interceptor forwards it as the executed result `output` so the MODEL sees it. Unit test `edit-fuzzy-drift.test.ts`. |
| **2.4 memory-leak cleanup** | `sessions:delete` now prunes the ephemeral chat (`deleteEphemeralChat`) + main stream maps (`clearChatStreamStateForChat`: activeStreams/partialResponses/lastStreamRequest/askUser/toolLoaders) and returns `streamChatId`; renderer clears per-chat jotai atoms (`src/lib/chat/clear-chat-atoms.ts`, incl. per-message snapshot records) + activity rows on delete. Pinned by `session-delete-cleanup` eval. |
| **Anthropic cache breakpoints extracted** | `chat_stream_handlers` inline block → pure `src/lib/ai/anthropic-cache-breakpoints.ts` (`buildStreamMessagesWithCacheBreakpoints`), unit-tested (eval 6 — message-shape can't go through the OpenAI-protocol fake server). Down-payment on 0.2. |
| **DELETE pass** | Removed: `problem_prompt.test.ts` (+snapshot), `app-version`, `compass-plan-access`, `group-handoff-digest`, `format-url` tests. KEEP-list untouched. |

**NEW agent-path findings (harness output — fold into 0.1):**
- **Agent mode double-dispatches every turn:** `selectedChatMode === "agent"` runs the agent loop (L3874) AND then falls into the build `else` branch (the ask check at L4155 doesn't exclude it) — a second full model dispatch per turn.
- **Agent path injects no `workspace` into tool args** (its execute wrapper passes only `_chatSessionId`/`workspaceSessionId`), so file tools resolve against `cwd` — ask (L4389) and build (L5156…) inject `workspace: appPath` correctly. Evals therefore pin **build mode**; add agent-mode parity evals during 0.1.
- **Loop-guard corrections never reach the model** mid-round for the same stopWhen reason (only the abort is fixed); correction injection needs the 0.1 round redesign.

**Deferred Tier 4 follow-ups:** physically move `src/__tests__` into `tests/{unit,renderer}`; broader trivial-test audit; add `tests/` + `testing/` to a tsc project (currently unchecked by `npm run ts`); fix the stale `ts:workers` script (`workers/tsc/tsconfig.json` was removed with the v9.1 TSC worker); 9 pre-existing oxlint errors (win-ci-lib, fetch-ctags, unused imports); image-part assertions blocked on 0.2.

### Verification notes (audit corrections — read FIRST, don't chase phantoms)
- **Ask-tier is NOT missing compaction/repetition guards.** Confirmed: `runMidLoopCompaction` fires in the agent (L4119), ask (L4880), and agentic (L6257) loops; `askAgenticRepetition` exists (L4175). Any audit note claiming ask-tier lacks these is **wrong**.
- **The edit tool already has fuzzy matching.** `src/lib/tools/edit.ts` `fuzzyFindString` tolerates indent/EOL (L44–122). ~~The real defect is it's **silent**~~ → **FIXED in session 1** (drift notice in tool result + card; see 1.4).
- **`enableAutoFixProblems` is NOT fully dead** (session-1 correction): `AutoFixProblemsSwitch.tsx` reads/writes it — the UI toggle works. What's missing is any LOGIC behind it (nothing in the loop / edit.ts / file.ts reads it). Still a lying knob until 0.3 wires post-edit LSP verify to it.
- **No post-edit diagnostics feedback exists** — no `lsp_diagnostics` / `diagnose` call after a write. Verified.
- ~~**Dual compaction files both live**~~ → **FIXED in session 1** (root file deleted, exports folded into `context/compaction.ts`).
- Loop structure (UPDATED session 4): the "4 divergent paths" collapsed to **ONE engine** — the agent path was vestigial (deleted session 3); the legacy ask + build loop bodies and the migration flag were deleted session 4. `runAgentTurn` (ask profile / build profile) is the only loop; chat-only is an early boundary rejection, not a loop.

---

### TIER 0 — The four foundations (everything else is downstream; order = dependency order)

#### 0.1 Unify the agent loop (the #1 liability) — ✅ DONE (session 3: engine + migrations; session 4: close-out — legacy bodies + flag deleted, engine is the ONLY path, correction reinject, plan-tool fix)
- **Problem:** `chat_stream_handlers.ts` (7,428 lines) re-implements the agent turn per mode. Every cross-cutting feature is wired N times (ask_user had 4 interception sites; mid-loop compaction in 3 places; the `AI_NoOutputGeneratedError` ask_user bug existed *because* abort semantics differ per branch). New features ship with path-specific bugs; fixes are whack-a-mole.
- **Target (steal from opencode):** ONE `runAgentTurn()` engine parameterized by an `AgentProfile` (mode, permission ruleset, model override, max steps, toolset). Non-recursive `while` loop with a step counter; a `processStep()` returning `"continue" | "stop" | "compact"`; break = `lastAssistant.finished && no pending tool calls && lastUser before lastAssistant`; abort handled in ONE place. Ref: `opencode/packages/opencode/src/session/prompt.ts:1252-1513` (runLoop), `.../processor.ts:958-1029`.
- **De-risked approach (NOT big-bang):** (1) extract the shared turn into `src/lib/agent/run-agent-turn.ts` seeded from the build loop; (2) migrate ask → build → agent → chat-only one at a time behind a feature flag, with the Tier 4 eval harness asserting parity at each step; (3) delete each old branch only after its evals pass.
- **Files:** new `src/lib/agent/run-agent-turn.ts`, `agent-profile.ts`, `process-step.ts`; shrink `chat_stream_handlers.ts` to a thin IPC adapter (target <1,500 lines).
- **Risk:** highest in the repo. Gated entirely on Tier 4 existing first.

#### 0.2 Native tool-call history + multimodal tool results — ✅ SHIPPED session 2 (build mode; ask/agent via 0.1)
- **Problem:** tool calls/results are flattened to synthetic text (`"Here are the results of the tools you called…"`, `chat_stream_handlers.ts` ~L6300) via `stripToolCallXML` / `stripAssistantDisplayContent`. Consequences: (a) weak/local models perform worse — providers train tool behavior on native `tool_use`/`tool_result` blocks; (b) prompt caching breaks in multi-step loops for everyone but the Anthropic BYOK header — each step rebuilds a string-mutated history, re-billing full input (burns the Core token pool); (c) **`browser_screenshot` returns base64 as TEXT** — the model literally cannot see the screenshot we shipped.
- **Target:** carry native AI-SDK `tool_use`/`tool_result` parts through the loop; tool results can return image/file content blocks (AI SDK v5 supports this); a provider-shaping layer maps to each provider's API. Ref: opencode `message-v2.ts` `toModelMessages`, tool `toModelOutput`.
- **Files:** history-assembly in `chat_stream_handlers.ts` (~L2106 dispatch map, ~L6294 resent history), `src/lib/tools/browser.ts` (screenshot → image part), tool-result envelope in `registry.ts`.
- **Dependency:** easier after 0.1 (one assembly path, not four).

#### 0.3 Edit-reliability + auto-verify layer (what makes Cursor feel magic) — ✅ DONE (session 6: postWriteVerify wired, task_complete gated on diagnostics, 1.2 resolved, structured no-match guidance, 2.5 re-scoped)
- **Problem:** the edit tool has fuzzy matching but it's silent; on no-match it just errors. There is **no post-edit verification loop** — `enableAutoFixProblems` is dead, no `tsc`/LSP diagnostics fed back after a write. For a "bring any AI" product this is fatal: cheap models *feel* broken in Atlarix and fine in Cursor — same model, different apply layer.
- **Target:** (a) surface fuzzy-match drift to the model ("applied with whitespace tolerance at line N" so it can self-correct); (b) **wire `enableAutoFixProblems`** — after a write in build/debug, run LSP diagnostics on the touched file and feed errors back into the loop as a tool result (model fixes before claiming done); (c) make "edit → run/typecheck → observe → fix" the loop's default posture, not a bolt-on. Ref: Claude Code Edit exact-match + structured retry guidance; opencode LSP-after-edit.
- **Files:** `src/lib/tools/edit.ts` (drift signal), new `src/lib/agent/post-edit-verify.ts`, wire into 0.1, reuse `src/lib/lsp/lsp-client.ts`.

#### 0.4 Single message store + structured tool contracts — ✅ DONE (sessions 7+8, pragmatic close): one id space (`sessionRowId` everywhere), ordinal mapping DELETED, structured permission contract, `stream-transport.ts` turn-buffer contract documented (docs/message-store.md). Deferred consciously: typed compaction rows, structured task_complete, physical buffer deletion (revisit with 2.3).
- **Problem:** dual store — ephemeral negative-numeric-id (in-memory) + session UUID DB — synced by convention (`computeSessionEditTarget` edit-by-ordinal, ids regenerate on rehydrate, summary persistence had to dodge ids). Every seam is a future "lost/duplicated/wrong-resume message" report. Plus string-marker contracts (`__ask_user`, `__permission_required`, `<task_complete>`, `[COMPACTION MARKER]`, `atlarix-*` content tags) — we already fixed one marker-escaping bug; the whole class is fragile.
- **Target:** one store, one id space (opencode: Drizzle MessageTable + PartTable, load once per turn, no mid-stream DB writes); replace string markers with a structured stream-event/part type. Ref: opencode `message-v2.ts`, `processor.ts` part model.
- **Files:** `src/lib/ephemeral-chat.ts`, `src/ipc/handlers/workspace_session_handlers.ts`, `src/db/schema.ts`, marker producers/parsers across the stream handler.

---

### TIER 1 — Critical correctness bugs (fix regardless of Tier 0)

| # | Issue | Evidence | Fix direction |
|---|-------|----------|---------------|
| 1.1 | ✅ **DONE (session 1)** — dual compaction implementations | root file deleted; exports folded into `context/compaction.ts` | — |
| 1.2 | ✅ **DONE (session 6)** — `enableAutoFixProblems` wired | gates the postWriteVerify seam (in-loop LSP verify) | — |
| 1.3 | ✅ **DONE (session 2)** — browser screenshot invisible to the model | media content part via `toModelOutput` on vision providers; text fallback elsewhere; also fixed disk-truncation corrupting the base64 | — |
| 1.4 | ✅ **DONE (session 1)** — silent fuzzy edits | drift notice in tool result (`preview.notice` → exec `output`) + card description, with matched line number | — |
| 1.5 | ✅ **DONE (session 5)** — aux Compass usage recorded fire-and-forget | awaited + visible `chat:activity` notice on `limit_exceeded` | — |
| 1.6 | ✅ **DONE (session 9)** — ask-tier 31-tools-for-everyone | per-model capability trim + simplified schemas (2.1) | — |

---

### TIER 2 — High-value gaps (reliability & "any AI" support)

- ✅ **2.1 Model-capability adaptation — DONE (session 9).** `src/lib/routing/model-capability-profile.ts`: tool-count cap + schema simplification + tool-media flag per model, catalog-first with a conservative heuristic fallback (default = full surface; only confidently-weak models trim). Delegation surface excluded on trimmed profiles. Future extensions if needed: output-format strictness, models.dev-backed catalog refresh. |
- ✅ **2.2 Permission model → structured rulesets — DONE (session 10).** Portable `.atlarix/permissions.json` allow/deny/ask glob ruleset + blocking file-based `.atlarix/hooks/` (PreToolUse/PostToolUse/Stop), both at the single `runToolExecute` funnel (also CLOSED the native-tool gate-coverage gap). The legacy scattered gates still apply on top (defense in depth); fully retiring them into deny-rules is a future cleanup. Follow-ups: `ask`-rule prompting for read-only tools; global `~/.atlarix/` ruleset layer; retire the DB `atlarixHooks` table via a release note. |
- ✅ **2.3 Background / parallel agents — V2 DONE (sessions 13+15).** V1 (s13): read-only detached turns. V2 (s15): write-capable (in-process auto-approve + shadow-git approval gate keep/revert), restart-persistent status (kind/status migration + hydration), per-agent cancel, an Agents RightPanel tab. `docs/background-agents.md`. Still deferred (documented): concurrent-write isolation policy (worktree-per-agent), revert-after-restart, auto-surfacing the tab.
- ✅ **2.4 Memory-leak cleanups — DONE (session 1).** `sessions:delete` prunes ephemeral chat + main stream maps and returns `streamChatId`; renderer `clearChatAtomsForChat` clears per-chat/per-message jotai state + activity rows. Pinned by the `session-delete-cleanup` eval.
- ✅ **2.5 Verification culture — RESOLVED via 0.3 (session 6).** The loop no longer blindly trusts `<task_complete>` — in-loop LSP verify gates it (bounded). The post-turn reviewer+debugger pass KEPT as the optional semantic deep review (`buildVerification.enabled`). Still-open extensions (run the touched test, hit the dev-server route) are future engine features — a Stop-hook candidate for 2.2/7B.
- ✅ **2.6 Settings that do nothing — DONE (session 5).** Classified + resolved: ENFORCED kept (`delegation`, `selfReview`, `contextSummarization`); DELETED schema+UI (`experiments`, `agentLightning`, `projectUnderstanding`, `counsel`, `activityStream.detailLevel`); `autonomous` documented as settings-JSON compat only. `enableAutoFixProblems` (1.2) resolves in 0.3.
- ✅ **2.7 Dead-code purge — DONE (session 5)** (counsel scaffold end-to-end, blueprint codegen + handlers + types, agent-lightning stub, 2 knip-flagged dead files; delegation KEPT — reachable from ask/review). The feature-breadth FREEZE stays standing policy until Tier 0 completes.

---

### TIER 3 — Medium correctness & polish (batchable)

- ✅ **3.1–3.9 DONE (session 5)** — see the session-5 table. Notes: 3.1 ephemeral ids use a monotonic NUMERIC counter (renderer atoms key by numeric id — not UUID); 3.3/3.8 are interim seam patches that 0.4 deletes structurally; 3.9 resolved as informational (cost becomes a 2.1 trim input); 3.5 resolved as a documented trust boundary (restricted DOM API stays the long-term direction).
- **3.10** Consolidate tool-availability logic split across `ToolManifest.ts` / `mode-tool-registry.ts` / `registry.ts` into one resolution pipeline. (Open — natural home: 2.1's capability-profile work, session D.)

---

### TIER 4 — Test-suite overhaul — **CORE SHIPPED in session 1** (see "v12 session 1" above)

The agent-eval harness, scenario loader, `tests/infra` fixtures, all 6 target evals (+probe/canary/cleanup) and the small DELETE pass landed. ✅ Typecheck coverage for `tests/`+`testing/` shipped session 5 (`ts:tests` replaces the broken `ts:workers`). Remaining: broader trivial-test audit, fast-check property tests; the physical `src/__tests__` move was consciously DROPPED (churn, collides with ongoing per-session test additions).

Original register (for reference): ~1,025 tests / 134 files — heavy on string-formatter & config-flag assertions, **near-zero coverage of what an AI IDE must guarantee** (agent loops, abort/resume, permission interception, ephemeral↔session round-trips, provider message shaping, edit match/failure). The 56 `chat_stream_handlers.test.ts` tests assert file-op + tag-parsing mechanics, not loop behavior.

**Target architecture**
```
tests/
  unit/          pure utils (property-based via fast-check), handlers w/ mocked providers
  agent-evals/   ← THE KEY ADDITION: scenario DSL (JSON) → fake-llm-server → assert tool sequence + final FS/DB/permission state
  renderer/      semi-integrated: IPC events → full chat thread render → tool-card interaction
  e2e/smoke/     keep existing playwright smoke
  infra/         shared mock fixtures (fs/db/ipc/providers); extend testing/fake-llm-server with a scenario loader
```
- **KEEP:** `chat_stream_handlers.test.ts` (file-op contracts), `agentic-loop-repetition.test.ts`, `stream-thread.test.ts`, `compaction_hardening.test.ts`, `ask-user-artifacts.test.ts`, the renderer harness, e2e smoke, `mode_system_consistency.test.ts`.
- **DELETE:** snapshot-based prompt tests (`problem_prompt.test.ts`), trivial string-formatter happy-paths, config-flag mapping tests (replace with Zod + types).
- **BUILD (highest ROI):** the **agent-eval harness**. `testing/fake-llm-server` already streams scripted tool calls (`tc=` fixtures) — extend it with a multi-turn scenario loader, then write evals: single-tool flow, multi-turn edit-with-approval, loop-detection→abort, MCP auth-fail→retry, ephemeral→session persistence round-trip, provider message-shape (Anthropic `cache_control` / image parts). **These evals are what make the 0.1 loop-unification safe** — they assert behavioral parity as each mode migrates.
- **Shared fixtures:** consolidate the duplicated fs/db/ipc/ephemeral mocks into `tests/infra/`.

---

### Recommended sequencing
1. ✅ ~~**Tier 4 eval harness FIRST**~~ — shipped session 1.
2. ✅ ~~**Quick wins**: 1.1, 1.4, 2.4~~ — shipped session 1. Still open from the batch: 1.2/0.3 (wire autofix), 3.x.
3. ✅ ~~**0.2 native tool history**~~ — shipped session 2 (build mode; ask/agent native history deferred to 0.1).
4. ✅ ~~**0.1 loop unification**~~ — sessions 3+4 (engine, migrations, close-out: legacy bodies + flag deleted, correction reinject, plan-tool fix).
5. **0.4 single store** + structured contracts. ← **next**
6. **2.x** capability profiles, permissions/hooks, then **2.3 background agents** as the differentiator.

---

### TIER 5 — Identity (what Atlarix IS — read before adding "features")

Atlarix is a **workspace for AIs**: lean, local, free/cheap, usable *beside* Cursor/Claude Code/Codex or standalone, and built on the thesis that **even small models perform well when retrieval is surgical and correct, not flooded**. It is **NOT trying to be an IDE.** Guardrails so future work doesn't drift into a Cursor clone:

- **Do NOT add embeddings auto-RAG / auto-context-injection.** Naive top-k flooding hurts small models and contradicts the thesis. Retrieval is model-driven and sectional (Blueprint + `search` + `read_file`) — same school as Claude Code/opencode, which also don't use embeddings. (See the research paper: Zenodo 10.5281/zenodo.20381860 — "Section-Scoped Structural Graph Retrieval". Its result: Blueprint *increases* thoroughness/tokens because the model explores *confidently*; the goal is a **trustworthy correct map**, not fewer tokens.) An *optional* local-embedding **rerank** inside the existing `search` is the ONLY embedding-shaped idea worth considering, and only if eval shows first-call precision is the bottleneck.
- **Editor-native AI (Tab completion / Cmd+K inline edit) is OUT of scope.** That's "becoming an IDE." Atlarix is chat-first with a passive editor pane by design.
- **Keep it simple.** "Not complex" is a stated goal — weigh every addition against it. The engine-correctness work (Tiers 0–4) and "small models perform well" features (native tool history 0.2, capability profiles 2.1, edit-verify 0.3) ARE the identity; most product/IDE features are not.
- **Perf is identity.** Observed `ttft=15909ms` on Core (own logs) is a real bug — the pre-flight Supabase usage check + context assembly likely run serially before first token. **Parallelize pre-flight, lazy-build non-critical context, stream the first token sooner.** Fast is core.
- `atlarix.md` (user-editable) is the project **rules** file; `memory.md` is the **model's** project memory — distinct, both already exist. No new "rules file" needed.

---

### TIER 6 — Blueprint v2 (ranked structural retrieval)

The retrieval engine (paper above). Already fast (ms, like embeddings) and accuracy ~parity; goal is **better than embeddings** by being *correct structure, relevance-ranked* — the differentiator embeddings can't match. Three high-value fixes, all pure local/lexical (zero embeddings):

1. ✅ **Edge resolution respects `tsconfig.json` paths/baseUrl + `package.json` imports BEFORE relative fallback — DONE (session 12).** `resolve-edges.ts` recovers the alias-import cross-module edges that were silently dropped. **The #1 accuracy fix.**
2. ✅ **Fuse BM25 into `get_blueprint` slice ordering — DONE (sessions 12+14).** Centrality + tail-summary (s12) and BM25 text-relevance fusion (s14: precomputed per-room score map in the async handler, merged into the sync `buildSlice` comparator). Rooms rank by `bm25Norm*2 + degreeNorm`, matched-first.
3. ✅ **Emit ctags `signature` per function — DONE (session 12).** `simpleDescription` (the ctags signature) rides the slice + renders in tool-mode markdown in place of the bare name. Free signal density.
- **Secondary:** centrality-aware BFS (prefer high-fan-in core modules when expanding depth so the slice doesn't balloon); edge **confidence** (`call`-confirmed vs `import`-inferred so the model trusts confirmed, treats inferred as hints → fewer dead-end reads); truncate at **room boundaries**, never mid-room.
- **Measure it (ties to Tier 4):** add a retrieval eval — **precision@1** (did the first `get_blueprint`/`search` land on the file the task needs?) and **calls-to-target** — vs the embedding baseline. Turns "~parity" into "measurably better" and is the natural second paper.
- **Weak spots** (from a subsystem audit): ✅ `getRoomKey` granularity (s14 — 2-level for deep generic roots); ✅ structural-scan worker crashes losing batch edges (s14 — fast-resolve + counter); ✅ no slice cache (s14 — LRU keyed on focus/topic/scope/depth). **Still open:** dynamic calls (`obj[fn]()`) dropped silently; BM25 `name:4` weight lets generic names (`handle`/`process`) dominate; thin-graph threshold (15 fns) too aggressive for well-modularized Python.

---

### TIER 7 — Standing Workspace (make it yours, shareable, trustworthy)

What separates "an app you point at a folder" from "a workspace that's *yours*." **Strength already present:** `.atlarix/` is a committable, portable config (memory.md, ATLARIX.md rules, blueprint.json, skills/, plans/, snapshots/, reference-projects.json, training_data/) — a foundation Cursor lacks. The gaps complete it:

- ✅ **A. User-definable agents — DONE (session 11).** `.atlarix/agents/<name>.md` (system prompt + tool allowlist + model override) loads as an AgentProfile from disk; picker-selectable. Follow-up: an in-app agent editor (today: hand-written markdown).
- ✅ **B. Hooks → enforceable + portable — DONE (session 10).** File-based `.atlarix/hooks/` with blocking pre_tool_use + stop gate, wired at the tool funnel (see 2.2). The old DB hooks-manager stays as legacy advisory until a release note retires it.
- ✅ **C. `.atlarix/` contract documented — DONE (session 11).** `docs/atlarix-contract.md` — the full committable-vs-cache spec. Follow-up: a `~/.atlarix/` global layer.
- ✅ **D. BYOK spend — DONE (session 11).** Per-turn USD estimate (OpenRouter pricing → static table; null for Core/unknown) on `chat:response:end`, shown in the token meter. Still open: a fuller inspectable action-audit surface (the activity stream is the current partial).

**Open decision (NOT a recommendation): headless surface.** A CLI/local-server/SDK (peer-parity with Claude Code/opencode/Codex; enables CI, git-hooks, invocation by other tools — big expansion of "beside/by itself"). **But** it cuts against "visual workspace" + "not complex." If ever done: expose the unified loop (0.1) behind a thin CLI, do NOT build a second engine. Decide consciously.

**Research note (moonshot, not now): the learning workspace.** `.atlarix/training_data/` already hints at it — a workspace that *learns your codebase over time* (distilling its own retrieval/edit traces to get better at *your* project specifically). The most "Atlarix and no one else" idea here, and a perfect fit for "small models perform well." Research-tier.

---

## Shipped in v11.0.0 (unreleased)

| Area | Notes |
|------|--------|
| **In-app browser (WebContentsView)** | "Browser" tab in the right panel — native `WebContentsView` (immune to X-Frame-Options), tabs + URL bar + back/forward; isolated `persist:atlarix-browser` session, sandboxed dedicated preload, http(s)-only, popups/downloads/permission-requests denied; agent tools `browser_navigate` / `browser_read_page` / `browser_screenshot` (all modes) + `browser_click` / `browser_fill` (Build/Fix); page content framed as untrusted with origin disclosure |
| **WebMCP bridge** | `navigator.modelContext` (W3C draft) shim injected into browser pages; page-registered tools surface via `list_webmcp_tools` / `call_webmcp_tool` in EVERY mode; metadata-only relay (execute stays in page, 20s timeout); cleared on navigation; untrusted-content envelopes; fixture page `e2e-tests/fixtures/webmcp-demo.html` |
| **Compass → Atlarix Core** | 3 plan-gated Compass tiers replaced by 4 Core slots (`core-1..4`, env `ATLARIX_CORE_MODEL_1..4`); ALL plans get ALL models — access is strictly token-metered against the existing Supabase `compass_tokens` pool (limits read from Supabase, never hardcoded); plan coercion/filter code deleted; legacy `compass-*` ids alias forever + persisted selections normalize |
| **Strict mid-task token enforcement** | Core usage recorded **per agent step** (`onStepFinish`, awaited) instead of fire-and-forget at stream end (which also undercounted multi-step turns); turn aborts immediately mid-task when the pool runs out, with the upgrade message + partial response saved; `stopWhen` backstop; server RPC stays authoritative, local tally is the fast guard |
| **Packaging bug — the real 1.28GB cause** | `npm install <pkgs>` in `packageAfterPrune` reconciled the FULL dependency tree back into the asar AFTER the removal loops (dugite 140MB, next+@next/swc 194MB, echarts, lucide, …). Staged `package.json` now rewritten to the runtime-external allowlist before any install — the asar can never contain the app's full tree again |
| **Lighter app** | `geist` dep dropped (fonts vendored as woff2, kills next/@next 284MB from installs); `dugite` dropped → system git via `system_git_exec.ts` (E2E bundled-git path kept via `LOCAL_GIT_DIRECTORY`); vestigial 64MB nested `typescript` stripped from `vscode-langservers-extracted`; knip purge (~30 dead exports, 59 dead types, dead files) + knip config tightened |
| **Document readers** | `.pptx` / `.odt` (zip+XML via tiny `fflate`), `.rtf` (in-house stripper), structured `.csv` (via existing `xlsx`); spreadsheet/CSV results render a real **table card** (`ToolTableExpand`), xlsx included; pdf/docx unchanged |
| **Supabase hardening** | `20260605120000` migration: REVOKE direct INSERT/UPDATE/DELETE on `compass_tokens` (writes only via SECURITY DEFINER RPCs); docs/compass-limits.md fixed (referenced a migration that never existed) |
| **ask_user end-turn redesign** | Asking questions ENDS the turn (Claude Code-style): all questions batched in one call, turn persists with reload-durable `atlarix-questions` artifact, answers return as a real Q→A user message + continuation stream; 30-min wait/timeout machinery and freeze-baseline atom deleted; typing supersedes the card |
| **Error UI placement** | Stream-failure banner + Retry/Dismiss moved from top of chat to the pinned slot above the input (aligned with SlowStreamWarningBar) |
| **Compaction hardening** | Durable summaries (persisted to session + dispatch slices from last `[COMPACTION MARKER]`); provider context-overflow → clamp estimate + force-compact + one retry; real Ollama/LM Studio context windows via their APIs; double-summarize + runaway-summary guards; dead post-turn compaction scheduler deleted |

**Follow-ups (v11):** consent UX for first agent-initiated `browser_navigate` (currently scheme-gated only); WebMCP `requestUserInteraction` support; Core 4 reasoning-tier routing heuristics; measure installed size on Windows/Linux CI.

---

## Shipped in v10.1.0

| Area | Notes |
|------|--------|
| **Code tab FILES fix** | `get-app` hardcoded `files: []` and `files ?? query` never fell back on `[]`; Code tab + full-screen code page now use the `getAppFiles` query directly; vestigial `App.files` removed |
| **Sidebar simplified** | Files tab removed under the workspace name — Sessions only; files live in the right-panel Code tab (+ Cmd/Ctrl+P) |
| **Streaming indicator redesign** | Global full-width `ToolIndicator` strip deleted; small inline compass (`AtlarixAnimation` bare mode) + human-readable one-liner under the CURRENT response only; settles into a stagnant "A"; arg-aware labels ("Writing src/auth.ts…") |
| **Provider-native web search** | Anthropic `web_search`, OpenAI `webSearchPreview`, Gemini grounding, OpenRouter `web` plugin swapped in at dispatch (`native_web_search.ts`); client `web_search` (SearxNG → DDG) stays the universal fallback; native keys feed citations |
| **Prompt caching** | Stable system header carries an Anthropic `cacheControl` breakpoint (covers tools+system); second breakpoint on the previous exchange for incremental history caching; per-turn tail moved out of `system` (was invalidating the cache every turn — date is now day-stable); cache read/write logged per round (`[prompt-cache]`) |
| **System-prompt slimming** | Deleted unused exports (`getModeSystemBlock`, parts-variant builder), deduped Ask/Build discovery flow, tightened web-research + `task_complete` blocks |
| **Terminal polish** | Scrollback persists across restarts (xterm `SerializeAddon` + `pty:scrollback:*`); terminal tabs persist to disk (`terminal-scopes.json`); legacy single-command input path for user tabs DELETED (kill-switch now hard-disables); live cwd per tab label via OSC 7/1337 (`pty:cwd`) |
| **MCP marketplace polish** | True one-click OAuth (no dialog when no env vars), curated `category` + `installs` registry fields (graceful when absent), first-run wizard CTA deep-linking to `/settings/mcp?tab=marketplace` |
| **Cmd/Ctrl+P quick open** | Fuzzy file opener (`QuickFileOpen`) over the shared `app-files` query; opens in the right-panel Code tab |
| **Startup & large-repo perf** | `WorkspaceFileTree` virtualized (`@tanstack/react-virtual`); ctags index refreshes incrementally via per-file mtimes (`fileMtimes` manifest) instead of full re-tag on commit change; `[perf]` open→first-prompt timing marks |
| **Supabase hardening** | Migration `20260604120000`: team_members self-service DELETE (leave/decline), invite policies via JWT email claim, `users.team_id` WITH CHECK, `record_compass_usage` sanity cap + 60/min rate limit; Lemon webhook fails loudly when `LEMONSQUEEZY_WORKFORCE_VARIANT_ID` unset |
| **Dead-code & size sweep** | ~28 dependencies removed (konva, framer-motion, lexical×3, openai, pdf-parse, opentelemetry×3, …); `bad-words` → in-house wordlist; node-fetch → global fetch; pivot-analysis subsystem, legacy `.bak` snapshot fallback, dead ChatInput/Lexical chain (+9 orphans), 16 dead atoms, dead token utils deleted; debounce consolidated |
| **Renderer tests** | Multi-project vitest (node + jsdom); fake `IpcClient` harness (`src/__tests__/renderer/helpers.tsx`); 14 component tests (inline indicator, stream tool cards, Cmd+P, first-run wizard) |

| **Security deployed** | Hardening migration + webhook live on production Supabase (`supabase db push` + `functions deploy`; 401 on bad signatures verified) |
| **Tool-output token budgets** | >6k-token results spill to disk with a head+tail preview (1.5k+0.5k tokens, omitted-range marker) instead of head-only 2k chars; `headTailTruncateToTokens` in `lib/truncate.ts` |
| **Reload-stable native citations** | `source` stream parts + Gemini `groundingMetadata` → hidden `<atlarix-sources>` content tag → citation chips live + after reload (`extractInlineSourcesFromContent`) |
| **Dead-export sweep** | ≈220 zero-usage exported symbols deleted (incl. legacy `AtlarixMarkdownParser` main component, ThinkingSection, PlanCard/PlanSection); remaining knip flags live only in contract files (schemas, ipc_types, ui kit) |
| **Legacy /chat indicator** | Old purple pulse dot → inline compass (same visual as the main surface) |
| **ask_user actually pauses** | Root cause: the `__ask_user` marker was nested inside ToolRegistry's `{success, result}` envelope — every interceptor missed it; marker now escapes the envelope (same contract as `__permission_required`) + agent-path interceptor added + freeze baseline set (was deleted) |
| **ask_user inline multi-question card** | `InlineUserQuestions` in the chat thread (replaces `UserQuestionBar`); `questions[]` (max 5 × 4 options + free text); single-question option click = instant submit; combined readable `Q → A` transcript returns to the model |
| **Session reuse on reopen** | `startWorkspaceSession` reuses the newest empty default-titled session + prunes the stale empty backlog (`pickSessionReuse`); no more "Untitled" stacking from app reopens / repeated New chat |
| **Stall watchdog vs tools** | Stream stall abort suspends while a tool call is in flight (sub-agents, long commands, pending ask_user); still fires when the model itself goes silent |
| **Sub-agent display honesty** | Read results → one-line summaries; JSON envelopes never pasted into labels; progress lines titled **Activity** (not "Thoughts") |

**Follow-ups:** extend renderer tests to edit→persist→reload, mode switch, MCP auth retry, per-hunk
approvals; consider trimming the remaining ~120 contract-file export flags case-by-case.

---

## Shipped in v10.0.0

| Area | Notes |
|------|--------|
| **Interactive PTY terminal** | xterm.js + node-pty for user tabs (Tab completion, vim/top); agent tabs unchanged; `enablePtyTerminal` kill-switch; fallback to single-command input |
| **Live plan step progress** | `update_plan_step` tool; checklist `[ ]→[~]→[x]` live on plan card + Plan panel; built safety-net closes steps |
| **Per-hunk diff approvals** | Real LCS hunks (`diff` pkg) in `SmartDiffView`; per-hunk checkboxes; `overrideContent` through `executePermission`; multi-file hunk summary |
| **`.atlarix/memory.md`** | Agent-maintained project knowledge file; hint-only prompt injection (never force-read); Plan/Build writable; auto-memory repointed (fixes ATLARIX.md archive bug) |
| **First-run wizard** | 4-step skippable setup; legacy 5-step overlay deleted; tour copy refreshed |
| **Token accuracy** | Sub-agent + compaction usage recorded per turn (Compass metering + `auxTokens`); context meter shows pruned sections + sub-agent tokens; `(3.2s)` tool elapsed |
| **Commit attribution** | `"<Model> agent" <agent@atlarix.dev>` via prompt + `git -c` injection; internal commits stay `atlarix-agent` |
| **Shadow-git snapshots** | Per-turn revert via hidden git repo in app data (dedup, 14-day prune, legacy `.bak` fallback); created files deleted on revert |
| **Mode isolation** | Every-mode tools in all allowlists; no legacy all-modes block on streams; leakage tests |
| **Actionable tool errors** | `TOOL_RECOVERY_HINTS` envelope in ToolRegistry + worst-offender rewrites (replaces the planned tool-retry button) |
| **Right-panel Diff tab removed** | Plus vestigial `file-diff` PanelType; diffs/approvals are inline in chat |

Plus the previously-unreleased quality batch (tool results in chat, MCP auth-and-retry,
chat-edit persistence, dead-code sweeps, 0 tsc/0 lint, quality gate). See
[CHANGELOG.md](CHANGELOG.md) `[10.0.0]`.

---

## Roadmap

*(In-app browser tab shipped in v11.0.0 — see above.)*

---

## Shipped in v9.1.0

| Area | Notes |
|------|--------|
| **Attachments** | Post-send chips; `displayPrompt` / `modelContent`; DB + session persistence; Explore mode preserves paste/terminal tags |
| **LSP** | `listen()` before init; bundled TS/JSON servers; broken-server cache; absolute spawn paths |
| **Self-correction** | LSP diagnostics only; TSC worker + Problems tab removed |
| **Workspace open** | No auto `get-app-files` / git scan; on-demand file tree; multi-repo UI/hints removed |
| **Discovery** | `project-files`: fd → rg → walk (no git ls-files aggregate) |
| **Polish** | Atlarix Core catalog labels; welcome dark-mode buttons; Sentry noise filters |

See [CHANGELOG.md](CHANGELOG.md) `[9.1.0]`.

---

## Shipped in v9.0.0

| Area | Notes |
|------|--------|
| **Welcome** | Open folder / recent workspaces without renderer `node:path`; hide right-panel toggle on launcher |

See [CHANGELOG.md](CHANGELOG.md) `[9.0.0]`.

---

## Shipped in v8.9.0

| Area | Notes |
|------|--------|
| **Workspace-only** | Welcome launcher; no global chat; MCP/skills per workspace (migrations `0049`–`0051`) |
| **Sessions** | Background streaming; New chat in workspace; display snapshots for sub-agents |
| **Sub-agents UI** | Scoped labels; Sub-agents round panel; grouped tool summaries |
| **Code tab** | `getAppFiles` tree in right panel; bundled Monaco workers |
| **Vault** | UI removed; env utils kept for codegen |
| **Docs / onboarding** | Tools page, Shepherd tour, onboarding targets updated |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) `[8.9.0]`.

**Follow-ups:** Remote SSH full FS RPC; Windows code signing; packaged Monaco smoke on CI.

---

## Shipped in v8.8.0

| Area | Notes |
|------|--------|
| **Plan artifacts** | DB-backed session plans; `PlanArtifactCard`, `PlanExecutionPanel`, plan IPC |
| **atlarix.md** | `.atlarix/atlarix.md` project memory; `.atlarix/.atlarixignore`; Plan-only writes |
| **Session titles** | Async AI naming after first assistant reply |
| **Folder picker** | Instant native dialog on `+`; `get-app-files` for sidebar tree |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) `[8.8.0]`.

---

## Shipped in v8.7.5

| Area | Notes |
|------|--------|
| **IPC polish** | `renderer-ipc-bridge.ts`; auth plan dedupe; workspace delete cleanup |
| **Packaged logos** | `assetsInlineLimit: 0` in renderer Vite config |
| **Diagram UX** | No saved-diagram auto-load; `get_diagram` local-only; Mermaid stream spinner |
| **Session titles** | Instant title from first user message + `<atlarix-chat-summary>` upgrade |
| **Blueprint logs** | Routine parse/scan success at `debug` |
| **Docs** | RTE reference §19.5 packaged grammars; architecture + skill guide updates |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) `[8.7.5]`.

---

## Shipped in v8.7.0

| Area | Notes |
|------|--------|
| **Section-first `get_blueprint`** | Required `focus_path`; `validateBlueprintFocusPath` + typo suggestions |
| **Slice layer** | `blueprint-slice.ts`; default `scope: "full"`; auto-widen; `emptyReason` |
| **Thin-graph hybrid** | `blueprint-quality`, `blueprint-merge`, `rte-supplement`; richness-gated file-tree backfill |
| **Tool output** | Tool-mode Markdown; `parseQuality` / `parseEngine` metadata |
| **Empty cache policy** | Do not cache 0-room parses |
| **Agent guide** | `src/skills/guides/blueprint-section-first.md` |
| **Tools UI** | Removed unused Diagram filter tab |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) `[8.7.0]`.

---

## Shipped in v8.6.0+

| Area | Notes |
|------|--------|
| **ast-grep + ctags stack** | `generateBlueprint()` via Universal Ctags symbols + `@ast-grep/napi` import/call edges |
| **Lazy blueprint wire** | `inferBlueprint` on cache miss; v8.7+ richness-gated merge via `blueprint-merge.ts` |
| **BM25 on symbols** | `search({ mode: "semantic-graph" })` and auto mode when `.atlarix/symbols.json` is warm |
| **Structural BFS** | `search({ mode: "structural" })` BFS over blueprint `flowEdges` |
| **ast-grep worker pool** | `astgrep_worker.js` + `worker-pool.ts`; built via `npm run build:astgrep-worker` (postinstall + prestart) |
| **Route edges** | Express/Fastify/Next HTTP handlers → `api_call` edges in structural scan |
| **Bundled ctags** | `npm run fetch-ctags` (postinstall); CI step before release builds |
| **oxc / tree-sitter removed** | `getStructureScan` uses ctags; deprecated RTE parsers deleted |
| **Incremental ctags + cache merge** | `updateSymbolIndexForFile`, `updateBlueprintCacheForFile`; file watcher uses 500ms debounce |
| **Python/Go ast-grep** | dynamic lang registration via `register-dynamic-langs.ts` + import/call/route rules |
| **Blast radius** | BFS on flow edges; permission + `diagnose_issue` wiring; skipped in autonomous auto-approve |
| **`edit_file` permission fix** | schema + interceptor `executeOperation` |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) `[8.6.0]` / `[8.6.1]`.

---

## Shipped in v8.5.0

| Area | Notes |
|------|--------|
| `ask_user` only (no `<questions>` widget) | Removed `QuestionsWidget`, `chat:questions` IPC; prompts + `stripQuestionsBlockFromResponse` |
| Multi-terminal + persistence | `terminalInstancesAtoms`, `TerminalPanel`, `terminal-instances.ts` |
| Workspace sessions sidebar | `ensure-workspace-session`, `workspace_session_handlers`, session list UI |
| Right panel diagram tab removed | `useRightPanelContext`, `RightPanel`, `CodePreviewPanel` |
| Renderer package shims | `vite/renderer-main-only-shims-plugin.ts`, `vite.renderer.config.mts` |
| CLI uninstall sudo parity | `cli_handlers.ts`, settings types |
| Markmap theme/zoom | `MarkmapRenderer.tsx` |
| `read_file` structured errors | `file.ts`, tests |
| Viz prompt routing | `system_prompt.ts` inline viz rules |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) `[8.5.0]`.

---

## Shipped in v8.4.0

| Area | Notes |
|------|--------|
| Terminal completion + kill on timeout | `runShellCommand.ts`, permissions interceptor |
| Terminal UI + `terminal:run` IPC | `TerminalPanel`, Activity tab, `terminal_handlers.ts` |
| CLI `atlarix .` / open-file / second-instance | `open_workspace_from_cli.ts`, `cli_handlers.ts`, Settings install |
| Terminal mode permissions | `terminal-command-class.ts`, `chat_stream_handlers.ts` |
| PDF 30s timeout + pdf2json fallback | `workspace.ts` tool read path |
| Per-mode system prompts (no `request_mode_change`) | `system_prompt.ts` |
| Per-message `work_mode` + resend UI | migration `0044`, `ChatMessage.tsx` |
| Edit toolbar Mode + Send (ephemeral workspace) | `show-workspace-mode-controls.ts`, `SimpleMessage.tsx` |
| Edit resend no duplicate user message | ephemeral `continueAfterQuestions` in `chat_stream_handlers.ts` |
| Session memory on edit resend | `replaceLastExchange` in `session-memory.ts` |
| Ask mode `run_command` + Autonomous terminal approve | `shell.ts`, ask-tier stream path |
| Git author `atlarix-agent` + live co-author toggle | `git_author.ts`, `git_utils.ts` |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) `[8.4.0]`.

---

## Shipped in v8.3.0

- **Agent Workstation reframe:** README, launchpad, in-app copy (tiers, modes, Model Bridge, Approval Queue).
- **Git tools removed:** Agent uses terminal for `git` CLI; system prompt note added.
- **`task_complete` UI fix:** Tags stripped in stream/DB/render paths.
- **architecture.md:** Live Code Map / parser documentation moved out of README lead.

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) `[8.3.0]`.

---

## Shipped in v8.2.0 — **Removed in v8.6**

- ~~**oxc packaging**~~ Removed with oxc-parser deletion.
- ~~**Parser worker pool**~~ Replaced by `astgrep_worker.js` worker pool.
- ~~**WASM RTE**~~ Superseded by Universal Ctags for symbols; ast-grep for TS/JS edges.
- **CI:** `npm test` + `bench-blueprint-index.ts` before release builds.

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) `[8.2.0]`.

---

## Shipped in v8.1.0 — Pass 6

| Area | Status | Notes |
|------|--------|-------|
| Blueprint restoration (lazy) | **Done** | Schema + IPC + `get_blueprint` + canvas gate + `search` structural; pivot TS stubs |
| Unified `search` | **Done** | Replaces `search_code` / `find_relevant_files` in registration; manifests + mode consistency test |
| Streaming + list virtualization | **Done** | Throttled `setMessagesById`, `MessagesList` virtualizer, post-stream trim |
| Right panel / dev server UX | **Done** | No auto-open for diagram/blueprint streams; `DevServerProvider` no auto-start / no auto panel |
| Tool merges (Pass 6 set) | **Done** | `get_diagram`, `check_environment`, `get_file_outline`+stats, `run_tests`+path, `git_status`+session, `live_preview`+`port_only`, `get_project_history`+`revert_to`, `request_tools` text |
| Diagram references | **Done** | `get_diagram` `role`; `diagramReferencesAtom` + chips in `DiagramPanel`; diagrams page chat-driven |
| PDF worker | **Done** | `attachment-tools` `workerSrc ''` |
| Pass 7 carryovers | **Done** | MCP on-demand, skills tools, `<mode_system>` / `modeAllowlist`, `edit_file` / `memory` / `diagnose_issue` consolidation (see CHANGELOG Pass 7 section for detail) |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) Pass 6 + Pass 7 entries for `[8.1.0]`.

---

## Shipped in v8.1.0 — Pass 7 (intermediate branch; partially superseded)

| Area | Status | Notes |
|------|--------|-------|
| Blueprint subsystem removal | **Superseded by Pass 6** | Pass 6 restored Blueprint; ignore this row for current behavior |
| Tool consolidation (~60 → ~28) | **Partial** | Pass 6 adds `search` naming and tool merges listed above; `edit_file` / `memory` / etc. remain |
| MCP scoping rework | **Done** | `list_available_mcps` + `mcp_call`; workspace MCPs no longer force-merged |
| Skills via ToolRegistry | **Done** | `get_active_skills` + `list_installed_skills`; removed `if(false)` injection block |
| `<mode_system>` prompt block | **Done** | `system_prompt.ts` + `chat_only_handlers.ts`; smoke test in `mode_system_consistency.test.ts` |
| Migration 0043 | **Superseded** | Pass 6 reverted drop migration where applicable; follow bundled SQL in repo |
| Dependency audit | **Partial** | `@xyflow/react` + `elkjs` restored for Blueprint UI; tree-sitter packages may remain absent (stubs) |
| Tool count log | **Done** | `initializeTools()` logs sorted registered tool list at startup |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) `[8.1.0]`.

---

## Shipped in v8.0.3

| Area | Status | Notes |
|------|--------|-------|
| OpenRouter BYOK | **Done** | Provider + model fetch + `get_model_client`; Compass unchanged; settings migration (openrouter→compass) removed |
| Packaging (tiktoken / pdfjs / prune install) | **Done** | `vite.main.config.mts` externals; `forge.config.ts` ignore + `packageAfterPrune` npm roots |
| Package build heap | **Done** | `cross-env NODE_OPTIONS=--max-old-space-size=8192` on package/make/publish |
| Quit lifecycle logs | **Done** | `main.ts` `[lifecycle]` memory on `before-quit` / `will-quit` |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) `[8.0.3]`.

---

## Shipped in v8.0.4

| Area | Status | Notes |
|------|--------|-------|
| Dev install / Electron binary | **Done** | Root `postinstall` runs `node_modules/electron/install.js` after native rebuilds so `Electron.app` / binary exists when `dist/` was incomplete (fixes `spawn …/Electron ENOENT` on `npm start`) |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) `[8.0.4]`.

---

## Shipped in v8.0.1

| Area | Status | Notes |
|------|--------|-------|
| Tool contract / availability honesty | **Done** | Agent prompt layer aligned so registered tools are not reported as missing |
| Model-triggered compaction | **Done** | `compress_context` tool; pre-dispatch stepped summarize path gated (PASS2 markers in `chat_stream_handlers.ts`, `chat_only_handlers.ts`) |
| Streaming terminal / `chat:response:end` | **Done** | Idempotent end events across stream paths |
| Macro tools | **Done** | `get_workspace_overview`, `read_attachment_summary` |
| BYOK error classification + banners | **Done** | `classifyProviderError` + actionable UI |
| Skills Marketplace | **Done** | Registry IPC, DB migration `installed_skills`, Settings UI, Pro/Workforce gating |
| Pre-dispatch context cleanup (PASS5) | **Done** | Blueprint/skills/Supabase/diagram prefix/workforce analysis/project memory gated or disabled; session memory char cap |
| Explore subagent | **Done** | `delegate_to_agent` explore path; read-only tool set |
| OpenRouter app headers | **Done** | `X-Title`, `HTTP-Referer` on SDK + fetches (`get_model_client`, `openrouter_api`, `tier-context-limits`, `openrouter-provider`) |
| Tool spinner reconciliation | **Done** | `AtlarixMarkdownParser` stream-end handling |
| Debug instrumentation removal | **Done** | `debugLog` / `hypothesisId` removed from chat stream |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) `[8.0.1]`.

---

## Shipped in v7.1.2

| Area | Status | Notes |
|------|--------|-------|
| Counsel live thinking | **Done** | `counsel_thinking` activity type; `streamText` + `fullStream` iteration; reasoning deltas emitted every 1.5s as "Analyzing: [snippet]" |
| Delegation visibility | **Done** | `onToolIndicator` listener in `useStreamChat`; `tool_use` activity items for tool start/end in ThoughtsPanel |
| Tool completion for empty results | **Done** | "✓ Done" shown automatically for all tool completions via activity stream |
| Tool output cache at execution time | **Done** | `ToolOutputCache` integrated into `ToolRegistry.execute()`; outputs >10KB cached to disk with 7-day retention |
| File/image attachments (non-workspace) | **Done** | Attachment support extended to chat-only mode in `chat_only_handlers.ts`; vision capability check for image processing |
| PTY support | **Done** | `src/lib/pty-utils.ts` with `@lydell/node-pty`; interactive shell in Build/Debug; graceful fallback to pipes on failure |
| Blueprint file watcher | **Done** | Uses Node.js `fs.watch` with 500ms debounce; incremental cache updates |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) v7.1.2.

---

## Shipped in v7.1.1

| Area | Status | Notes |
|------|--------|--------|
| No-workspace CTA after first user message | **Done** | `ChatInputControls`: hide `NoWorkspaceBanner` when thread has a user turn (`chatMessagesByIdAtom` + `chatId` / `selectedChatId`); `HomeChatInput` / `SimpleChatInput` pass `chatId` |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) v7.1.1.

---

## Shipped in v7.1.0

| Area | Status | Notes |
|------|--------|--------|
| DelegationMonitor + `delegation_abort` | **Done** | Sliding-window cyclic/runaway delegate detection; corrective bus signals; wired next to loop-break in autonomous stream |
| Bus `modelId` / `responseMs` | **Done** | Optional fields on messages + IPC + Thinking / ring UI |
| Counsel completion-driven + 7 min cap | **Done** | `COUNSEL_TIMEOUT_MS`, `allSettled`, duplicate timeout races removed; partial counts on timeout activity |
| Mermaid prompt rules + friendly error UI | **Done** | Shared CRITICAL rules module; renderer retry + user-facing copy |
| OAuth step labels + LoadingBar | **Done** | `useAuth` + sign-in / `SignInScreen` |
| Workspace onboarding CTA | **Done** | `NoWorkspaceBanner` + `ChatInputControls` open-folder flow |
| Diagram panel Generate UX / TSC / logs | **Done** | Empty-state ordering, all modes diagram AI, tsconfig skip, log noise reduction |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) v7.1.0.

---

## Shipped in v7.0.4

| Area | Status | Notes |
|------|--------|--------|
| Chat Config dropdown viewport / clipping | **Done** | `ChatConfigDropdown`: `side="bottom"` + `avoidCollisions={false}` (always below trigger, away from prompt); Radix available-height clamp + inner scroll; remove `max-h-[70vh]` and manual side flip; `collisionPadding` 12 |
| `read_file` + codebase: block / omit `.env*` secret paths | **Done** | `src/lib/security/env-secret-paths.ts`; `file-tools.ts` `read_file`; `codebase.ts` `shouldReadFileContents*` |
| Follow-up: extend env denylist to other file readers | **Open** | `view_symbol`, `get_file_outline`, `find_files`, `search_code`, renderer `file:read-content` IPC — same `isEnvSecretPath` pattern |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) v7.0.4.

---

## Shipped in v7.0.5

| Area | Status | Notes |
|------|--------|--------|
| Auto-update (macOS ZIP feed) | **Done** | Release now publishes a notarized/stapled `.zip` of the `.app`; `latest-mac.yml` points to ZIP first (required by `electron-updater`) |
| Linux updates for all installs | **Done** | AppImage: silent auto-update stays on. `.deb`/`.rpm`: show native notification with one-click download link to the latest release |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) v7.0.5.

---

## Shipped in v7.0.3

| Area | Status | Notes |
|------|--------|--------|
| OAuth: open in system browser + timeout fallback | **Done** | `shell.openExternal`, 60s “Sign-in not completing?” dialog; Linux copy-link fallback; cancel timeout on deep-link callback |
| Dark mode button/toggle affordance | **Done** | Dark tokens + outline/ghost button surfaces + switch borders so controls read as clickable |
| Sign-in free tier copy aligned to pricing | **Done** | One workspace; starter included usage; BYOK/local models; no credit card |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) v7.0.3.

---

## Shipped in v7.0.2

| Area | Status | Notes |
|------|--------|--------|
| Tool strip labels + lifecycle | **Done** | `ToolIndicator` / `toolId` / stream `done` phase; submit→stream-end visibility |
| Autonomous + counsel strip overrides | **Done** | Activity + `counsel_start`/`counsel_end` stream phases |
| Deep think → Counsel fallback | **Done** | `hasNativeDeepThinkingSupport`, `deep_think_fallback`, chat-only parity |
| Turn artifact cards | **Done** | `completedTurnArtifactsByAssistantMessageIdAtom`, `TurnArtifactsCards` |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) v7.0.2.

---

## Shipped in v7.0.1

| Area | Status | Notes |
|------|--------|--------|
| `deep_research` ResearchLedger loop | **Done** | `web-tools.ts`: agentic iterations, coverage / empty / max stops; internal aggregator search + fetch + BM25 extract; model-facing `formatResultForModel`; logging |
| Chat-only deep + `web_search` gate removed | **Done** | `chat_only_handlers.ts`: no supplementary cap / overlap skip |
| Web search snippet filter | **Done** | `filterRelevantResults` threshold 0.25 |
| Deep research answered threshold | **Done** | Relevance score > 0.35 → `answered` |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) v7.0.1.

---

## Shipped in v7.0.0

Includes everything previously tracked as **Project Vanguard / v6.5.0**, now released as **Atlarix v7**:

| Area | Status | Notes |
|------|--------|--------|
| Living plan + `plan-sync` | **Done** | Ledger-driven `ATLARIX_PLAN.md`, archive under `.atlarix/plans/archive/` |
| `parsePlanToSteps` checkboxes | **Done** | `[ ]` / `[~]` / `[!]` / `[x]`; skip `[x]` for seeding |
| Auto memory `writeToFile` + turn tools | **Done** | Schema, settings, per-turn tool list for bullets |
| Counsel IPC + `abortSignal` | **Done** | `counsel:start` / `cancel`, discrete events, preload + client |
| Build verification ledger safety | **Done** | `depth: 1`, `recordOnParentLedger: false` verified |
| Migration / journal audit | **Done** | Through 0040 + seed verification |
| Plan viewer UI + `chat:plan-update` | **Done** | Task ledger card in chat; `plan_created` activity row |

See [CHANGELOG_PREVIOUS.md](CHANGELOG_PREVIOUS.md) v7.0.0.

---

## Ongoing

- Telemetry and Sentry hygiene for stream edge cases.
- Documentation alignment with each tagged release (README + launchpad + in-app copy).
- Provider catalog and African-provider integration roadmap (see public messaging on [atlarix.dev](https://atlarix.dev)).

---

## Done: v6.2.2 — Tier-aware Compass context + pre-dispatch budgeting

| Area | Status | Notes |
|------|--------|--------|
| OpenRouter tier limits + cache | **Done** | `tier-context-limits.ts`; warm on startup; keyed cache |
| Pre-dispatch budget + routing helpers | **Done** | `tier_context_budget.ts`, `context_budget_routing.ts`; Fast skipped |
| OpenRouter safety for BYOK + tier gate | **Done** | `needsOpenRouterContextSafety`; balanced/thinking only |
| Compaction summarize reuse | **Done** | `summarizeMessagesWithCompactionPrompt` |

See [CHANGELOG.md](CHANGELOG.md) v6.2.2.

---

## Done: v6.2.1 — Autonomous session polish + Thinking UI + snapshot hash path

| Area | Status | Notes |
|------|--------|--------|
| Autonomous bus / review / IPC | **Done** | Session-complete, revert-op, accept-all; review panel; snapshot revert per turn |
| Thinking / activity | **Done** | `think` / `redacted_thinking` in markdown parser; activity + bus ring wired with `chatId` |
| `snapshot_hashes.json` migration | **Done** | Canonical path under `.atlarix/snapshots/`; legacy root file migrated then removed |

See [CHANGELOG.md](CHANGELOG.md) v6.2.1.

---

## Done: v6.2.0 — Unified snapshots + non-destructive revert

| Area | Status | Notes |
|------|--------|--------|
| Migration 0035 + seed verification | **Done** | `chat_turn_id`, `last_snapshot_hashes`, `is_reverted` |
| Remove DiagramGitTracker / simple-git | **Done** | Staleness + `.atlarix/snapshot_hashes.json` |
| Permission capture + `revertSnapshot` | **Done** | `chat:revert-to-message` repurposed |

See [CHANGELOG.md](CHANGELOG.md) v6.2.0.

---

## Done: v6.1.16 — Diagram stability + Compass context safety

| Area | Status | Notes |
|------|--------|--------|
| /diagram Sentry noise fix | **Done** | Normalize `onunhandledrejection` Event reasons; capture actionable details |
| Blueprint file-tree layout | **Done** | Replace grid/ELK with top→bottom file-tree layout |
| Diagram restore refresh | **Done** | Restore version triggers diagram + history refresh |
| Compass context safety | **Done** | OpenRouter context compression fallback; last-7 exchanges safety cap |

See [CHANGELOG.md](CHANGELOG.md) v6.1.16.

---

## Done: v6.1.15 — Safety: Compass network, SQL guards, prompt hygiene, profanity filter

| Area | Status | Notes |
|------|--------|--------|
| Compass transient network | **Done** | `network_error` + quieter Sentry; `useCompassUsage` copy |
| SQL exec guards | **Done** | `sql-exec-guards.ts`; `executeSupabaseSql` before `runQuery` |
| Prompt hygiene + profanity | **Done** | IPC gate; `bad-words` input reject + output sanitize |
| DX / tooling | **Done** | `tsconfig.main.json`; `node …/tsc.js` for `ts:main` / `ts:workers`; `setWindowButtonPosition` |

See [CHANGELOG.md](CHANGELOG.md) v6.1.15.

---

## Done: v6.1.14 — Groq external auto-router classifier, balanced baseline, tier floors

| Area | Status | Notes |
|------|--------|--------|
| Groq tier classifier (`groq-classifier.ts`) | **Done** | `GROQ_CLASSIFIER_API_KEY` + `GROQ_CLASSIFIER_MODEL`; 2s timeout; 429 → log + fallback |
| Auto router fallback chain | **Done** | Groq (≥0.65) → fast model one-word (1.5s) → balanced; `applyTierFloor` after ceiling |
| Activity Stream classifier line | **Done** | `classifier_routing` + ThoughtsPanel |
| CI / Vite MAIN_KEYS | **Done** | `release.yml`, `vite.main.config.mts` |

See [CHANGELOG.md](CHANGELOG.md) v6.1.14.

---

## Done: v6.1.13 — Linux OAuth fallback, theme toggle, contrast fixes, auto-updater in-app UI

| Area | Status | Notes |
|------|--------|--------|
| Linux OAuth timeout fallback | **Done** | 60s `setTimeout` in `supabase-client.ts`; `cancelPendingOAuthTimeout()` in `main.ts` deep-link handler |
| Linux deep-link hint in sidebar | **Done** | `app-sidebar.tsx` — platform detection + dismissable `xdg-mime` notice on sign-in failure |
| Theme toggle | **Done** | Settings → General; `ThemeContext` persistence |
| Contrast / hero / panel | **Done** | `atlarix-home.tsx` glow; `layout.tsx` panel button position |
| Auto-updater in-app UI | **Done** | `UpdateBanner`; `update:defer` / cold-start install path |
| AppImage + CI Node 24 | **Done** | `forge.config.ts`, `release.yml`, feed assets |

See [CHANGELOG.md](CHANGELOG.md) v6.1.13.

---

## Done: v6.1.12 — Mermaid normalization, diagram page render

- See [CHANGELOG.md](CHANGELOG.md) v6.1.12.

## Done: v6.1.1 — Diagram git, blueprint layout, preview URL

| Area | Status | Notes |
|------|--------|--------|
| DiagramGitTracker | **Done** | Ignore `userData`, `.cursor` in workspace walk |
| Blueprint ELK | **Done** | Complete ref + reset / Re-layout clears |
| Live preview | **Done** | `devServerUrlAtom` fallback in `PreviewIframe` |

See [CHANGELOG.md](CHANGELOG.md) v6.1.1.

---

## Done: v6.1.0 — SQL inlining, pivot + prompts migrations

| Area | Status | Notes |
|------|--------|--------|
| Vite main `.sql` | **Done** | `vite.main.config.mts` — `raw-sql` `transform` + `enforce: "pre"` (no `assetsInclude`) |
| Drizzle | **Done** | `0032_pivot_tables`, `0034_prompts_new_schema`; journal + `migration_seed_verification` + `db:bundle-sql` |

See [CHANGELOG.md](CHANGELOG.md) v6.1.0.

---

## Done: v6.0.3 — Main bundle SQL ?raw

| Area | Status | Notes |
|------|--------|--------|
| Vite main `*.sql?raw` | **Done** | Superseded by v6.1.0 transform-based `raw-sql` |

See [CHANGELOG.md](CHANGELOG.md) v6.0.3.

---

## Done: v6.0.2 — Workforce UI + diagram Auto

| Area | Status | Notes |
|------|--------|--------|
| Workforce add-workspace UI | **Done** | `AppList.tsx` — `canCreateWorkspace` + Pro/Workforce |
| FallbackModel `doGenerate` | **Done** | `fallback_ai_model.ts` — `generateText` / diagram AI with Auto chain |

See [CHANGELOG.md](CHANGELOG.md) v6.0.2.

---

## Done: v6.0 — Workforce session scope, agents, UX

| Area | Status | Notes |
|------|--------|--------|
| Workforce session workspace selection | **Done** | In-memory per `chatId`; IPC + dialog; cleared on New Chat; prompt injection block |
| Remove base-of-origin Workforce settings layer | **Done** | No persisted default repo/channel/workspace for tools |
| Autonomous permission bypass (sub-agents) | **Done** | Guided unchanged; audit log line; summaries |
| Tester findings batch | **Done** | Fullscreen, chat, modes, streaming/models.dev, Compass UI |
| Thoughts + Compass loading + Blueprint hitboxes | **Done** | `ThoughtsPanel`, `AtlarixAnimation`, `BlueprintCanvas` overlays |
| Two-stage auto-router + delegation hint | **Superseded (v6.1.14)** | Groq + fast-model fallback + tier floors; see `auto-router.ts`, `groq-classifier.ts` |

See [CHANGELOG.md](CHANGELOG.md) v6.0.0 for file-level detail.

---

## Done: v5.1 — Compass & limits

| Area | Status | Notes |
|------|--------|--------|
| Compass provider + tier gating | **Done** | `compass_constants.ts`, `get_model_client.ts`, Free = Fast only; Pro/Workforce fallback chain |
| Supabase migration + docs | **Done** | `20260329120000_compass_tokens.sql`, `docs/compass-limits.md` |
| Settings UI + usage | **Done** | Collapsible providers, Compass page, `useCompassUsage` |
| Chat usage + block + toasts | **Done** | IPC bump after stream, `useCompassSendGate`, banners/strip |
| Onboarding 3-step | **Done** | `onboarding.ts`, home/settings banners, progress bar |
| CI env | **Done** | `release.yml`, `vite.main.config.mts` MAIN_KEYS |

### v5.1.1 patch (2026-03-30)

- MCP: `ensureMcpBaseTablesIfNeeded` in `db/index.ts` before `fixMcpServersSchemaIfNeeded` (see `docs/CHANGELOG.md`).

### v5.1 follow-ups

- Chat-only ephemeral streams do not yet record Compass usage RPC (main workspace path does).
- Optional: centralize Compass usage in a single Jotai atom to avoid duplicate fetches if multiple panes mount usage hooks.

---

## Done: v5.0 — Blueprint context, memory, ignore

| Area | Status | Notes |
|------|--------|--------|
| **S1** Tiered Blueprint injection + Build RAG cap | **Removed v8.1.1** | `blueprintPromptTiers.ts` deleted — Blueprint is tool-driven only (`get_blueprint`) |
| **S1** Blueprint-first empty state | **Done** | Plan/Build tiers inject blocker when Blueprint has no nodes |
| **S2** Schema + migration + bootstrap | **Done** | `project_snapshots`, `project_memory`; `0031_project_memory.sql`; `ensureProjectMemoryTablesIfNeeded` in `db/index.ts` |
| **S2** Snapshots + pruning | **Done** | Max 100 rows/workspace; triggers: debounced blueprint change, plan file write, build-complete (Agent/Build + files), `session_end` on quit for touched workspaces |
| **S2** Session system prompt injection | **Done** | `buildProjectMemoryPromptBlock` in `chat_stream_handlers.ts` |
| **S2** Tools | **Done** | `get_project_history` (with `revert_to` for `revert_project_snapshot` approval), `set_project_memory` |
| **`.atlarixignore`** | **Done** | `ignore` npm package; filter at RTE (`generateBlueprint`), cache load (`inferBlueprint`), prompt (`buildBlueprintSystemPromptInjection`); `atlarixIgnoreSource` on cache; default file on first parse; `get_atlarixignore` / `update_atlarixignore`; Blueprint panel + IPC get/set |
| **S3** Explicit Blueprint tier from Settings | **Done** | `blueprintInjectionModePreference` (Auto \| Ask \| Plan \| Build \| Debug); plumbed via `streamMessage` → `chat:stream`; precedence: IPC `blueprintInjectionMode` then preference then heuristics; optional `blueprintDebugTrace` / `blueprintDebugFile` in settings + `ChatStreamParams` for Debug tier |
| **S4** Chat session override for Blueprint tier | **Done** | Config dropdown → **Blueprint in prompt**: Use Settings or force Ask/Plan/Build/Debug; `blueprintInjectionChatOverrideAtom` merged in `useStreamChat` before Settings preference |
| **Work modes** Ask / Plan / Build / Debug / Review + Auto | **Done** | `workModePreference` in settings; maps to `selectedChatMode` + Blueprint tier via `src/lib/work-mode.ts`; `useStreamChat` precedence: chat override → work mode (non-Auto) → settings; `ChatIntentSelector` + context bar; duplicate Ask/Build removed from `ChatModeSelector` |
| **Subscription Realtime dedupe** | **Done** | Material-change gate in `supabase-client` `subscribeToPlanChanges`; serialized setup + fingerprint dedupe in `SubscriptionManager.setupRealtimeSubscription` |
| **S5a** Agent–mode foundation | **Done (kickoff)** | `debugger` in `builtin` / `agent-bus` / `delegate_to_agent`; `work-mode-agents.ts` (default agent + `workModeSystemHint`); stream injects hint after base prompt in `chat_stream_handlers.ts` |
| **S5b** Structured handoffs | **Done** | Structured payloads validated via `agent-handoff-schemas`; `HandoffResultCard` renders isolated blocks in parent thread (collapsed by default). |
| **S5c** Handoff polish | **Done** | Superseded: bus emits typed `task_assign` / `task_result` activity events; autonomous review panel provides post-run collapsible handoff summary; `HandoffResultCard` provides inline preview. |
| **S6** Structured outputs per mode | **Done** | Delegate/handoff schema validation + one retry; Plan/Debug/Review stream validation + warning fallback; structured report rendering for supported mode outputs |
| **S7** ContextAssembler | **Done** | `src/lib/context/ContextAssembler.ts` + `context-assembly-cache.ts`; deterministic section ordering, per-mode caps (Review: 2000), low-priority-first trimming, cache hit/miss + trim diagnostics in stream logs |
| **S7** Tiered discovery flow + folder tooling | **Done** | Added `explore_folder` (structured directory exploration with `.atlarixignore` filtering), `get_blueprint_slice` (targeted architecture slices), and conditional diagram-prefix messaging to prevent synthetic context claims |

### v5.0 follow-ups / incomplete

- **S5b / S5c closure (v6.2.1+):** **S5b** is **done**: validated delegate handoffs plus `HandoffResultCard` in the parent thread for `delegate_to_agent` results. **S5c** is **done** under a superseded definition: the agent bus supplies typed multi-agent activity; **AutonomousReviewPanel** covers post-run review; **HandoffResultCard** covers inline collapsed/expandable handoff preview. No separate duplicate “handoff preview” system is planned.
- **S6 execution detail:** S6a validates `delegate_to_agent` + child handoff payloads first (highest-risk surface). S6b extends validation to mode-scoped stream outputs for Plan/Debug/Review only. Ask and general Build remain prose-first.
- **S6 resilience contract:** Structured output failures should retry once with schema instructions, then emit a non-blocking fallback warning (Activity/chat) while preserving turn continuity.
- **S7 integration note:** `chat_stream_handlers` now assembles additive context blocks via `ContextAssembler` before final prompt injection. Keep future context sources in assembler section order to preserve cap behavior and predictable trims.
- **S7 ignore parity:** `.atlarixignore` is now applied in file-tree blueprint source generation in addition to RTE parse and prompt injection safety-net filtering.

- **`session_end` scope:** Only workspaces touched during the session (memory/snapshot activity) get a quit snapshot; others do not.
- **Tool discovery:** MEMORY-category tools (`get_project_history`, etc.) may not appear in progressive “core” manifests; verify UX for discovering them.
- **Permission queue:** `revert_project_snapshot` has no file `path`; queue UI relies on `PermissionQueuePanel` parsing JSON preview (not the file-proposal path).
- **Default `.atlarixignore`:** Patterns are intentionally aggressive (e.g. lockfiles, large binaries); product may want softer defaults or onboarding copy.
- **File-tree Blueprint:** Confirm whether `buildBlueprintFromFileTree` / non-RTE paths respect `.atlarixignore` everywhere; unify if gaps remain.
- **Per-turn Blueprint tier (future):** S4 uses a session-level atom (applies to every stream until cleared). Optional: reset override after each send, or a per-chat map keyed by `chatId`.

---

## Done: v4.3 — UX and release alignment (2026-03-23)

- **Versioning/docs refresh:** App version bumped to 4.3.0; README/TODO/changelogs aligned to current release messaging.
- **Secure auth persistence:** Keychain/encrypted session persistence on restart, startup restore + refresh, and explicit logout clearing.
- **Onboarding tours:** First-run + feature `?` Shepherd tours with local resume/completion state.
- **Billing entitlement fixes:** Correct active vs cancelled-within-period vs expired behavior; prevent premature feature removal; account copy alignment.
- **Workforce flow improvements:** New-chat clears Token Auth sessions, connected-service indicator in chat, and polished Workforce settings areas.
- **Ask-mode planning:** `write_implementation_plan` allowed in Ask with approval while code writes remain Build-only.
- **Ollama recommendations:** Hardware-aware model suggestions with pull actions and quick selection in provider settings.
- **Workforce permissions UX:** Ask/Build read-write split, Build-only approval for write/trigger actions, and unified batch permission panel via `request_workspace_permissions(services[])`.

---

## Done: v3.8 — Credentials, DB ease, Onboarding redesign, GitHub OAuth, Pro gating (2026-03-11)

- **Credentials:** `.env.example`, `SECRETS.md`; all secrets from env; GitHub OAuth in UI and Supabase.
- **DB Extension:** Connection string parser, Test connection IPC + UI, Parse button; easier connection setup (`.atlarix` in .gitignore for future workspace DB config).
- **Onboarding (redesign):** Screen-by-screen first-run flow (login → workspace → Blueprint intro → Ask vs Build → Settings AI provider → Done). State in Supabase `users.onboarding_completed`; progress bar and per-step Skip/Skip all; Restart in Settings > General; reset when last workspace deleted.
- **Pro gating:** Settings > Extensions and Sidebar Extensions: when logged out, show "Log in" CTA and button to sign-in; when logged in (free), show "Upgrade to use Extensions & DB" and Upgrade button. Pro users see full DB Connections and Extension Manager.
- **Reviews (launchpad):** `REVIEW_ADMIN_EMAIL` env; frontend only shows approved reviews.

---

## Done: v3.7 — Apple Verified, Sentry, PostHog (2026-03-09)

- **Sentry:** Always-on error monitoring for stability and faster fixes.
- **PostHog:** Optional analytics with first-launch consent and Settings toggle.
- **Apple Verified:** Notarized and code-signed on macOS; no security warnings.

---

## Done: v3.6 — Build guide completion (2026-02-27)

- **Auto router:** Two-stage routing, capability registry, fallback-router; wiring in chat stream; routing preview and override in ChatInput.
- **Summarization:** 7-trigger system, per-agent thresholds, balanced model for complex sessions, structured prompt.
- **Blueprint:** Enricher (contentHash cache, batches of 10), reference-manager, plan-manager (`.atlarix/plans/`), workspace open enrichment + combined blueprint.
- **Blueprint live flow:** Unique path IDs, bidirectional particles, edge direction fix, particle glow keyframes, legend entry.
- **Blueprint simplify with AI:** Containers, beacons, and full architecture simplification.
- **Blueprint edge corrections:** Fallback matching by normalized label/path; test edge filtering.
- **Plan cards:** PlanCard component, plan-card-renderer, extract from content; Switch to Build.
- **Agent mesh:** AgentBus, orchestrator, IPC forward to Activity Stream; agent_message / routing_decision in Activity Stream.
- **Agent animation:** Zustand animation-state, AgentNode, AgentMessageEdge; store sync from delegation events.
- **Animation speed:** All animation durations halved (GuidedPipeline, AgentNode, AgentMessageEdge, BlueprintEdge).
- **Reviewer:** static-analyzer, qodo-prompt-adapter, lightning-review-memory (review_patterns table).
- **Reference projects:** add_reference_project tool, get/set reference paths IPC, ReferenceProjectsCard in Diagram panel.
- **DB Extension:** Full CRUD for connections (PostgreSQL, MySQL, SQLite). IPC handlers, persistence, schema introspection, query execution. AI tools: db_query, db_schema, db_list, db_mutate. Context injector for system prompt.
- **Settings > Extensions:** DB connections UI with global and per-workspace scope.
- **Persistent tool indicator:** chat:tool:start/end with Atlarix compass animation.
- **Prompt suggestions:** Context-aware suggestion chips.
- **Atlarix loading animation:** Configurable AtlarixAnimation component (compass/A phases).

---

## Next session (to be done)

- **Diagram/Blueprint layout:** File-tree layout for the Blueprint container canvas shipped in **v6.1.16** (top→bottom). Remaining work is beacon-level file-tree layout and richer edge/tooltips if desired.

---

# Atlarix TODO

## v3.5 (done)

- [x] **Prompt suggestor** — Context-aware suggestions via `<suggestions>` block in AI response; parse and strip in backend; show chips in ChatInput.
- [x] **GitHub Actions** — Forge `APPLE_IDENTITY` for macOS signing; certificate import step; Windows build disabled (`if: false`); VirusTotal job after Mac build; publish without Windows.
- [x] **Streaming / tool UX** — Persistent "Working…" tool indicator; `chat:tool:start` / `chat:tool:end` IPC; ToolIndicator component; clear on response end.
- [x] **Atlarix loading animation** — Dedicated `AtlarixAnimation` component (size xs/sm/md/lg/full, phase thinking/done); used in ChatMessage (streaming) and ToolIndicator.
- [x] **Hide Windows** — Website: Windows download hidden, "in development" placeholder; releases: Windows build disabled; atlarix-releases README note.

## Later

- [x] **Windows CI builds** — `build-windows` runs in release workflow (unsigned installers; SmartScreen-friendly signing still pending).
- [x] Optional: stream terminal output into tool indicator for long-running commands.

---

## Done: v2.7 — AWS Bedrock and changelog order (released 2026-02-14)

- **AWS Bedrock:** Added to Settings → AI → AI Providers (cloud list); token budget supported.
- **Changelog order:** Newest releases now appear at the top.

---

## Done: v2.1 — Agent System and Project Understanding

- **Schema and settings:** Agent mode, permission mode (Ask/Build), Auto, three favorites per provider, AI Configuration options.
- **Project instructions:** Load/save `.atlarix/ATLARIX.md` and `~/.atlarix/ATLARIX.md`; precedence in system prompt; context window from resolved model.
- **Summarization model:** Fast/same/custom for compaction and title generation.
- **Built-in agents and delegate_to_agent:** Research, Architect, Builder, Reviewer; Guided flat delegation; Autonomous nested with depth limit.
- **Chat UI:** Mode (Direct/Guided/Autonomous) + Permission (Ask/Build); Auto toggle; active context bar.
- **Activity Stream:** Right-panel tab; events for delegation, compaction, self-review, turn summary.
- **Self-review:** Runtime stub (Activity Stream); settings schema in place.
- **Autonomous mode:** Nested delegation with max depth; shared context and approval modal can be extended later.
- **Agent Lightning:** Trace collection to `.atlarix/training_data/`; training entry point (placeholder).
- **Token budget:** Turn summary in Activity Stream; per-provider budget in schema.

---

## Done: v2.2 — Blueprint Intelligence (RTE + RAG + Combined Blueprints)

- **RTE parsers:** TypeScript and Python parsers; parser types and registry; single-project Blueprint from RTE.
- **Blueprint cache:** `~/.atlarix/blueprints/{projectHash}/`; manifest, blueprint.json; load/save and staleness.
- **Combined blueprints:** CombinedBlueprint schema, project-selector (findProjects), combined-generator (generateCombinedBlueprint, detectCrossProjectEdges); cache persistence for single and combined.
- **AI-selected blueprinting:** Activity scoring; "Generate Blueprints" modal with project list and recommendations; AI prompt for blueprint/diagram selection.
- **RAG:** queryBlueprint, getCodeForNodes; chat integration; file watcher for incremental Blueprint updates.
- **Parent-aggregated permissions:** batch_plan in PermissionInterceptor and schema; single approval modal; execute all on approve.
- **Motia-style UI:** React Flow canvas; node types and colors; Blueprint-driven ATLARIX_PLAN flow.
- All six implementation phases completed.

---

## v2.2 — Done (see Done section above)

---

## v2.5 — PIVOT (released 2026-02-14)

**Tagline:** From Code to Canvas, Canvas to Code — Architecture Made Simple

**Done in v2.5:** Right panel simplified (Activity removed, Vault kept); Thinking + agent delegation combined in chat; Auto model selection by mode/role (Direct/Guided → Balanced main, agents Fast; Autonomous → Thinking main, agents Balanced, subagents Fast); agent-phase animations on Blueprint canvas (Architect/Builder/Reviewer); PIVOT foundation (`src/lib/pivot/` types, SQLite schema, placeholders); atlarix-releases repo content (README, SECURITY, LICENSE).

---

## Done: v2.6 — Containers & Beacons UX and docs (released 2026-02-14)

- **Ephemeral session fix;** permission sounds on approval batches.
- **Docs:** AGENTS.md, AGENTS_COMPACT.md, agent-tools for delegate_to_agent and Blueprint (get_blueprint, compare_blueprint_to_live, add_blueprint_room/function/edge, update_blueprint).
- **chat:activity** for native tool start/end; Containers & Beacons UI rename (Diagram/Blueprint).
- **Blueprint UX:** Delete container/beacon, drag nodes, Summary Card, Edit Internals, Back, onboarding, "Always show beacons", AI-generated badge, Flow zoom/pan; aiGenerated in add_blueprint_function/update_blueprint.
- **Capability comparison** in README.

**Full PIVOT (implemented):**
- **Stage 1 — Parsing:** `src/lib/pivot/parsers` uses workspace-analyzer (regex + optional Tree-sitter) for TS/JS, Python, Go, Rust, etc.; unified `parseProject(workspacePath)`.
- **Stage 2 — Structure extraction:** `src/lib/pivot/structure.ts` maps WorkspaceAnalysis to PivotNode[] and PivotEdge[]; framework from analyzer.
- **Stage 3 — SQLite persistence:** `src/lib/pivot/` types, `src/db/schema.ts` pivot_nodes, pivot_edges, pivot_containers, pivot_beacons, blueprint_snapshots; `pivot-service.ts`; wired in blueprint_handlers (refresh-from-code and setBlueprint persist nodes/edges and snapshots).
- **Stage 4 — Clustering:** `src/lib/pivot/clustering.ts` AI clustering into 5–8 containers; blueprint:cluster IPC; "Cluster" button in Blueprint editor.
- **Stage 5 — Analysis layer:** `src/lib/pivot/analysis/` SonarQube (env: SONAR_URL, SONAR_TOKEN), Semgrep CLI, SCIP placeholder; pivot:run-analysis IPC; "Analysis" panel in Blueprint.
- **UI:** Live vs Blueprint comparison (Compare button), Generate Code (existing Generate button), blueprint undo stack and History (snapshots restore).
