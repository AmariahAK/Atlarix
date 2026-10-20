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

/**
 * Sentry ATLARIX-2Y (84 events): Core answered "Prompt exceeds max length" and
 * the turn failed. Two faults: the wording was not recognised, and a too-long
 * 400 from ANY provider was taken as a refusal, so the turn ended before its
 * one compact-and-retry ran.
 */
describe("a request too long for the model", () => {
  it("is compacted and retried, and the turn answers", async () => {
    // Big enough that compacting it frees real room, as a real overflow's history is.
    for (const n of ["big1", "big2", "big3"]) {
      const lines = Array.from({ length: 700 }, (_, i) => `export const ${n}_${i} = computeValue${i}(input${i}, "label ${i} for ${n}");`);
      fs.writeFileSync(path.join(ws, `${n}.ts`), lines.join("\n") + "\n");
    }
    const llm = startFakeLlm([
      { tool: "read_file", args: { path: "big1.ts" } },
      { text: "Read a." },
      { tool: "read_file", args: { path: "big2.ts" } },
      { text: "Read b." },
      { tool: "read_file", args: { path: "big3.ts" } },
      { text: "Read c." },
      { status: 400, error: "Prompt exceeds max length" },
      { text: "Recovered after compacting." },
    ]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: ws, model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" }) });
    await s.start();
    for (const n of ["a", "b", "c", "go on"]) {
      await s.submit(n.length === 1 ? `read ${n}.ts` : n);
      for (let i = 0; i < 600 && s.state.busy; i++) await new Promise((r) => setTimeout(r, 50));
    }
    // The retry is its own dispatch: the session can read idle for a moment between.
    const answered = () => s.state.cells.some((c) => c.kind === "markdown" && c.text === "Recovered after compacting.");
    for (let i = 0; i < 600 && !answered(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(answered()).toBe(true);
    expect(s.state.lastError).toBeNull();
    // And it is saved: /resume (here or in the app) shows the answer (A5).
    const { db } = await import("../src/db");
    const { sessionMessages } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const saved = async () =>
      (await db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, s.sessionId!))).map((r) => `${r.role}:${r.content}`);
    for (let i = 0; i < 100 && !(await saved()).includes("assistant:Recovered after compacting."); i++) await new Promise((r) => setTimeout(r, 50));
    expect((await saved()).slice(-2)).toEqual(["user:go on", "assistant:Recovered after compacting."]);
  }, 180_000);
});
