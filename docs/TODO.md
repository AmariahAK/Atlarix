# Atlarix TODO

**Current Version:** v11.0.0 (unreleased)
**Last Updated:** 2026-06-05

---

## v12 — Hardening & Core-Loop Rewrite (roadmap)

> **Goal:** close the gap between Atlarix and a real AI IDE (Cursor / Claude Code / opencode / Codex / Antigravity) where any model is brought into a workspace and *just works*. This register is grounded in two long build sessions, three parallel audits (defect sweep, opencode/Claude-Code reference extraction, test-suite audit), and direct spot-verification. References live in `atlarix-references/opencode` and `atlarix-references/claude-code`.
>
> **Session 1 (2026-06-05) SHIPPED: the Tier 4 agent-eval harness + quick wins 1.1 / 1.4 / 2.4.** **Session 2 (2026-06-05) SHIPPED: 0.2 native tool-call history + multimodal tool results (build mode)** — see the session tables below. Next session: **0.1 loop unification** behind a flag, mode-by-mode, with the harness asserting parity (fold in the agent-path findings).

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
- Loop structure: `chat_stream_handlers.ts` is **7,428 lines** with divergent per-mode handling (agent / ask / build / chat-only). Literal `while(true)` count is 2, but the mode branches each re-implement tool execution, ask_user, abort, and history-shaping — the "4 divergent paths" liability is real.

---

### TIER 0 — The four foundations (everything else is downstream; order = dependency order)

#### 0.1 Unify the agent loop (the #1 liability)
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

#### 0.3 Edit-reliability + auto-verify layer (what makes Cursor feel magic)
- **Problem:** the edit tool has fuzzy matching but it's silent; on no-match it just errors. There is **no post-edit verification loop** — `enableAutoFixProblems` is dead, no `tsc`/LSP diagnostics fed back after a write. For a "bring any AI" product this is fatal: cheap models *feel* broken in Atlarix and fine in Cursor — same model, different apply layer.
- **Target:** (a) surface fuzzy-match drift to the model ("applied with whitespace tolerance at line N" so it can self-correct); (b) **wire `enableAutoFixProblems`** — after a write in build/debug, run LSP diagnostics on the touched file and feed errors back into the loop as a tool result (model fixes before claiming done); (c) make "edit → run/typecheck → observe → fix" the loop's default posture, not a bolt-on. Ref: Claude Code Edit exact-match + structured retry guidance; opencode LSP-after-edit.
- **Files:** `src/lib/tools/edit.ts` (drift signal), new `src/lib/agent/post-edit-verify.ts`, wire into 0.1, reuse `src/lib/lsp/lsp-client.ts`.

#### 0.4 Single message store + structured tool contracts
- **Problem:** dual store — ephemeral negative-numeric-id (in-memory) + session UUID DB — synced by convention (`computeSessionEditTarget` edit-by-ordinal, ids regenerate on rehydrate, summary persistence had to dodge ids). Every seam is a future "lost/duplicated/wrong-resume message" report. Plus string-marker contracts (`__ask_user`, `__permission_required`, `<task_complete>`, `[COMPACTION MARKER]`, `atlarix-*` content tags) — we already fixed one marker-escaping bug; the whole class is fragile.
- **Target:** one store, one id space (opencode: Drizzle MessageTable + PartTable, load once per turn, no mid-stream DB writes); replace string markers with a structured stream-event/part type. Ref: opencode `message-v2.ts`, `processor.ts` part model.
- **Files:** `src/lib/ephemeral-chat.ts`, `src/ipc/handlers/workspace_session_handlers.ts`, `src/db/schema.ts`, marker producers/parsers across the stream handler.

---

### TIER 1 — Critical correctness bugs (fix regardless of Tier 0)

| # | Issue | Evidence | Fix direction |
|---|-------|----------|---------------|
| 1.1 | ✅ **DONE (session 1)** — dual compaction implementations | root file deleted; exports folded into `context/compaction.ts` | — |
| 1.2 | **`enableAutoFixProblems` setting has no logic** — UI toggle exists (`AutoFixProblemsSwitch.tsx`), nothing reads it in the loop | `schemas.ts:420`, `main/settings.ts:83` | Wire it (see 0.3) or remove. Don't ship a lying toggle. |
| 1.3 | ✅ **DONE (session 2)** — browser screenshot invisible to the model | media content part via `toModelOutput` on vision providers; text fallback elsewhere; also fixed disk-truncation corrupting the base64 | — |
| 1.4 | ✅ **DONE (session 1)** — silent fuzzy edits | drift notice in tool result (`preview.notice` → exec `output`) + card description, with matched line number | — |
| 1.5 | **Aux Compass usage recorded fire-and-forget** — limit-hit only warns to log, turn already ended | `chat_stream_handlers.ts:~6784` | Await + surface a visible notice on `limit_exceeded` (the per-step path is strict in v11; aux path still leaks). |
| 1.6 | **Ask-tier loads 31 tools for every model** — weak/local models drown | `chat_stream_handlers.ts:~4079` ("Ask tier: 31 tools") | Capability-profile per model (2.1); shrink toolset + simplify schemas for low-capability models. |

