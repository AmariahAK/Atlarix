#!/usr/bin/env node
/**
 * SWE-bench runner for opencode (model-agnostic, so we point it at DeepSeek V4
 * Pro via its OpenAI-compatible endpoint for parity with Atlarix).
 *
 * Prereqs: opencode installed (`OPENCODE_BIN`, default `opencode`); a DeepSeek
 * key in `DEEPSEEK_API_KEY`. opencode reads providers from its own config —
 * configure a DeepSeek provider (base_url https://api.deepseek.com) and set
 * `OPENCODE_MODEL` (e.g. `deepseek/deepseek-v4-pro`).
 *
 * Usage:
 *   DEEPSEEK_API_KEY=… OPENCODE_MODEL=deepseek/deepseek-v4-pro \
 *   node benchmarks/swebench/run-opencode.mjs --instances swebench_lite.jsonl --limit 5 --out preds-opencode.jsonl
 *   node scripts/swebench-grade.mjs preds-opencode.jsonl
 */
import { execFileSync } from "node:child_process";
import {
  loadInstances,
  prepareRepo,
  capturePatch,
  openPredictions,
  parseArgs,
} from "./lib.mjs";

const args = parseArgs();
if (!args.instances)
  throw new Error("--instances (or SWEBENCH_INSTANCES) is required");

const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "opencode";
const MODEL = process.env.OPENCODE_MODEL ?? "deepseek/deepseek-v4-pro";

let instances = loadInstances(args.instances);
if (args.limit > 0) instances = instances.slice(0, args.limit);
const preds = openPredictions(args.out);

for (let i = 0; i < instances.length; i++) {
  const inst = instances[i];
  const dir = prepareRepo(inst, args.workRoot);
  try {
    // opencode headless: run a single non-interactive task in the repo cwd.
    // (`opencode run "<prompt>"` — adjust flags to your opencode version.)
    execFileSync(
      OPENCODE_BIN,
      ["run", "--model", MODEL, inst.problem_statement],
      {
        cwd: dir,
        stdio: "inherit",
        timeout: args.timeoutMs,
        env: { ...process.env, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY },
      },
    );
  } catch (e) {
    console.warn(`[opencode] ${inst.instance_id} run error:`, e?.message ?? e);
  }
  const patch = capturePatch(dir, inst.base_commit);
  preds.append(inst.instance_id, patch, `opencode/${MODEL}`);
  console.log(
    `[opencode] ${i + 1}/${instances.length} ${inst.instance_id} patch=${patch.length}B`,
  );
}
console.log(
  `[opencode] wrote ${args.out} — grade: node scripts/swebench-grade.mjs ${args.out}`,
);
