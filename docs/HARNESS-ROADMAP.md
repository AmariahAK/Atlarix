# Atlarix Harness Roadmap

Seam-grounded follow-ups from the harness review (see `HARNESS-COMPARISON.md`).
Scoped to **local / free** approaches — no cloud or server-side agents. Items the
user explicitly de-scoped (approval-triage/Guardian, per-model system prompts,
whole-harness swapping) are intentionally omitted.

_Updated 2026-06-13. Shipped-this-pass items are marked ✅ for context._

## Shipped this pass
- ✅ **Windows AppContainer sandbox** — `native/atlarix-sandbox/` (Rust) + CI build/sign + bundling. _Pending first validation on a Windows CI build (authored on macOS)._
- ✅ **Parallel writing sub-agents** — `task({ write: true })` in an isolated git worktree; diff returned for review+apply.
- ✅ **Microcompact** — no-LLM stale-tool-output drop in `runSteppedCompaction`.
- ✅ **Blueprint Tier-1** — RRF + field reweight + structural proximity.
- ✅ **Model2Vec foundation** — tested embedding/fusion core + setting + fetch/bundle wiring (default-off).
- ✅ **Browser session-recording artifact**; **keep-awake setting**; **concurrent-session** verification.

## Completion steps for foundations shipped this pass

### Model2Vec semantic recall — wire the live lane
Foundation done (`src/lib/search/static-embeddings.ts`, tested). Remaining:
1. `npm run fetch-model2vec` to obtain `potion-code-16M`; validate the file bundles via `extraResource`.
2. Implement the production `StaticEmbeddingModel` (load `model.safetensors` table + the HF `tokenizer.json`). Preferred: compile `model2vec-rs` → WASM (bundles tokenizer + inference, cross-platform, pairs with the Rust toolchain added for the sandbox); fallback: JS inference + a HF-tokenizer lib.
3. At BM25 index build (`bm25_semantic_index.ts`), compute + cache a per-symbol embedding; refresh incrementally on the file-watcher dirty flag.
4. In the grep reranker (`grep-blueprint-reranker.ts`) and slice ranker, add the embedding ranking as a third list in `fuseRankedLists` — gated on `settings.semanticRecall` + `hasStaticEmbeddingModel()`.
5. Validate accuracy (fuzzy NL query retrieves the right symbol where pure BM25 missed) on a real build, then flip the default on.

### Windows sandbox — validate on a Windows build
The crate compiles + ACL/AppContainer behavior must be verified on `windows-latest` (the macOS host can't). Run `native/atlarix-sandbox/README.md`'s test matrix; budget one iteration for exact `windows`-crate signatures / ACL inheritance.

## Other local follow-ups

### Blueprint Tier-1 — query-intent routing (deferred)
Add a `classifyQueryIntent()` pre-step in `bm25_semantic_index.ts` ("where do we handle…" → boost `handle*` names; "what imports…" → structural mode). Deferred this pass because the name-weight bump already captures much of it; revisit if NL-intent queries still under-recall.

### Mid-loop microcompact (native tool pairing)
`runSteppedCompaction` now microcompacts (string representation). The mid-loop path (`compactAgenticMessagesIfNeeded`, native tool-role messages) can't surgically drop a tool result without orphaning its `tool_call` and breaking provider pairing. To microcompact there: drop matched tool-call ⊕ tool-result PAIRS together (not individual results), then re-validate native history. Larger change; the head-summary it does today is correct in the meantime.

### Removals (sequenced — coupled, do as a focused pass)
`cost`/`ToolCategory` are still consumed by the capability-trim stage and exist to cap tools for weak/local models (the open-weight models we champion), so removing them is **not** free cleanup. Sequence, each behind its own change + green `npm test` + integration check:
1. Decide whether weak/local models still benefit from tool-capping at 22 tools (measure first — don't assume "pointless").
2. If removing: delete the capability-trim stage in `resolve-toolset.ts` (Stage 3, `trimToolsForCapability`/`getCapabilityProfile`) + its threading in `mode-tool-registry.ts`, `tool-model-output.ts`, `chat_stream_handlers.ts`, and `model-capability-profile.test.ts`.
3. Then drop `cost` (read in `src/lib/tools/index.ts` `totalCost`) + `ToolCategory` from `registry.ts` and every tool definition.
4. Separately: evaluate replacing `maybeTruncateToDisk` with plain offset-paging (keep if it still guards large `read_file`/`grep` outputs).

### Verifiable artifacts — renderer surfacing
The browser recorder + walkthrough exist and ride along with screenshots. A thin follow-up: a dedicated renderer artifact card (like plan cards) and an end-of-turn surfacing of the walkthrough independent of a screenshot.

### Open-model eval suite (the keystone)
Still the highest-leverage item for the "frontier open-weight harness" claim: real SWE-style tasks run THROUGH Atlarix on DeepSeek/Qwen/Kimi/MiniMax, published, to convert the positioning into measured proof. Extends `tests/agent-evals`.
