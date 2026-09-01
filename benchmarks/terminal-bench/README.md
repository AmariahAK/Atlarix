# Terminal-Bench 2.1 — Atlarix vs opencode vs pi

Harness comparison on [Terminal-Bench 2.1](https://www.tbench.ai/) via Harbor,
all on the same OpenRouter-pinned model (DeepSeek V4 Pro / MiniMax M3). The model
is fixed; **the harness is what's under test.**

## Setup (once)

```bash
# uv + harbor + Docker (Docker must be running)
curl -LsSf https://astral.sh/uv/install.sh | sh
uv tool install harbor

# pi adapter (third harness) — cloned into ../../../atlarix-references
cd ../../../atlarix-references/pi-terminal-bench && uv venv && source .venv/bin/activate && uv pip install -e ".[dev]"

# Atlarix adapter (this dir) — importable as atlarix_tb:AtlarixAgent
cd -; uv pip install -e .

# Harbor's /tests nesting fix is upstream as of 0.22; this now reports
# "nothing to do" rather than patching. Kept until the floor in pyproject.toml
# is above every Harbor that still had the bug.
python patch-harbor.py
```

## Atlarix headless bundle

Nothing to set up. The agent installs itself in each task container with
`npm i -g atlarix`, so there is no tarball to build, host, or point an environment
variable at. To pin a specific version, pass Harbor's `--agent-version`; unset
resolves `@latest`.

A prebuilt `linux/amd64` tarball still exists on the `headless-bench` prerelease
as a fallback for images where npm can neither find a `better-sqlite3` prebuild
nor compile one (musl/Alpine, an unusual Node ABI). It is not used by this
adapter.

## Keys + pin

```bash
export OPENROUTER_API_KEY="…"   # key with provider prefs locked (see ../models.md)
export ATLARIX_OPENROUTER_PROVIDER_JSON='{"order":["deepinfra"],"allow_fallbacks":false,"quantizations":["fp8"]}'  # optional per-request pin (atlarix)
```

## Smoke (do this before any paid run)

```bash
# Reference solutions — confirms install + Docker:
harbor run --dataset terminal-bench/terminal-bench@4.0.0 --agent oracle --n-concurrent 4

# One real task per harness (~5 min each):
BENCH_EXTRA="--dataset-task-names hello-world --timeout-multiplier 6" BENCH_MODELS="deepseek/deepseek-v4-flash" bash ../run-matrix.sh
```

## Full run + results

```bash
# Local Docker:
bash ../run-matrix.sh
# Or cheap parallelism (API models are I/O-bound):
DAYTONA_API_KEY=… BENCH_EXTRA="--env daytona" BENCH_CONCURRENCY=32 bash ../run-matrix.sh

# Readable table:
node ../collect-results.mjs results/
```

## Notes
- Built-in agents `opencode` / `pi` need no code (pi via `--agent-import-path pi_terminal_bench:PiAgent`). Atlarix = the `atlarix_tb:AtlarixAgent` adapter wrapping the headless bundle.
- With pi (not Claude Code) all three pin the same OpenRouter provider → **clean three-way, no translation asterisk**.
- `agent.py` mirrors `pi-terminal-bench`'s `BaseInstalledAgent`; reconcile hook names against your installed Harbor if its API drifts.
- Keep `-n` and `--timeout-multiplier` identical across harnesses.
