# SWE-bench: cross-harness comparison

Goal: the **same model, different harness** number. Hold the model constant at
**DeepSeek V4 Pro** and vary only the harness, then grade every harness's
predictions with the _one_ official grader (`scripts/swebench-grade.mjs`).

## Model parity (one model, three harnesses)

DeepSeek V4 Pro is reachable on two endpoints with one key:

- OpenAI-compatible: `https://api.deepseek.com` (Atlarix, opencode)
- Anthropic-compatible: `https://api.deepseek.com/anthropic` (Claude Code; `claude-opus-*` → `deepseek-v4-pro`)

## Run each harness

All emit the same `{instance_id, model_patch, model_name_or_path}` JSONL.

**Atlarix** (Core 3 = DeepSeek V4 Pro, _and_ a strict raw-DeepSeek run):

```bash
# As shipped (Core):
ATLARIX_BENCH=1 ATLARIX_BENCH_INSTANCES=swebench_lite.jsonl ATLARIX_BENCH_LIMIT=5 \
ATLARIX_BENCH_API_KEY=$ATLARIX_TOKEN ATLARIX_BENCH_OUT=preds-atlarix-core.jsonl \
npx vitest run --project agent-evals tests/bench/swebench.run.test.ts

# Strict (raw DeepSeek — removes Core routing as a variable):
ATLARIX_BENCH=1 ATLARIX_BENCH_INSTANCES=swebench_lite.jsonl ATLARIX_BENCH_LIMIT=5 \
ATLARIX_BENCH_PROVIDER_URL=https://api.deepseek.com ATLARIX_BENCH_MODEL=deepseek-v4-pro \
ATLARIX_BENCH_API_KEY=$DEEPSEEK_API_KEY ATLARIX_BENCH_OUT=preds-atlarix-deepseek.jsonl \
npx vitest run --project agent-evals tests/bench/swebench.run.test.ts
```

**opencode** (configure a DeepSeek provider in opencode first):

```bash
DEEPSEEK_API_KEY=… OPENCODE_MODEL=deepseek/deepseek-v4-pro \
node benchmarks/swebench/run-opencode.mjs --instances swebench_lite.jsonl --limit 5 --out preds-opencode.jsonl
```

**Claude Code** (DeepSeek via the Anthropic-compatible endpoint — no gateway):

```bash
DEEPSEEK_API_KEY=… \
node benchmarks/swebench/run-claude-code.mjs --instances swebench_lite.jsonl --limit 5 --out preds-claude.jsonl
```

## Grade (one grader, all harnesses)

```bash
node scripts/swebench-grade.mjs preds-atlarix-deepseek.jsonl
node scripts/swebench-grade.mjs preds-opencode.jsonl
node scripts/swebench-grade.mjs preds-claude.jsonl
```

Requires Docker + `pip install swebench`. Report each harness's **% resolved**
on the same instance set — that delta is the apples-to-apples result.

## Notes

- Use the **same** `--instances` file and `--limit` for every harness.
- `lib.mjs` excludes each harness's own scratch files (`.atlarix/`, `.opencode/`,
  `CLAUDE.md`, `.claude/`) so patches are code-only.
- CLI flags for opencode / Claude Code vary by version — adjust the `execFileSync`
  invocation in each runner if your installed version differs.
