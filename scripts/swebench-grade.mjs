#!/usr/bin/env node
/**
 * Thin wrapper around the OFFICIAL SWE-bench evaluation harness. It does not
 * reimplement grading — it shells out to `swebench.harness.run_evaluation`,
 * which spins up a Docker container per task, applies our predicted patch, runs
 * the repo's own FAIL_TO_PASS / PASS_TO_PASS tests, and reports % resolved.
 *
 * Prereqs:
 *   - Docker running
 *   - pip install swebench   (the official package)
 *
 * Usage:
 *   node scripts/swebench-grade.mjs <predictions.jsonl> [--dataset princeton-nlp/SWE-bench_Lite] [--split test] [--workers 4]
 *
 * Produces a report JSON in the cwd (per the official harness) summarizing
 * resolved instances. The headline number is "% resolved".
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const predictions = process.argv[2];
if (!predictions || predictions.startsWith("--")) {
  console.error("Usage: node scripts/swebench-grade.mjs <predictions.jsonl> [--dataset <name>] [--split <split>] [--workers <n>]");
  process.exit(1);
}
if (!fs.existsSync(predictions)) {
  console.error(`Predictions file not found: ${predictions}`);
  process.exit(1);
}

const dataset = arg("--dataset", "princeton-nlp/SWE-bench_Lite");
const split = arg("--split", "test");
const workers = arg("--workers", "4");
const runId = arg("--run-id", `atlarix-${new Date().toISOString().replace(/[:.]/g, "-")}`);

console.log(`[grade] predictions=${path.resolve(predictions)}`);
console.log(`[grade] dataset=${dataset} split=${split} workers=${workers} run_id=${runId}`);
console.log("[grade] invoking official swebench harness (Docker)…\n");

const res = spawnSync(
  "python",
  [
    "-m",
    "swebench.harness.run_evaluation",
    "--predictions_path",
    predictions,
    "--dataset_name",
    dataset,
    "--split",
    split,
    "--max_workers",
    workers,
    "--run_id",
    runId,
  ],
  { stdio: "inherit" },
);

if (res.error) {
  console.error(
    "\n[grade] Failed to launch the grader. Install it with `pip install swebench` and ensure Docker is running.",
  );
  process.exit(1);
}
process.exit(res.status ?? 1);
