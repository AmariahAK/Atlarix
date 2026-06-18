#!/bin/bash
# Terminal-Bench 2.1 for every (model × harness), then collect results.
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
#   export ATLARIX_HEADLESS_TARBALL_URL=…             # atlarix headless bundle
#   bash Atlarix/benchmarks/run-matrix.sh
#
# Env knobs:
#   BENCH_MODELS  default "deepseek/deepseek-v4-pro minimax/minimax-m3"
#   BENCH_CONCURRENCY default 4   (use 32 with BENCH_EXTRA="-e daytona")
#   BENCH_EXTRA   extra harbor flags, e.g. "-e daytona" or a SMOKE "-i terminal-bench/fix-git -l 1"
#   BENCH_RESULTS default ./results   HARBOR_BIN default harbor
set -euo pipefail
: "${OPENROUTER_API_KEY:?set OPENROUTER_API_KEY (set -a; source scripts/.env; set +a)}"

HARBOR="${HARBOR_BIN:-harbor}"
DATASET="${BENCH_DATASET:-terminal-bench/terminal-bench-2-1}"
N="${BENCH_CONCURRENCY:-4}"
EXTRA="${BENCH_EXTRA:-}"
RESULTS="${BENCH_RESULTS:-results}"
read -ra MODELS <<< "${BENCH_MODELS:-deepseek/deepseek-v4-pro minimax/minimax-m3}"

# run <canonical-model> <harness> <harbor-model-string> [extra harbor args...]
run() {
  local model="$1" harness="$2" hmodel="$3"; shift 3
  local jobs="$RESULTS/${model//\//_}/$harness"
  mkdir -p "$jobs"
  echo "=== $harness × $model  (-m $hmodel, n=$N, via proxy) ==="
  "$HARBOR" run -d "$DATASET" -m "$hmodel" -o "$jobs" -n "$N" -y $EXTRA "$@"
}

for model in "${MODELS[@]}"; do
  [ -n "${ATLARIX_HEADLESS_TARBALL_URL:-}" ] || echo "WARN: ATLARIX_HEADLESS_TARBALL_URL unset — atlarix cell will fail to install" >&2

  # atlarix: AtlarixAgent starts the in-container proxy and points headless at
  #   it via --provider-url (custom OpenAI-compatible). -m openai/<slug> ->
  #   model=<slug> (the proxy matches the bare slug).
  run "$model" atlarix  "openai/$model"  --agent-import-path atlarix_tb:AtlarixAgent

  # opencode: BenchOpenCodeAgent starts the in-container proxy and registers a
  #   `bench` openai-compatible provider pointing at it (chat/completions, not
  #   the Responses API). -m bench/<slug> -> opencode sends the bare slug.
  run "$model" opencode "bench/$model" --agent-import-path atlarix_tb.opencode_proxy:BenchOpenCodeAgent

  # pi: BenchPiAgent starts the in-container proxy and writes ~/.pi/agent/models.json
  #   (provider "bench" -> localhost proxy). -m bench/<slug> -> --provider bench --model <slug>.
  run "$model" pi       "bench/$model"  --agent-import-path atlarix_tb.pi_proxy:BenchPiAgent
done

node "$(dirname "$0")/collect-results.mjs" "$RESULTS"