---

### TIER 2 — High-value gaps (reliability & "any AI" support)

- **2.1 Model-capability adaptation.** No per-model profile. "Any AI" needs tool-count cap, schema simplification, output-format strictness, native-tool-support flag per model; strong models get the full surface, 7B local models a trimmed/guided set. Ref: opencode `SessionTools.resolve`, models.dev catalog. → new `src/lib/routing/model-capability-profile.ts`.
- **2.2 Permission model → structured rulesets.** Gating is scattered (`runCommandGateResult`, env-secret blocks, per-tool consent); no unified allow/deny/ask ruleset, no glob patterns, no hooks. Ref: Claude Code `settings.json` permissions (`Bash(rm*)`, `Read(~/*.env)`) + `hookify` PreToolUse/PostToolUse; opencode `permission.ts` ruleset merge. → `src/lib/tools/permissions/*` + a hooks layer. Subsumes the security items in Tier 3.
- **2.3 Background / parallel agents (the differentiator).** Atlarix positions as chat-first mission-control (Antigravity's "manager" angle) but has no background/parallel execution. Ref: Claude Code background sessions + worktrees + `agents` view + resume. **Depends on 0.1 + 0.4.**
- ✅ **2.4 Memory-leak cleanups — DONE (session 1).** `sessions:delete` prunes ephemeral chat + main stream maps and returns `streamChatId`; renderer `clearChatAtomsForChat` clears per-chat/per-message jotai state + activity rows. Pinned by the `session-delete-cleanup` eval.
- **2.5 Verification culture by default.** Loop trusts `<task_complete>`; `runAutonomousBuildVerificationAfterTaskComplete` is an after-the-fact bolt-on. Make bounded auto-verify (typecheck after writes, run the touched test, hit the dev-server route) loop-native. Folds into 0.3.
- **2.6 Settings that do nothing.** Schema defines `delegation`, `autonomous`, `counsel`, `agentLightning`, `selfReview`, `contextSummarization`, `projectUnderstanding`, `activityStream`, `experiments` — most read in isolated spots or not enforced. Grep each, classify enforced vs dead, wire-or-remove. Don't ship lying knobs. → `src/lib/schemas.ts:156-232`.
- **2.7 Feature-breadth freeze + dead-code purge.** Repo carries half-finished systems (counsel, delegation, agent-lightning, blueprint codegen). Freeze new surfaces until Tier 0 is solid; delete (not disable) what doesn't serve edit→verify→continue.

---

### TIER 3 — Medium correctness & polish (batchable)

- **3.1** `questionId`/ephemeral ids use `Date.now()` → ms collision risk; switch to `crypto.randomUUID()` / monotonic counter. (`chat_stream_handlers.ts:899`, `ephemeral-chat.ts:71`)
- **3.2** Empty catch blocks hiding real failures (`workspace-analyzer.ts:206-266` — 8 silent catches; assorted `.catch(() => {})` around persistence). Add debug logging + error collection.
- **3.3** `computeSessionEditTarget` returns null silently at the window boundary → edit appears applied (ephemeral) but DB unchanged → resume diverges. Add user-facing failure. (`workspace_session_handlers.ts:95-110`)
- **3.4** Context-overflow regex (v11.1) is string-match fragile; prefer provider error codes where the SDK exposes them, regex as fallback. (`isContextOverflowError`, now in `context/compaction.ts`)
- **3.5** `executeJavaScript(script, true)` in browser tools builds scripts from model input — selectors/values ARE `JSON.stringify`-escaped via the template; document the trust boundary, consider a restricted DOM API over raw eval. (`browser.ts` click/fill/read)
- **3.6** `runCommandGateResult` doesn't validate `workMode` — fail-closed on invalid. (`chat_stream_handlers.ts:282`)
- **3.7** Unhandled `void` promises that mutate state (self-correction dispatch in `setImmediate`, summary persistence) — track + drain on shutdown.
- **3.8** Stale `displaySnapshot` not cleared on ephemeral edit/remove. (`ephemeral-chat.ts:128-159`)
- **3.9** Unused tool `cost` field — use it (weight toolset/log) or remove. (`tools/index.ts:63`)
- **3.10** Consolidate tool-availability logic split across `ToolManifest.ts` / `mode-tool-registry.ts` / `registry.ts` into one resolution pipeline.

---

### TIER 4 — Test-suite overhaul — **CORE SHIPPED in session 1** (see "v12 session 1" above)

The agent-eval harness, scenario loader, `tests/infra` fixtures, all 6 target evals (+probe/canary/cleanup) and the small DELETE pass landed. Remaining: physically move `src/__tests__` into the target layout, broader trivial-test audit, typecheck coverage for `tests/`+`testing/`, fast-check property tests.

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
4. **0.1 loop unification** behind a flag, mode-by-mode, evals asserting parity ← **next session starts here** — fold in the session-1 agent-path findings (double-dispatch, missing workspace injection, mid-round correction injection) and extend native history to ask/agent/chat-only via the unified engine.
5. **0.4 single store** + structured contracts.
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

1. **Edge resolution must respect `tsconfig.json` paths + `package.json` exports/imports BEFORE relative fallback** (`src/lib/blueprint/rte/.../resolve-edges.ts`). The resolver only tries hard-coded relative extensions, so **alias imports (`@/lib/...`) resolve to nothing → cross-module edges silently dropped.** *Atlarix's own repo proves this* — run `get_blueprint` on it and most connectivity is missing. For a structural-graph retriever, missing edges = the model follows dead ends and over-reads to compensate (the token bloat). **This is the #1 accuracy fix.**
2. **Fuse the existing BM25 index into `get_blueprint` slice ordering** (`bm25_semantic_index.ts` lives only on the `search` path today). Rank rooms/functions by relevance to `focus_path`/`topic`/query × centrality; return top-N, summarize the tail (`+14 more rooms: payments, auth…`). This is the **"relevant structure"** differentiator (embeddings give relevant chunks with no structure; ranked-Blueprint gives both) AND it answers "don't overwhelm" — fewer, better nodes at the same cap, model lands in 1–2 calls not 6.
3. **Emit ctags `signature` per function, not bare names** — the signature is already in the symbol index. `` `sendEmail(to, subject, body)` `` vs `` `sendEmail` `` is ~same tokens but lets the model pick the right function *without an extra `read_file`*. Free signal density. (Same for one-line JSDoc `simpleDescription`; skip AI-generated ones to stay cheap.)
- **Secondary:** centrality-aware BFS (prefer high-fan-in core modules when expanding depth so the slice doesn't balloon); edge **confidence** (`call`-confirmed vs `import`-inferred so the model trusts confirmed, treats inferred as hints → fewer dead-end reads); truncate at **room boundaries**, never mid-room.
- **Measure it (ties to Tier 4):** add a retrieval eval — **precision@1** (did the first `get_blueprint`/`search` land on the file the task needs?) and **calls-to-target** — vs the embedding baseline. Turns "~parity" into "measurably better" and is the natural second paper.
- **Weak spots also noted** (lower priority, from a full subsystem audit): brittle `getRoomKey` collapses `src/api/v1/handlers/auth.ts` → "api" (loses granularity); dynamic calls (`obj[fn]()`) dropped silently; BM25 `name:4` weight lets generic names (`handle`/`process`) dominate; thin-graph threshold (15 fns) too aggressive for well-modularized Python; structural-scan worker crashes lose batch edges silently; no slice cache for `(focus_path, topic, depth)`.

---

### TIER 7 — Standing Workspace (make it yours, shareable, trustworthy)

What separates "an app you point at a folder" from "a workspace that's *yours*." **Strength already present:** `.atlarix/` is a committable, portable config (memory.md, ATLARIX.md rules, blueprint.json, skills/, plans/, snapshots/, reference-projects.json, training_data/) — a foundation Cursor lacks. The gaps complete it:

- **A. User-definable agents (the identity bullseye).** Modes are hardcoded in `mode-tool-registry.ts`. Let users define their own: `.atlarix/agents/<name>.md` = system prompt + tool allowlist + model override. This is literally "configure how AIs work in my space." **Nearly free after 0.1** — it's just an `AgentProfile` loaded from disk. Highest identity-fit.
- **B. Hooks: advisory → enforceable + DB → portable.** A hooks system exists (`src/lib/hooks/hooks-manager.ts`) but is **advisory only** ("Failures are logged only; never thrown"), **DB-stored** (doesn't travel with the repo), triggers only on file-write/run-command, and isn't wired into the main agent tool path. Upgrade to: (1) **blocking** (deny a tool / require a gate, like Claude Code PreToolUse); (2) `.atlarix/hooks/` file-based so a team/clone inherits them; (3) all-tools + lifecycle (`Stop` = "require tests before done", `Prompt`). Lean (regex + shell, no AI) = on-thesis. Subsumes the Tier 2.2 permission-rulesets item.
- **C. Complete & document the portable `.atlarix/` contract.** Unify memory + rules + agents (A) + portable hooks (B) + per-project model/provider prefs into one documented, committable spec so `git clone` → open → identical AI workspace. ~70% there; mostly unification + docs.
- **D. BYOK trust surface.** Show **spend** (per-turn/running cost — exists for Compass, missing for BYOK) and an **inspectable audit** of what the agent did. Bring-any-AI needs spend + action visibility to stand alone.

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
