import { describe, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { runSweBench, loadInstances } from "./swebench-runner";

/**
 * Gated SWE-bench run. Skipped unless ATLARIX_BENCH=1 so `npm test` is
 * unaffected. Produces a predictions JSONL; grade it with
 * `node scripts/swebench-grade.mjs <out>`.
 *
 * Env:
 *   ATLARIX_BENCH=1                 enable
 *   ATLARIX_BENCH_INSTANCES=<file>  SWE-bench JSONL/JSON (required)
 *   ATLARIX_BENCH_PROVIDER_URL      default https://engine.atlarix.dev/v1 (Atlarix Core)
 *   ATLARIX_BENCH_MODEL             default core-3 (DeepSeek V4 Pro)
 *   ATLARIX_BENCH_API_KEY           Core/Pro token (required for Core)
 *   ATLARIX_BENCH_LIMIT             first N instances (0 = all)
 *   ATLARIX_BENCH_TIMEOUT_MS        per-task cap (default 600000)
 *   ATLARIX_BENCH_OUT               predictions path (default ./swebench-predictions.jsonl)
 *   ATLARIX_BENCH_WORKROOT          clone root (default $TMPDIR/atlarix-swebench)
 *
 * Example:
 *   ATLARIX_BENCH=1 ATLARIX_BENCH_INSTANCES=swebench_lite.jsonl \
 *   ATLARIX_BENCH_API_KEY=$ATLARIX_TOKEN ATLARIX_BENCH_LIMIT=5 \
 *   npx vitest run --project agent-evals tests/bench/swebench.run.test.ts
 */
const ENABLED = process.env.ATLARIX_BENCH === "1";

describe.skipIf(!ENABLED)("SWE-bench run (ATLARIX_BENCH=1)", () => {
  it("drives the agent over each instance and writes predictions", async () => {
    const instancesPath = process.env.ATLARIX_BENCH_INSTANCES;
    if (!instancesPath) {
      throw new Error(
        "Set ATLARIX_BENCH_INSTANCES to a SWE-bench JSONL/JSON file (e.g. SWE-bench Lite).",
      );
    }
    let instances = loadInstances(instancesPath);
    const limit = Number(process.env.ATLARIX_BENCH_LIMIT ?? "0");
    if (limit > 0) instances = instances.slice(0, limit);

    const provider = {
      baseUrl:
        process.env.ATLARIX_BENCH_PROVIDER_URL ?? "https://engine.atlarix.dev/v1",
      model: process.env.ATLARIX_BENCH_MODEL ?? "core-3",
      apiKey: process.env.ATLARIX_BENCH_API_KEY,
    };
    const outPath =
      process.env.ATLARIX_BENCH_OUT ??
      path.join(process.cwd(), "swebench-predictions.jsonl");
    const workRoot =
      process.env.ATLARIX_BENCH_WORKROOT ??
      path.join(os.tmpdir(), "atlarix-swebench");
    const timeoutMs = Number(process.env.ATLARIX_BENCH_TIMEOUT_MS ?? "600000");

    const res = await runSweBench({
      instances,
      provider,
      outPath,
      workRoot,
      timeoutMs,
      modelLabel: `atlarix/${provider.model}`,
      onResult: (r) =>
        // eslint-disable-next-line no-console
        console.log(
          `[swebench] ${r.index + 1}/${instances.length} ${r.instance_id} patch=${r.patchBytes}B`,
        ),
    });
    // eslint-disable-next-line no-console
    console.log(
      `[swebench] wrote ${res.predictions} prediction(s) → ${res.outPath}\n` +
        `Grade: node scripts/swebench-grade.mjs ${res.outPath}`,
    );
  }, 24 * 60 * 60 * 1000);
});
