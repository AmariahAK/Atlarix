# Atlarix benchmarks

Apples-to-apples **harness** comparison — **Atlarix vs opencode vs pi** — on a
**fixed, OpenRouter-pinned model** (DeepSeek V4 Pro & MiniMax M3). The model and
provider are held constant; the harness is the only variable.

- **`models.md`** — the two models + how to pin the OpenRouter provider/quant.
- **`terminal-bench/`** — Terminal-Bench 2.1 via Harbor (the primary, terminal-first benchmark). Atlarix adapter + pi + opencode.
- **`swebench/`** — SWE-bench Lite cross-harness wrappers (secondary).
- **`run-matrix.sh`** — runs every (model × harness) TB cell → `results/<model>/<harness>/`.
- **`collect-results.mjs`** — parses Harbor `result.json` → `results/summary.md` + `summary.csv`.

## What you need
- **Docker** running.
- **Harbor**: `uv tool install harbor`.
- **One `OPENROUTER_API_KEY`** with provider preferences locked (this is how all three harnesses share an identical backend/quant — see `models.md`).
- Nothing to host for Atlarix: the adapter installs it with `npm i -g atlarix`.
- Optional **`DAYTONA_API_KEY`** for cheap high-concurrency runs.
- The pi adapter (`atlarix-references/pi-terminal-bench`) + this repo's `terminal-bench/` adapter installed; Harbor's `upload_dir` fix is upstream as of 0.22, so no patch is needed.

## Run it (short version)
```bash
# 1. setup + patch (see terminal-bench/README.md)
# 2. (nothing to do for Atlarix — the adapter npm-installs it in each container)
# 3. export OPENROUTER_API_KEY (pinned)
# 4. smoke one task per harness:
BENCH_EXTRA="--dataset-task-names hello-world --timeout-multiplier 6" BENCH_MODELS="deepseek/deepseek-v4-flash" bash benchmarks/run-matrix.sh
# 5. full matrix (89 tasks × 3 harnesses × 2 models):
bash benchmarks/run-matrix.sh           # or DAYTONA_API_KEY=… BENCH_EXTRA="--env daytona" BENCH_CONCURRENCY=32 …
# 6. read results/summary.md
```

## From there
Publish `results/summary.md` with the framing: *fixed model, fixed provider,
fixed params — the harness is what's measured.* opencode is the cleanest
head-to-head (both native-FC, same pinned backend); pi is the third clean point
(no translation asterisk, unlike a Claude-Code route would have). Report two
Atlarix angles if useful: Core 3/4 as shipped vs raw OpenRouter — they're the
same weights here, so they should match.
