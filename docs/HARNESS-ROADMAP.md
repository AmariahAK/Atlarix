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
- ✅ **Browser session-recording artifact**; **keep-awake setting**; **concurrent-session** verification.

## Shipped in the backlog pass (2026-06-13)
- ✅ **Model2Vec live semantic-recall fusion** — pure-JS BERT WordPiece loader (`model2vec-loader.ts`, validated vs the real `potion-code-16M`: correct tokenization, normalized 256-d vectors, related-code > unrelated cosine) → per-doc embeddings at index build → `searchBlueprintByEmbedding` → 3rd RRF list in the grep reranker. Gated behind `semanticRecall` (default OFF). **Remaining: validate retrieval gains on a real workspace build, then flip the default on.** No new dependency; model is a `npm run fetch-model2vec` artifact (~64MB) bundled when present.
- ✅ **snapshotTurnId persistence** (migration 0063) — revert-turn survives a restart.
- ✅ **Removals** — capability-trim stage + `cost` + `ToolCategory` deleted (weak/local models keep schema-simplification, lose only the tool-count cap; golden counts unchanged).
- ✅ **Plan-tool transport rebind** + **ast-grep asar unpack** — both tracked known issues fixed.
- ✅ **Background task agents** — confirmed already functional (`task({ background: true })` + mid-turn injection + keep-awake); low-value restart-persistence polish skipped.

## Completion steps for foundations shipped this pass

### Model2Vec — flip default-on after real-build validation
The lane is wired + inference-verified, but `semanticRecall` stays OFF until end-to-end retrieval gains are confirmed on a real workspace (a fuzzy NL query retrieving the right symbol where pure BM25 missed). Also measure the index-build embedding latency on a large repo. Then default it on. The slice ranker (`blueprint-slice.ts`) could also fuse the embedding signal (only the grep reranker does today).

### Windows sandbox — validate on a Windows build
The crate compiles + ACL/AppContainer behavior must be verified on `windows-latest` (the macOS host can't). Run `native/atlarix-sandbox/README.md`'s test matrix; budget one iteration for exact `windows`-crate signatures / ACL inheritance.

## Other local follow-ups

### Browser — steer the model to snapshot-first (TODO, agreed 2026-06-13)
The `browser_snapshot`/ref tools exist + are in the Ask allowlist, but **no prompt tells the model to use them**, so models default to screenshot-hunting (observed: ~180K tokens to find a Sign Up link on an SPA). Do: (1) rewrite `browser_screenshot`'s description to "visual confirmation ONLY — use `browser_snapshot` to find/understand interactive elements (far cheaper)"; (2) add a short browser-usage note to the mode guidance ("snapshot → act by ref → screenshot only to verify"); (3) consider surfacing in a build/ask mode skill. Also note for users: **clicking/filling needs Build mode** (Ask/Explore is read-only by design). Rebuild after.

### Blueprint Tier-1 — query-intent routing (deferred)
Add a `classifyQueryIntent()` pre-step in `bm25_semantic_index.ts` ("where do we handle…" → boost `handle*` names; "what imports…" → structural mode). Deferred this pass because the name-weight bump already captures much of it; revisit if NL-intent queries still under-recall.

### Mid-loop microcompact (native tool pairing)
`runSteppedCompaction` now microcompacts (string representation). The mid-loop path (`compactAgenticMessagesIfNeeded`, native tool-role messages) can't surgically drop a tool result without orphaning its `tool_call` and breaking provider pairing. To microcompact there: drop matched tool-call ⊕ tool-result PAIRS together (not individual results), then re-validate native history. Larger change; the head-summary it does today is correct in the meantime.

### Removals — ✅ done
Capability-trim stage + `cost` + `ToolCategory` removed (`resolve-toolset.ts`, `model-capability-profile.ts` `trimToolsForCapability`, `registry.ts`, ~14 tool defs, tests). Weak/local models keep `getCapabilityProfile` + `simplifyToolParametersForProfile`. Open follow-up: evaluate replacing `maybeTruncateToDisk` with plain offset-paging (kept — still guards large `read_file`/`grep` outputs).
4. Separately: evaluate replacing `maybeTruncateToDisk` with plain offset-paging (keep if it still guards large `read_file`/`grep` outputs).

### Verifiable artifacts — renderer surfacing
The browser recorder + walkthrough exist and ride along with screenshots. A thin follow-up: a dedicated renderer artifact card (like plan cards) and an end-of-turn surfacing of the walkthrough independent of a screenshot.

### Open-model eval suite (the keystone)
Still the highest-leverage item for the "frontier open-weight harness" claim: real SWE-style tasks run THROUGH Atlarix on DeepSeek/Qwen/Kimi/MiniMax, published, to convert the positioning into measured proof. Extends `tests/agent-evals`.
