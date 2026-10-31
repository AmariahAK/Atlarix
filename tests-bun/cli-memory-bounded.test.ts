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
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm, type FakeLlm, type Reply } from "./fixtures/fake-llm";

const STEPS = Number(process.env.MEM_STEPS ?? 300);
const FILE_KB = Number(process.env.MEM_FILE_KB ?? 3);
const LATENCY_MS = Number(process.env.MEM_LATENCY_MS ?? 100);

/**
 * Measured 2026-11-01 (300 steps, 100 ms latency, 3 KB tool results):
 *   without the GC fix  peak RSS 444 MB (sawtooth, compaction-driven);
 *   with the GC fix    peak RSS 302-337 MB (run-to-run), flat (~210-265 MB
 *                      at steps 100/200/300).
 * A ceiling between the two keeps the fix honest: it fails without the forced
 * GC and passes with headroom for CI variance.
 */
const RSS_CEILING_MB = 400;

const mb = (n: number) => Math.round(n / 1024 / 1024);

let llm: FakeLlm;
let ws: string;
/** RSS sampled at the 100/200/300 step boundaries (before/after comparison). */
const rssAtStep: Record<number, number> = {};

beforeAll(() => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "mem-bounded-ud-"));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "mem-bounded-ws-"));
  process.env.ATLARIX_USER_DATA_DIR = ud;
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  // Distinct files so the turn's repetition guard (byte-identical tool calls)
  // never fires: each step reads a fresh ~FILE_KB file.
  const line = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\n";
  const body = (i: number) => `line ${i}: ` + line.repeat(Math.max(1, Math.round((FILE_KB * 1024) / 40)));
  for (let i = 0; i < STEPS; i++) fs.writeFileSync(path.join(ws, `big-${i}.txt`), body(i));
  const script: Reply[] = [];
  for (let i = 0; i < STEPS; i++) script.push({ tool: "read_file", args: { path: `big-${i}.txt` } });
  script.push({ text: "Done reading." });
  llm = startFakeLlm(script, 0, {
    retainRequests: false,
    latencyMs: LATENCY_MS,
    onStep: (step) => {
      if (step === 100 || step === 200 || step === 300) rssAtStep[step] = process.memoryUsage().rss;
    },
  });
});

function waitIdle(s: { state: { busy: boolean }; on: Function; off: Function }, ms = 300_000) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("turn never finished")), ms);
    const check = (st: { busy: boolean }) => {
      if (!st.busy) {
        clearTimeout(t);
        s.off("change", check);
        resolve();
      }
    };
    s.on("change", check);
  });
}

describe("CLI memory (item 0q)", () => {
  it("300 tool steps leave RSS bounded (no multi-GB climb)", async () => {
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const model = await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" });
    const s = new AgentSession({ workspaceDir: ws, model });
    await s.start();

    let peakRss = 0;
    let peakHeap = 0;
    s.on("change", () => {
      const m = process.memoryUsage();
      peakRss = Math.max(peakRss, m.rss);
      peakHeap = Math.max(peakHeap, m.heapUsed);
    });

    const turnStart = Date.now();
    await s.submit("read the file many times");
    await waitIdle(s);
    const turnMs = Date.now() - turnStart;

    const beforeGc = process.memoryUsage();
    const res = await s.compact();
    Bun.gc(true);
    const { rss, heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
    // eslint-disable-next-line no-console
    console.log(
      `[mem] steps=${STEPS} peakRss=${mb(peakRss)}MB peakHeap=${mb(peakHeap)}MB beforeGc-heap=${mb(beforeGc.heapUsed)}MB after-compact rss=${mb(rss)}MB heap=${mb(heapUsed)}MB heapTotal=${mb(heapTotal)}MB external=${mb(external)}MB arrayBuffers=${mb(arrayBuffers)}MB cells=${s.state.cells.length} compact=${res.ok} turnMs=${turnMs} rss100=${mb(rssAtStep[100] ?? 0)}MB rss200=${mb(rssAtStep[200] ?? 0)}MB rss300=${mb(rssAtStep[300] ?? 0)}MB`,
    );

    // The acceptance criterion: the PEAK RSS during the turn (the high-water
    // mark the process actually reaches), not just the settled value after.
    expect(peakRss).toBeLessThan(RSS_CEILING_MB * 1024 * 1024);
  }, 300_000);
});
