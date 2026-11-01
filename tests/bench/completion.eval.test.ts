import { describe, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getIpcHandler } from "../infra/turn";
import { runHeadlessAgent } from "@/headless/headless-runner";

/**
 * Gated completion eval (ATLARIX_COMPLETION=1) — runs a fixed set of short,
 * representative tasks through the REAL agent loop against a REAL model, and
 * reports per-task completion, the artifact the task asked for, and the turn's
 * real token cost. Used to confirm the 4c prompt diet does not break a model's
 * ability to finish a turn (before vs after the trims).
 *
 * Provider wiring (one of):
 *   - Native Bedrock (the 4c eval's path): set ATLARIX_COMPLETION_PROVIDER_ID=bedrock
 *     + ATLARIX_COMPLETION_MODEL=<regional inference profile> + the AWS bearer token
 *     as ATLARIX_COMPLETION_API_KEY. The app's own bedrock provider signs the
 *     Converse API with `Authorization: Bearer`.
 *   - Custom OpenAI-compatible / Anthropic-format endpoint: set ATLARIX_COMPLETION_URL
 *     (+ ATLARIX_COMPLETION_ANTHROPIC=1 for Anthropic format, ATLARIX_COMPLETION_AUTH
 *     to choose the header).
 *
 * Env:
 *   ATLARIX_COMPLETION=1                 enable
 *   ATLARIX_COMPLETION_MODEL             model id (required)
 *   ATLARIX_COMPLETION_API_KEY           key (required)
 *   ATLARIX_COMPLETION_PROVIDER_ID       "bedrock" for the native provider (else a
 *                                        custom endpoint at ATLARIX_COMPLETION_URL)
 *   ATLARIX_COMPLETION_URL               base URL (required unless PROVIDER_ID=bedrock)
 *   ATLARIX_COMPLETION_ANTHROPIC=1       Anthropic-format endpoint (default: OpenAI-compatible)
 *   ATLARIX_COMPLETION_AUTH              "bearer" (default) | "x-api-key"
 *   ATLARIX_COMPLETION_MAX_COST_USD      hard stop once cumulative turn cost exceeds this (default 3)
 *   ATLARIX_COMPLETION_TRAJECTORY_DIR    where to write per-task trajectories (default $TMPDIR)
 *
 * Example (Opus 4.6 on Bedrock):
 *   ATLARIX_COMPLETION=1 ATLARIX_COMPLETION_PROVIDER_ID=bedrock \
 *   ATLARIX_COMPLETION_MODEL=us.anthropic.claude-opus-4-6-v1 \
 *   ATLARIX_COMPLETION_API_KEY=$(cat ~/Documents/Atlarix-security/bedrock-token) \
 *   npx vitest run --project agent-evals tests/bench/completion.eval.test.ts
 */
const ENABLED = process.env.ATLARIX_COMPLETION === "1";

/** A task plus how to judge its completion from the workspace. */
interface Task {
  id: string;
  prompt: string;
  /** Files to seed before the turn. */
  seed?: Record<string, string>;
  /** Assert the workspace after the turn; returns a short pass/fail note. */
  verify?: (ws: string) => string;
}

const TASKS: Task[] = [
  {
    id: "write-exact",
    prompt:
      'Create a file named result.txt with the exact content `atlarix-4c-eval` (no quotes, no trailing newline).',
    verify: (ws) => {
      const p = path.join(ws, "result.txt");
      if (!fs.existsSync(p)) return "missing result.txt";
      return fs.readFileSync(p, "utf8") === "atlarix-4c-eval"
        ? "ok"
        : `content=${JSON.stringify(fs.readFileSync(p, "utf8"))}`;
    },
  },
  {
    id: "read-back",
    seed: { "seed.txt": "the-answer-is-42\n" },
    prompt:
      "Read the file seed.txt and report exactly what it contains, on its own line.",
    verify: () => "ok", // judged by lastAssistant echo below
  },
  {
    id: "write-logic",
    prompt:
      "Create a file add.ts exporting a function add(a, b) that returns a + b.",
    verify: (ws) => {
      const p = path.join(ws, "add.ts");
      if (!fs.existsSync(p)) return "missing add.ts";
      const src = fs.readFileSync(p, "utf8");
      return /return\s+a\s*\+\s*b/.test(src)
        ? "ok"
        : `add.ts=${JSON.stringify(src.slice(0, 120))}`;
    },
  },
  {
    id: "run-pwd",
    prompt:
      "Run the shell command `pwd` and report the path it prints, on its own line.",
    verify: () => "ok", // judged by lastAssistant echo below
  },
];

