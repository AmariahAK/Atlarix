/**
 * /compact in the CLI summarises with the session's model (A3, QA 2/2 on a
 * --provider-url build): the summary went to the app's model (Atlarix Auto,
 * unavailable signed out) and the screen said "still short".
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm } from "./fixtures/fake-llm";

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "compact-model-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "compact-model-ws-"));
  // Like real code: varied words, so it costs real tokens.
  for (const n of ["a", "b", "c", "d"]) {
    const lines = Array.from({ length: 120 }, (_, i) => `export const ${n}${i} = computeValue${i}(input${i}, "label ${i} for ${n}");`);
    fs.writeFileSync(path.join(ws, `${n}.ts`), lines.join("\n") + "\n");
  }
});

describe("/compact in the CLI", () => {
  it("asks the session's own model for the summary", async () => {
    const llm = startFakeLlm([
      { tool: "read_file", args: { path: "a.ts" } },
      { text: "Read a." },
      { tool: "read_file", args: { path: "b.ts" } },
      { text: "Read b." },
      { tool: "read_file", args: { path: "c.ts" } },
      { text: "Read c." },
      { tool: "read_file", args: { path: "d.ts" } },
      { text: "Read d." },
    ]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: ws, model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" }) });
    await s.start();
    for (const n of ["a", "b", "c", "d"]) {
      await s.submit(`read ${n}.ts`);
      for (let i = 0; i < 300 && s.state.busy; i++) await new Promise((r) => setTimeout(r, 50));
    }
    const before = llm.requests.length;
    const res = await s.compact();
    const asked = llm.requests.slice(before).some((r) => JSON.stringify(r.messages).includes("Summarize this conversation"));
    expect({ asked, res }).toMatchObject({ asked: true, res: { ok: true } });
  }, 120_000);

  it("a summary that cannot reach the model says so, never 'still short'", async () => {
    const llm = startFakeLlm([
      { tool: "read_file", args: { path: "a.ts" } },
      { text: "Read a." },
      { tool: "read_file", args: { path: "b.ts" } },
      { text: "Read b." },
      { tool: "read_file", args: { path: "c.ts" } },
      { text: "Read c." },
    ]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: ws, model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" }) });
    await s.start();
    for (const n of ["a", "b", "c"]) {
      await s.submit(`read ${n}.ts`);
      for (let i = 0; i < 300 && s.state.busy; i++) await new Promise((r) => setTimeout(r, 50));
    }
    llm.stop(); // the provider goes away (QA cut it mid-session)
    const res = await s.compact();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Couldn't compact/);
  }, 180_000);
});
