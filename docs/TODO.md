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
S18 tokenizer LRU memo (data-backed by gap attribution), local providers await real windows;
attachments are chat/session-scoped (session UUID primary — no cross-session leaks, survives
relaunches) and edit-resends rebuild the attachment directive + re-embed images.
tsc/oxlint/knip clean; vitest 1658 green; owner-smoked across 4 packaged-app rounds.

Follow-ups deferred: none — W11 escape A/B PASSED in owner smoke (DeepSeek, clean tab-indented
diff); S18 done via tokenizer memo (gap data from the smoke session).

---

## Open follow-ups

- `.gitignore`-render profiler (carried from v14.8.10 §3.4).
- Atlarix GitHub account for contributor credit — owner action; code side done (v14.8.10).
- User-message multimodal content parts for HISTORICAL turns (current + edited turns embed
  since v14.8.11; history still round-trips via read_attachment on tool-media-capable APIs).

> Open work + the current release only. **Full shipped-version history lives in
> [`docs/CHANGELOG.md`](./CHANGELOG.md)** (and `docs/CHANGELOG_PREVIOUS.md`).
