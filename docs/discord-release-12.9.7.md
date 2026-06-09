# Atlarix v12.9.7 — Discord technical post

> Paste-ready for the announcements channel. Quality fix for question rendering + a de-hardcoding sweep.

---

**Atlarix v12.9.7 released** 🗳️

Release notes (technical):

- **Question options render correctly again.** When a model emitted choices as the Anthropic-native `options: [{ label, description }]` objects (seen with **minimax** over OpenRouter), the normalizer did `String(x)` on each → `"[object Object]"`, and the Set-dedup then collapsed them all to a single bogus choice. (The question text was always fine — only the options broke, and only for some models, which is why it was inconsistent: deepseek's `{question, options:[strings]}` nesting worked.) `coerceStringArray` now pulls a label (`label ?? value ?? title ?? name ?? text ?? option`) from object options first. The normalizer is now model-agnostic: the question resolves from alias fields (`question/prompt/text/header/title/label`), options also accept `answers`, and a missing question synthesizes a generic title instead of letting options leak into the headline.

- **Token-usage % uses the model's real context window.** The proposal handler hardcoded a `Math.min(getContextWindow(), 100_000)` cap — the only caller that clamped — so the logged percentage was wrong and the "summarize in a new chat" nudge fired far too early for >100K models. Now uses the real per-model window (and the per-chat captured window for Compass). Display/suggestion only; it never gated real dispatch.

- **De-hardcoding sweep (internal).** Modernized the catalog-miss context heuristics that feed compaction/budgeting — deepseek 16K→128K, qwen 32K→128K, llama/mistral 8K→128K, added minimax→1M, unlisted floor 16K→128K (they were wildly low for today's models). Unified the tier-limit fallbacks (100K/200K split → single 200K) and the delegation fallback (32K→128K). Live OpenRouter limits are unchanged; compaction tuning knobs were audited and intentionally left alone.

Downloads: **atlarix.dev**. Full changelog: `docs/CHANGELOG.md`.
