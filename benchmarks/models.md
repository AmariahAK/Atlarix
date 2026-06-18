# Benchmark models & OpenRouter pinning

The harness comparison fixes the model and pins the backend so only the harness
varies. Two models (Atlarix Core tiers 3 & 4):

| Core tier | Model | OpenRouter slug |
|---|---|---|
| Core 3 | DeepSeek V4 Pro | `deepseek/deepseek-v4-pro` |
| Core 4 | MiniMax M3 | `minimax/minimax-m3` |

(Core 1 = `moonshotai/kimi-k2.7-code`, Core 2 = `qwen/qwen3.7-plus` — add later if desired.)

## Pinning the provider + quant (identical backend across harnesses)

OpenRouter routes a model across multiple backends/quants unless constrained.
Pin it **two ways**:

1. **Key-level (uniform, primary).** In the OpenRouter dashboard, on the API key
   you'll use for the benchmark, set provider preferences: allow **one** provider,
   **disable fallbacks**, and (if offered) lock the quantization. This applies to
   every request from pi, opencode, and Atlarix — regardless of what each CLI
   exposes. Confirm each model's available providers + quant on its OpenRouter
   model page first (e.g. DeepInfra is FP4; pick deliberately).

2. **Per-request (belt-and-suspenders, where supported).**
   - **Atlarix:** `ATLARIX_OPENROUTER_PROVIDER_JSON='{"order":["deepinfra"],"allow_fallbacks":false,"quantizations":["fp8"]}'` → sent as `providerOptions.openrouter.provider`.
   - **opencode:** set the equivalent provider routing in opencode's config.
   - **pi:** rides the key-level pin (it natively uses OpenRouter; confirm whether `pi-mono` exposes a per-request provider block).

Set `BENCH_MODELS="deepseek/deepseek-v4-pro minimax/minimax-m3"` (default) and
`OPENROUTER_API_KEY` to the pinned key. MiniMax M3's open weights weren't public
at launch; it's API-available, so this benchmark (API-only) is unaffected — the
provider list may be thin, which makes pinning trivial.
