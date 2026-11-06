/**
 * The long turn cli-memory-bounded.test.ts measures, in a process of its own:
 *
 *   bun run --preload ./tests-bun/preload.ts tests-bun/fixtures/mem-turn.ts
 *
 * A REAL AgentSession runs STEPS fake tool steps at LATENCY_MS model latency,
 * then compacts. Prints one line: `MEM {json}` with the peaks and the settled
 * figures. `MEM_STEPS` / `MEM_FILE_KB` / `MEM_LATENCY_MS` override sizes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm, type Reply } from "./fake-llm";

const STEPS = Number(process.env.MEM_STEPS ?? 300);
const FILE_KB = Number(process.env.MEM_FILE_KB ?? 3);
const LATENCY_MS = Number(process.env.MEM_LATENCY_MS ?? 100);

process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mem-bounded-ud-"));
process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
process.env.ATLARIX_SURFACE = "cli";
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mem-bounded-ws-"));

// Distinct files so the turn's repetition guard (byte-identical tool calls)
// never fires: each step reads a fresh ~FILE_KB file.
const line = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\n";
const body = (i: number) => `line ${i}: ` + line.repeat(Math.max(1, Math.round((FILE_KB * 1024) / 40)));
for (let i = 0; i < STEPS; i++) fs.writeFileSync(path.join(ws, `big-${i}.txt`), body(i));
const script: Reply[] = [];
for (let i = 0; i < STEPS; i++) script.push({ tool: "read_file", args: { path: `big-${i}.txt` } });
script.push({ text: "Done reading." });

/** RSS sampled at the 100/200/300 step boundaries. */
const rssAtStep: Record<number, number> = {};
const llm = startFakeLlm(script, 0, {
  retainRequests: false,
  latencyMs: LATENCY_MS,
  onStep: (step) => {
    if (step === 100 || step === 200 || step === 300) rssAtStep[step] = process.memoryUsage().rss;
  },
});

const { AgentSession, seedDevProvider } = await import("../../src/cli/agent/session");
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

const idle = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("turn never finished")), 280_000);
  const check = (st: { busy: boolean }) => {
    if (!st.busy) {
      clearTimeout(t);
      s.off("change", check);
      resolve();
    }
  };
  s.on("change", check);
});
const turnStart = Date.now();
await s.submit("read the file many times");
await idle;
const turnMs = Date.now() - turnStart;

const beforeGc = process.memoryUsage();
const res = await s.compact();
Bun.gc(true);
const after = process.memoryUsage();
console.log(
  `MEM ${JSON.stringify({
    steps: STEPS,
    peakRss,
    peakHeap,
    beforeGcHeap: beforeGc.heapUsed,
    after,
    cells: s.state.cells.length,
    compact: res.ok,
    turnMs,
    rssAtStep,
  })}`,
);
llm.stop();
process.exit(0);
