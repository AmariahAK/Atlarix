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
- ❌ **Model2Vec semantic-recall lane — REMOVED (2026-06-13).** Shipped as an optional embedding fusion, then deleted wholesale. Rationale: on a giant multi-repo it only engaged under a 40K-symbol cap (so it never helped the case it was meant for), added a 62MB model to the bundle, and chased *recall* when the real bottleneck was *token volume / precision*. Our reference agents (claude-code, opencode) carry **no retrieval index at all** — the LLM is already the natural-language layer. We kept the disk-backed FTS5 lexical index + candidate rerank (our genuine edge), made `grep` sharp + zoekt-style symbol-aware instead, and left Blueprint as-is. (Deleted: `model2vec-*`, `static-embeddings`, `searchBlueprintByEmbedding`, the embedding RRF leg, `semanticRecall`, the `emb_src` column, `assets/model2vec`, `fetch-model2vec`.)
- ✅ **snapshotTurnId persistence** (migration 0063) — revert-turn survives a restart.
- ✅ **Removals** — capability-trim stage + `cost` + `ToolCategory` deleted (weak/local models keep schema-simplification, lose only the tool-count cap; golden counts unchanged).
- ✅ **Plan-tool transport rebind** + **ast-grep asar unpack** — both tracked known issues fixed.
- ✅ **Background task agents** — confirmed already functional (`task({ background: true })` + mid-turn injection + keep-awake); low-value restart-persistence polish skipped.

## Completion steps for foundations shipped this pass

### Windows sandbox — validate on a Windows build
The crate compiles + ACL/AppContainer behavior must be verified on `windows-latest` (the macOS host can't). Run `native/atlarix-sandbox/README.md`'s test matrix; budget one iteration for exact `windows`-crate signatures / ACL inheritance.

## Other local follow-ups

### Browser — steer the model to snapshot-first ✅ (done 2026-06-13)
Models were screenshot-hunting (observed: ~180K tokens to find a Sign Up link on an SPA). Fixed: (1) `browser_screenshot` description rewritten to "visual confirmation ONLY — use `browser_snapshot` to find/interact (far cheaper)"; `browser_read_page` clarified as raw-text and `browser_navigate`'s note points at snapshot for interaction (`src/lib/tools/browser.ts`); (2) Browser sections added to the Explore + Build mode skills (`src/skills/modes/{ask,build}-mode.md`) — snapshot → act by ref → screenshot only to verify; (3) the Explore note states clicking/filling needs Build mode (Ask/Explore is read-only by design).

### Blueprint — PARKED, do not touch (2026-06-13)
**The current Blueprint is the best version for models — leave it as-is until further notice.** Audited 2026-06-13: `get_blueprint` is already tight and accurate (40-room cap with summarized tail, 300-line/48 KB markdown cap, BM25 + centrality + proximity room ranking, ~2–4K tokens typical, transparency notes for dropped rooms / dynamic-call gaps). Verified on a real giant multi-repo: retrieval was correct with zero hallucination at ~26K total turn tokens. No accuracy or bloat problem to fix.

Previously-deferred ideas are intentionally NOT being pursued (they'd add complexity for no measured gain): query-intent routing (`classifyQueryIntent()` — the name-weight bump already covers it), and embedding/vector fusion (removed entirely — code retrieval doesn't need it; the LLM is the natural-language layer).

### Mid-loop microcompact (native tool pairing)
`runSteppedCompaction` now microcompacts (string representation). The mid-loop path (`compactAgenticMessagesIfNeeded`, native tool-role messages) can't surgically drop a tool result without orphaning its `tool_call` and breaking provider pairing. To microcompact there: drop matched tool-call ⊕ tool-result PAIRS together (not individual results), then re-validate native history. Larger change; the head-summary it does today is correct in the meantime.

### Removals — ✅ done
Capability-trim stage + `cost` + `ToolCategory` removed (`resolve-toolset.ts`, `model-capability-profile.ts` `trimToolsForCapability`, `registry.ts`, ~14 tool defs, tests). Weak/local models keep `getCapabilityProfile` + `simplifyToolParametersForProfile`. Open follow-up: evaluate replacing `maybeTruncateToDisk` with plain offset-paging (kept — still guards large `read_file`/`grep` outputs).
4. Separately: evaluate replacing `maybeTruncateToDisk` with plain offset-paging (keep if it still guards large `read_file`/`grep` outputs).

### Verifiable artifacts — renderer surfacing
The browser recorder + walkthrough exist and ride along with screenshots. A thin follow-up: a dedicated renderer artifact card (like plan cards) and an end-of-turn surfacing of the walkthrough independent of a screenshot.

### Open-model eval suite (the keystone)
Still the highest-leverage item for the "frontier open-weight harness" claim: real SWE-style tasks run THROUGH Atlarix on DeepSeek/Qwen/Kimi/MiniMax, published, to convert the positioning into measured proof. Extends `tests/agent-evals`.
