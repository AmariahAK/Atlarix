/**
 * Several sub-agents started in one step all show while they run (the video
 * session: the editor's panel showed "1/1 running" for 4 agents, then
 * "4 completed" at the end).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm } from "./fixtures/fake-llm";

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "par-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "par-ws-"));
  fs.writeFileSync(path.join(ws, "a.ts"), "export const a = 1;\n");
});

describe("parallel sub-agents", () => {
  it("all four are rows while they run", async () => {
    const task = (d: string) => ({ tool: "task", args: { description: d, prompt: `${d}: look at a.ts and report one line.`, subagent_type: "explore" } });
    const llm = startFakeLlm([
      { tools: [task("Audit auth"), task("Audit routes"), task("Audit tests"), task("Audit server")] },
      { text: "Looked at a.ts: it exports a single constant and nothing else worth noting here at all. ", delayMs: 120 },
    ]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const model = await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" });
    const s = new AgentSession({ workspaceDir: ws, model });
    await s.start();
    let most = 0;
    const seen = new Set<string>();
    s.on("change", (st: { cells: Array<{ kind: string; tool?: { verb: string; target: string; status: string } }> }) => {
      const running = st.cells.filter((c) => c.kind === "tool" && c.tool?.verb === "Agent" && c.tool.status === "running");
      for (const c of running) seen.add(c.tool!.target);
      most = Math.max(most, running.length);
    });
    await s.submit("Audit the project with four agents.");
    for (let i = 0; i < 400 && (s.state.busy || !s.sessionId); i++) await new Promise((r) => setTimeout(r, 100));
    expect(most).toBe(4);
  }, 60_000);
});
