#!/usr/bin/env node
/**
 * SWE-bench runner for Claude Code, pointed at DeepSeek V4 Pro via DeepSeek's
 * Anthropic-compatible endpoint (no gateway needed): `claude-opus-*` model names
 * auto-map to `deepseek-v4-pro`.
 *
 * Prereqs: Claude Code installed (`CLAUDE_BIN`, default `claude`); a DeepSeek
 * key in `DEEPSEEK_API_KEY`.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=… node benchmarks/swebench/run-claude-code.mjs \
 *     --instances swebench_lite.jsonl --limit 5 --out preds-claude.jsonl
 *   node scripts/swebench-grade.mjs preds-claude.jsonl
 */
import { execFileSync } from "node:child_process";
import { loadInstances, prepareRepo, capturePatch, openPredictions, parseArgs } from "./lib.mjs";

const args = parseArgs();
if (!args.instances) throw new Error("--instances (or SWEBENCH_INSTANCES) is required");

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
// An opus-named model routes to deepseek-v4-pro on the Anthropic-compatible endpoint.
const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-4-8";

const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? "https://api.deepseek.com/anthropic",
  ANTHROPIC_API_KEY: process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY,
};

let instances = loadInstances(args.instances);
if (args.limit > 0) instances = instances.slice(0, args.limit);
const preds = openPredictions(args.out);

for (let i = 0; i < instances.length; i++) {
  const inst = instances[i];
  const dir = prepareRepo(inst, args.workRoot);
  try {
    // Headless print mode, unattended (tools auto-approved).
    execFileSync(
      CLAUDE_BIN,
      ["-p", inst.problem_statement, "--model", MODEL, "--dangerously-skip-permissions"],
      { cwd: dir, stdio: "inherit", timeout: args.timeoutMs, env },
    );
  } catch (e) {
    console.warn(`[claude-code] ${inst.instance_id} run error:`, e?.message ?? e);
  }
  const patch = capturePatch(dir, inst.base_commit, ["CLAUDE.md", ".claude"]);
  preds.append(inst.instance_id, patch, `claude-code/${MODEL}->deepseek-v4-pro`);
  console.log(`[claude-code] ${i + 1}/${instances.length} ${inst.instance_id} patch=${patch.length}B`);
}
console.log(`[claude-code] wrote ${args.out} — grade: node scripts/swebench-grade.mjs ${args.out}`);
