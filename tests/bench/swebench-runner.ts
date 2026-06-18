/**
 * Headless SWE-bench runner.
 *
 * For each task instance it drives the REAL agent loop (the same `chat:stream`
 * handler the UI uses, via the in-process eval harness) against a clone of the
 * task's repo at its base commit, then captures the resulting `git diff` as the
 * `model_patch`. The output is a SWE-bench predictions JSONL that the official
 * Docker grader (`scripts/swebench-grade.mjs`) scores by running each repo's
 * own tests.
 *
 * Must run inside the agent-evals vitest environment (Electron mocks +
 * Node-ABI better-sqlite3 alias) — see tests/bench/swebench.run.test.ts.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setupEvalContext, runTurn } from "../infra/turn";
import { autoApproveDuring } from "../infra/auto-approve";

export interface SweInstance {
  instance_id: string;
  /** "owner/name" on GitHub. */
  repo: string;
  base_commit: string;
  problem_statement: string;
}

export interface RunSweBenchOptions {
  instances: SweInstance[];
  /** Real OpenAI-compatible provider (default: Atlarix Core — see the test entry). */
  provider: { baseUrl: string; model: string; apiKey?: string };
  /** Predictions JSONL output path (overwritten). */
  outPath: string;
  /** Directory under which repos are cloned. */
  workRoot: string;
  /** Per-task wall-clock cap (default 10 min). */
  timeoutMs?: number;
  /** Value for predictions' `model_name_or_path` (default: provider.model). */
  modelLabel?: string;
  /** Called after each instance for progress logging. */
  onResult?: (r: { instance_id: string; patchBytes: number; index: number }) => void;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Clone (cached by repo) + checkout the base commit into workRoot/<instance_id>. */
export function prepareRepo(inst: SweInstance, workRoot: string): string {
  fs.mkdirSync(workRoot, { recursive: true });
  const dir = path.join(workRoot, inst.instance_id.replace(/[^a-zA-Z0-9_.-]/g, "_"));
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.rmSync(dir, { recursive: true, force: true });
    execFileSync("git", ["clone", `https://github.com/${inst.repo}.git`, dir], {
      stdio: "ignore",
    });
  }
  git(dir, ["reset", "--hard"]);
  git(dir, ["clean", "-fdx"]);
  git(dir, ["checkout", "--detach", inst.base_commit]);
  return dir;
}

/**
 * Patch = the agent's changes vs the base commit. Stages everything except
 * Atlarix's own workspace artifacts (`.atlarix/`) so the predictions patch is
 * code-only and applies cleanly under the grader.
 */
export function captureModelPatch(dir: string, baseCommit: string): string {
  git(dir, ["add", "-A", "--", ".", ":(exclude).atlarix", ":(exclude).atlarix/**"]);
  return git(dir, ["diff", "--cached", baseCommit, "--", ".", ":(exclude).atlarix"]);
}

/** Load SWE-bench instances from a JSONL or JSON-array file. */
export function loadInstances(file: string): SweInstance[] {
  const raw = fs.readFileSync(file, "utf8").trim();
  if (raw.startsWith("[")) return JSON.parse(raw) as SweInstance[];
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SweInstance);
}

export async function runSweBench(
  opts: RunSweBenchOptions,
): Promise<{ predictions: number; outPath: string }> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  // Benchmark integrity: force native function-calling (no text/XML tool shim)
  // and drop the in-app browser tools (they can't run here and waste calls).
  process.env.ATLARIX_HEADLESS = "1";
  process.env.ATLARIX_DISABLE_TEXT_TOOLS = "1";
  const ctx = await setupEvalContext({ provider: opts.provider });
  const { createStreamTransport } = await import("@/lib/chat/stream-transport");

  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  fs.writeFileSync(opts.outPath, "");

  const providerSettings = opts.provider.apiKey
    ? { [ctx.providerId]: { apiKey: { value: opts.provider.apiKey } } }
    : undefined;

  let count = 0;
  try {
    for (let i = 0; i < opts.instances.length; i++) {
      const inst = opts.instances[i];
      const repoDir = prepareRepo(inst, opts.workRoot);
      const { appId } = await ctx.testDb.seedApp({
        path: repoDir,
        name: inst.instance_id,
      });
      const chatId = await createStreamTransport(appId);

      try {
        await runTurn(ctx, {
          chatId,
          prompt: inst.problem_statement,
          mode: "build",
          timeoutMs,
          settings: {
            selectedModel: { name: ctx.modelName, provider: ctx.providerId },
            ...(providerSettings ? { providerSettings } : {}),
          },
          during: autoApproveDuring(chatId, { timeoutMs }),
        });
      } catch (err) {
        // A hung/failed turn still yields whatever was written so far.
        console.warn(`[swebench] ${inst.instance_id} turn error:`, err);
      }

      const patch = captureModelPatch(repoDir, inst.base_commit);
      fs.appendFileSync(
        opts.outPath,
        JSON.stringify({
          instance_id: inst.instance_id,
          model_patch: patch,
          model_name_or_path: opts.modelLabel ?? opts.provider.model,
        }) + "\n",
      );
      count++;
      opts.onResult?.({ instance_id: inst.instance_id, patchBytes: patch.length, index: i });
    }
  } finally {
    await ctx.cleanup();
  }
  return { predictions: count, outPath: opts.outPath };
}
