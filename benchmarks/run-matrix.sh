#!/bin/bash
# Terminal-Bench 4.0 for every (model x harness), then collect results.
# Harnesses: atlarix / opencode / pi — each via an import-path adapter that
# starts an IN-CONTAINER pin proxy (benchmarks/pin-proxy.mjs) on localhost and
# points the harness at it. The proxy injects the OpenRouter provider/quant pin
# and forwards to openrouter.ai, so the backend is IDENTICAL for every request —
# the harness is what's under test.
#
# Why in-container: Daytona task sandboxes enforce an egress allow-list
# (github / npm / openrouter.ai reachable; arbitrary proxy hosts get RST), so a
# hosted proxy is unreachable. The proxy therefore runs on localhost in each
# task container and forwards to openrouter.ai. The real benchmark key reaches
# only the proxy process env (via OPENROUTER_API_KEY forwarded by the adapter);
# the harness authenticates to localhost with a dummy key.
#
# Prereqs (run from repo root):
#   set -a; source scripts/.env; set +a              # OPENROUTER_API_KEY, DAYTONA_*
#   source .bench-venv/bin/activate                  # harbor + atlarix_tb importable
#   bash Atlarix/benchmarks/run-matrix.sh
#
# Env knobs:
#   BENCH_MODELS  default "deepseek/deepseek-v4-flash minimax/minimax-m3"
#   BENCH_EFFORT  default "max" (the level every leaderboard entry runs)
#   BENCH_CONCURRENCY default 4   (use 32 with BENCH_EXTRA="-e daytona")
#   BENCH_EXTRA   extra harbor flags, e.g. "-e daytona" or a SMOKE "-i terminal-bench/fix-git -l 1"
#   BENCH_RESULTS default ./results   HARBOR_BIN default harbor
set -euo pipefail
: "${OPENROUTER_API_KEY:?set OPENROUTER_API_KEY (set -a; source scripts/.env; set +a)}"

HARBOR="${HARBOR_BIN:-harbor}"
# 4.0 is the current dataset and the only one the leaderboard tracks. Scores are
# NOT comparable to 2.x: 4.0 recalibrated task resources, removed saturated
# tasks and standardised an 8-hour agent timeout. Pinned rather than @latest so
# a mid-run dataset bump cannot make two cells of the same matrix incomparable.
DATASET="${BENCH_DATASET:-terminal-bench/terminal-bench@4.0.0}"
N="${BENCH_CONCURRENCY:-4}"
EXTRA="${BENCH_EXTRA:-}"
RESULTS="${BENCH_RESULTS:-results}"
# V4 Flash supersedes V4 Pro on agentic work at a third of the price, and it is
# the open-weight question nobody has answered on 4.0 — so it leads.
read -ra MODELS <<< "${BENCH_MODELS:-deepseek/deepseek-v4-flash minimax/minimax-m3}"

# run <canonical-model> <harness> <harbor-model-string> [extra harbor args...]
run() {
  local model="$1" harness="$2" hmodel="$3"; shift 3
  local jobs="$RESULTS/${model//\//_}/$harness"
  mkdir -p "$jobs"
  echo "=== $harness × $model  (-m $hmodel, n=$N, via proxy) ==="
  # `--ak reasoning_effort=max` is how the board configures every entry it
  # lists. Without it the harness dispatches a notch below the model's ceiling
  # and the comparison measures a handicap rather than the harness.
  "$HARBOR" run -d "$DATASET" -m "$hmodel" -o "$jobs" -n "$N" \
    --ak "reasoning_effort=${BENCH_EFFORT:-max}" -y $EXTRA "$@"
}

for model in "${MODELS[@]}"; do
  # atlarix: AtlarixPinnedAgent subclasses Harbor's built-in `atlarix`, starting
  #   the in-container proxy and redirecting the parent at it via a custom
  #   OpenAI-compatible endpoint. -m openai/<slug> -> model=<slug> (the proxy
  #   matches the bare slug). Install is `npm i -g atlarix`, inherited upstream.
  run "$model" atlarix  "openai/$model"  --agent-import-path atlarix_tb:AtlarixPinnedAgent

  # opencode: BenchOpenCodeAgent starts the in-container proxy and registers a
  #   `bench` openai-compatible provider pointing at it (chat/completions, not
  #   the Responses API). -m bench/<slug> -> opencode sends the bare slug.
  run "$model" opencode "bench/$model" --agent-import-path atlarix_tb.opencode_proxy:BenchOpenCodeAgent

  # pi: BenchPiAgent starts the in-container proxy and writes ~/.pi/agent/models.json
  #   (provider "bench" -> localhost proxy). -m bench/<slug> -> --provider bench --model <slug>.
  run "$model" pi       "bench/$model"  --agent-import-path atlarix_tb.pi_proxy:BenchPiAgent
done

node "$(dirname "$0")/collect-results.mjs" "$RESULTS"
