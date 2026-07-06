import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { setupEvalContext, type EvalContext } from "../infra/turn";
import { hasCtags } from "../../src/__tests__/helpers/native-tools";

/**
 * v12 S21 — the retrieval eval (Tier 6 "measure it"; the second-paper data).
 *
 * Drives the REAL retriever — ctags symbol index + BM25-fused ranking — over a
 * fixture repo with a known call graph (tests/fixtures/blueprint-eval-repo)
 * and a task → target-file ground truth.
 *
 * v13.7: the get_blueprint tool was removed; Blueprint is now the silent
 * substrate that reranks `grep`. So surface 1 is the grep TOOL end-to-end
 * (ripgrep + Blueprint BM25 rerank), measuring whether the top-ranked file
 * is a target. The paper's retrieval method is unchanged — only the agent-
 * facing affordance moved from a dedicated tool into grep.
 *
 * Metrics (ABSOLUTE — no embedding baseline exists and none is added; Tier 5
 * identity guardrail):
 *   - grep precision@1: the top-ranked grep file group is a target for the
 *     task's topic.
 *   - bm25 precision@1 / precision@3: searchBlueprintBm25's top hit(s).
 *
 * REPORT MODE: emits a per-category summary (the dataset) and asserts only
 *   (a) every task was measured and (b) the retriever isn't totally broken
 *   (overall p@1 > 0). Thresholds get pinned once the baseline distribution
 *   is known across machines. calls-to-target needs real model runs —
 *   consciously deferred (documented in the S21 register entry).
 */

interface GroundTruthTask {
  id: string;
  category: string;
  section: string;
  task: string;
  topic: string;
  targetFiles: string[];
}

const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/blueprint-eval-repo");

function readFixtureTree(dir: string, base = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(out, readFixtureTree(dir, rel));
    } else if (entry.name !== "ground-truth.json") {
      out[rel] = fs.readFileSync(path.join(dir, rel), "utf8");
    }
  }
  return out;
}

const groundTruth = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "ground-truth.json"), "utf8"),
) as { tasks: GroundTruthTask[] };

let ctx: EvalContext;

/** Does a slice/bm25 file path refer to one of the task's targets? */
function matchesTarget(
  file: string | undefined,
  task: GroundTruthTask,
): boolean {
  if (!file) return false;
  const norm = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return task.targetFiles.some((target) => {
    // Slice file paths are relative to the focus_path scan root; bm25 paths
    // may be absolute or workspace-relative. Suffix-match both directions.
    const sectionRel = target.startsWith(`${task.section}/`)
      ? target.slice(task.section.length + 1)
      : target;
    return (
      norm === target ||
      norm === sectionRel ||
      norm.endsWith(`/${target}`) ||
      norm.endsWith(`/${sectionRel}`)
    );
  });
}

interface TaskResult {
  id: string;
  category: string;
  grepTop1: boolean;
  bm25Top1: boolean;
  bm25Top3: boolean;
}

describe.skipIf(!hasCtags())("retrieval eval (S21)", () => {
  beforeAll(async () => {
    // In-process structural scan — the bundled worker script is unreliable
    // under vitest worker_threads, and determinism beats parallelism here.
    process.env.ATLARIX_ASTGREP_IN_PROCESS = "1";
    ctx = await setupEvalContext({ seedFiles: readFixtureTree(FIXTURE_DIR) });
  }, 60_000);

  afterAll(async () => {
    delete process.env.ATLARIX_ASTGREP_IN_PROCESS;
    await ctx.cleanup();
  });

  it("measures precision@1 over the ground-truth task set", async () => {
    const { ToolRegistry } = await import("@/lib/tools/registry");
    await import("@/lib/tools"); // ensure tool registration
    const { searchBlueprintBm25 } = await import(
      "@/lib/search/bm25_semantic_index"
    );

    const results: TaskResult[] = [];

    for (const task of groundTruth.tasks) {
      // ── surface 1: grep tool end-to-end (ripgrep + Blueprint BM25 rerank) ──
      // task.topic is a `|`-alternates regex (e.g. "payment|stripe").
      const rawOut = await ToolRegistry.execute("grep", {
        pattern: task.topic,
        workspaceId: ctx.appId,
        workspace: ctx.ws.dir,
      });
      const parsed =
        typeof rawOut === "string" ? JSON.parse(rawOut) : (rawOut as never);
      const payload = (parsed?.result ?? parsed) as {
        ui?: { groups?: Array<{ file?: string }> };
      };
      // The grep handler's structured surface lives under `ui.groups`; tolerate
      // either an unwrapped return or an execute envelope.
      const groups =
        payload?.ui?.groups ??
        (parsed as { ui?: { groups?: Array<{ file?: string }> } })?.ui?.groups ??
        [];
      const grepTop1 = matchesTarget(groups[0]?.file, task);

      // ── surface 2: BM25 symbol search ──
      const bm25 = await searchBlueprintBm25(
        ctx.appId,
        ctx.ws.dir,
        task.task,
        5,
      );
      const hits = bm25?.hits ?? [];
      const bm25Top1 = matchesTarget(hits[0]?.file, task);
      const bm25Top3 = hits
        .slice(0, 3)
        .some((h) => matchesTarget(h.file, task));

      results.push({ id: task.id, category: task.category, grepTop1, bm25Top1, bm25Top3 });
    }

    // ── the report (this output IS the dataset) ──
    const pct = (xs: boolean[]) =>
      xs.length === 0 ? 0 : Math.round((xs.filter(Boolean).length / xs.length) * 100);
    const byCategory = new Map<string, TaskResult[]>();
    for (const r of results) {
      byCategory.set(r.category, [...(byCategory.get(r.category) ?? []), r]);
    }
    const summary = {
      tasks: results.length,
      overall: {
        grepP1: pct(results.map((r) => r.grepTop1)),
        bm25P1: pct(results.map((r) => r.bm25Top1)),
        bm25P3: pct(results.map((r) => r.bm25Top3)),
      },
      byCategory: Object.fromEntries(
        [...byCategory.entries()].map(([cat, rs]) => [
          cat,
          {
            n: rs.length,
            grepP1: pct(rs.map((r) => r.grepTop1)),
            bm25P1: pct(rs.map((r) => r.bm25Top1)),
            bm25P3: pct(rs.map((r) => r.bm25Top3)),
          },
        ]),
      ),
      misses: results
        .filter((r) => !r.grepTop1 || !r.bm25Top1)
        .map((r) => `${r.id}(grep=${r.grepTop1 ? "✓" : "✗"} bm25=${r.bm25Top1 ? "✓" : "✗"})`),
    };
    console.log("[retrieval-eval] " + JSON.stringify(summary, null, 2));

    // Report-mode gates: complete coverage + a conservative floor. The grep
    // surface (ripgrep + Blueprint rerank) replaces the removed get_blueprint
    // tool; its absolute P@1 differs from the old structural-slice number, so
    // the floor only asserts the retriever isn't broken (room for ctags
    // variance across machines). The emitted summary IS the dataset.
    expect(results).toHaveLength(groundTruth.tasks.length);
    expect(summary.overall.grepP1).toBeGreaterThanOrEqual(25);
    expect(summary.overall.bm25P1).toBeGreaterThanOrEqual(25);
  }, 120_000);
});
