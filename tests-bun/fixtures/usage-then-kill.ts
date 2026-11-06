/**
 * For usage-survives-kill.test.ts: count one turn, then die by SIGKILL before
 * any send (no quit handler runs, as with a crash, Task Manager or a Windows
 * shutdown).
 *
 *   bun run --preload ./tests-bun/preload.ts tests-bun/fixtures/usage-then-kill.ts <userData>
 */
process.env.ATLARIX_USER_DATA_DIR = process.argv[2]!;
process.env.ATLARIX_SURFACE = "cli";
const { recordTurnUsage } = await import("../../src/lib/analytics/usage-rollup");
recordTurnUsage(
  { provider: "openai", model: "gpt-5", end: { outcome: "ok" }, tokensIn: 42, tokensOut: 7 },
  async () => ({ type: "cloud" }),
);
await new Promise((r) => setTimeout(r, 200));
console.log("COUNTED");
process.kill(process.pid, "SIGKILL");
