/**
 * Item 0q: a long Build turn must not grow the CLI process's RSS unboundedly.
 * The CLI is ONE Bun process (turn engine + transport + TUI), so a turn that
 * holds hundreds of tool steps used to climb toward multi-GB RSS and thrash an
 * 8 GB Mac.
 *
 * Root cause (Case B): the turn engine re-serializes the full growing native
 * history on every step, and bmalloc grows to that peak working set and never
 * returns it — so RSS climbs even though the JS heap stays small. The fix is
 * a forced synchronous GC between steps (forceGcBetweenSteps, wired into the
 * round's onStepEnd), Bun-only and no-op under Node/Electron. Collecting every
 * step lets the allocator REUSE the per-step churn instead of growing into it.
 *
 * This test drives a REAL AgentSession through 300 fake tool steps at ~100 ms
 * model latency (the worst case for growth) and asserts the process's peak RSS
 * stays bounded. `MEM_STEPS` / `MEM_FILE_KB` / `MEM_LATENCY_MS` override sizes.
 *
 * The turn runs in a process of its own (fixtures/mem-turn.ts), as the CLI
 * does. `bun test --isolate` runs every file in ONE process, and files before
 * this one leave sessions, servers and timers alive: in the whole run this
 * test measured ~200 MB of heap that was not its turn's, and which files ran
 * first changed whenever a file was added (CI 2026-11-06: peak 934 MB on
 * 4bfd8867; locally the last green commit failed the same way in the whole run,
 * and both pass alone at 118 MB heap).
 */
import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Measured 2026-11-01 (300 steps, 100 ms latency, 3 KB tool results):
 *   without the GC fix  peak RSS 444 MB (sawtooth, compaction-driven);
 *   with the GC fix    peak RSS 302-337 MB (run-to-run), flat (~210-265 MB
 *                      at steps 100/200/300).
 * The test's job is to catch a multi-GB climb, not minor CI variance. CI
 * (GitHub Actions) runs higher than local (477 MB observed 2026-11-02), so
 * the ceiling is set to 600 MB — well above the fixed behavior, well below
 * the multi-GB regression the test guards against.
 */
const RSS_CEILING_MB = 600;

/**
 * The JS heap at its peak. On macOS Bun's reported RSS did not see a leak in
 * the heap (2026-11-06: 1.3 GB leaked on purpose, RSS read 434 MB), so RSS
 * alone cannot fail this test there. A turn's own heap peaks at ~118 MB
 * (local, alone); 400 MB leaves room for CI and fails a per-step hold.
 */
const HEAP_CEILING_MB = 400;

const mb = (n: number) => Math.round(n / 1024 / 1024);

type MemReport = {
  steps: number;
  peakRss: number;
  peakHeap: number;
  beforeGcHeap: number;
  after: NodeJS.MemoryUsage;
  cells: number;
  compact: boolean;
  turnMs: number;
  rssAtStep: Record<string, number>;
};

/** Runs fixtures/mem-turn.ts in its own process and returns its MEM report. */
function runTurn(): Promise<MemReport> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["run", "--preload", "./tests-bun/preload.ts", "tests-bun/fixtures/mem-turn.ts"],
      { cwd: path.join(import.meta.dir, ".."), stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout!.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr!.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.split("\n").find((l) => l.startsWith("MEM "));
      if (!line) return reject(new Error(`no MEM line (exit ${code}): ${(out + err).slice(-2000)}`));
      resolve(JSON.parse(line.slice(4)) as MemReport);
    });
  });
}

describe("CLI memory (item 0q)", () => {
  it("300 tool steps leave RSS bounded (no multi-GB climb)", async () => {
    const r = await runTurn();
    const a = r.after;
    // eslint-disable-next-line no-console
    console.log(
      `[mem] steps=${r.steps} peakRss=${mb(r.peakRss)}MB peakHeap=${mb(r.peakHeap)}MB beforeGc-heap=${mb(r.beforeGcHeap)}MB after-compact rss=${mb(a.rss)}MB heap=${mb(a.heapUsed)}MB heapTotal=${mb(a.heapTotal)}MB external=${mb(a.external)}MB arrayBuffers=${mb(a.arrayBuffers)}MB cells=${r.cells} compact=${r.compact} turnMs=${r.turnMs} rss100=${mb(r.rssAtStep[100] ?? 0)}MB rss200=${mb(r.rssAtStep[200] ?? 0)}MB rss300=${mb(r.rssAtStep[300] ?? 0)}MB`,
    );

    // The turn really ran: every tool step drew a cell, and compaction worked.
    expect(r.cells).toBeGreaterThan(r.steps);
    expect(r.compact).toBe(true);
    // The acceptance criterion: the PEAK RSS during the turn (the high-water
    // mark the process actually reaches), not just the settled value after.
    expect(r.peakRss).toBeLessThan(RSS_CEILING_MB * 1024 * 1024);
    expect(r.peakHeap).toBeLessThan(HEAP_CEILING_MB * 1024 * 1024);
  }, 300_000);
});