/** Sum of turn_cost_usd over the trajectory's turn_end lines. */
function trajectoryCostUsd(file: string): number {
  if (!fs.existsSync(file)) return 0;
  let sum = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: { type?: string; turnCostUsd?: number };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === "turn_end" && typeof rec.turnCostUsd === "number") {
      sum += rec.turnCostUsd;
    }
  }
  return sum;
}

describe.skipIf(!ENABLED)("completion eval (ATLARIX_COMPLETION=1)", () => {
  it(
    "completes each task",
    async () => {
      const model = process.env.ATLARIX_COMPLETION_MODEL;
      const apiKey = process.env.ATLARIX_COMPLETION_API_KEY;
      const providerId = process.env.ATLARIX_COMPLETION_PROVIDER_ID;
      const url = process.env.ATLARIX_COMPLETION_URL;
      if (!model || !apiKey) {
        throw new Error(
          "Set ATLARIX_COMPLETION_MODEL and ATLARIX_COMPLETION_API_KEY.",
        );
      }
      if (providerId !== "bedrock" && !url) {
        throw new Error(
          "Set ATLARIX_COMPLETION_URL, or ATLARIX_COMPLETION_PROVIDER_ID=bedrock.",
        );
      }
      const anthropic = process.env.ATLARIX_COMPLETION_ANTHROPIC === "1";
      const authHeader = (process.env.ATLARIX_COMPLETION_AUTH ?? "bearer") as
        | "bearer"
        | "x-api-key";
      const maxCostUsd = Number(
        process.env.ATLARIX_COMPLETION_MAX_COST_USD ?? "3",
      );
      const trajDir =
        process.env.ATLARIX_COMPLETION_TRAJECTORY_DIR ?? os.tmpdir();
      fs.mkdirSync(trajDir, { recursive: true });

      const provider =
        providerId === "bedrock"
          ? { id: "bedrock" as const, model, apiKey }
          : anthropic
            ? { id: "anthropic" as const, baseUrl: url!, model, apiKey, authHeader }
            : { baseUrl: url!, model, apiKey };

      const timeoutMs = Number(
        process.env.ATLARIX_COMPLETION_TIMEOUT_MS ?? "180000",
      );
      const results: Record<string, unknown>[] = [];
      let totalCostUsd = 0;

      try {
        for (const task of TASKS) {
          const ws = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-c4-"));
          if (task.seed) {
            for (const [name, content] of Object.entries(task.seed)) {
              fs.writeFileSync(path.join(ws, name), content);
            }
          }
          const trajFile = path.join(
            trajDir,
            `c4-${task.id}-${Date.now()}.jsonl`,
          );
          const started = Date.now();
          const res = await runHeadlessAgent({
            workspaceDir: ws,
            prompt: task.prompt,
            provider,
            mode: "build",
            timeoutMs,
            trajectoryFile: trajFile,
            resolveHandler: (channel) => getIpcHandler(channel),
          });
          const cost = trajectoryCostUsd(trajFile);
          totalCostUsd += cost;
          const artifact = task.verify?.(ws) ?? "n/a";
          const echoed =
            task.id === "read-back"
              ? (res.lastAssistant ?? "").includes("the-answer-is-42")
              : task.id === "run-pwd"
                ? /\/[^\s"'`\n]+/.test(res.lastAssistant ?? "")
                : null;
          results.push({
            task: task.id,
            completed: res.completed,
            artifact,
            echoed,
            costUsd: Number(cost.toFixed(6)),
            ms: Date.now() - started,
            lastAssistant: (res.lastAssistant ?? "").slice(0, 160),
          });
          // eslint-disable-next-line no-console
          console.log(
            `[4c-completion] ${JSON.stringify(results[results.length - 1])}`,
          );
          fs.rmSync(ws, { recursive: true, force: true });

          if (totalCostUsd > maxCostUsd) {
            // eslint-disable-next-line no-console
            console.log(
              `[4c-completion] cumulative cost $${totalCostUsd.toFixed(4)} exceeds cap $${maxCostUsd} — stopping.`,
            );
            break;
          }
        }
      } finally {
        // eslint-disable-next-line no-console
        console.log(
          `[4c-completion] model=${model} cumulative cost=$${totalCostUsd.toFixed(4)} tasks=${results.length}/${TASKS.length}`,
        );
      }

      const failed = results.filter(
        (r) =>
          !r.completed ||
          (r.artifact != null && r.artifact !== "ok") ||
          r.echoed === false,
      );
      if (failed.length > 0) {
        throw new Error(
          `completion eval: ${failed.length}/${TASKS.length} tasks failed:\n` +
            JSON.stringify(failed, null, 2),
        );
      }
    },
    30 * 60 * 1000,
  );
});
