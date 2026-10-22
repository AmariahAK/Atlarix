/**
 * One CLI session sets another's mode and model through send_message (item 9),
 * end to end: the real tools, the real inbox and socket, main's check against
 * the models this user has set up, and the target session changing from its
 * next turn with a line saying who.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm } from "./fixtures/fake-llm";

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "peer-set-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "peer-set-ws-"));
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const idle = async (s: { state: { busy: boolean }; sessionId: string }) => {
  for (let i = 0; i < 300 && (s.state.busy || !s.sessionId); i++) await wait(100);
};

type Result = { success: boolean; text?: string; error?: string };
const run = async (tool: string, args: Record<string, unknown>): Promise<Result> => {
  const { ToolRegistry } = await import("../src/lib/tools/registry");
  await import("../src/lib/tools/peers");
  let raw = (await ToolRegistry.execute(tool, args)) as unknown;
  while (raw && typeof raw === "object" && "result" in raw && typeof (raw as { result: unknown }).result === "object") {
    raw = (raw as { result: unknown }).result;
  }
  return raw as Result;
};

describe("a session sets another's mode and model", () => {
  it("applies both from the target's next turn, with the line, and lists them", async () => {
    const llm = startFakeLlm([{ text: "Coordinating." }, { text: "Guarding." }]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const model = await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" });
    const coord = new AgentSession({ workspaceDir: ws, model });
    const guard = new AgentSession({ workspaceDir: ws, model });
    await coord.start();
    await guard.start();
    await coord.submit("hi");
    await idle(coord);
    await guard.submit("hi");
    await idle(guard);
    for (let i = 0; i < 50; i++) {
      const { peerInboxRunning } = await import("../src/lib/peers/peers");
      if (peerInboxRunning()) break;
      await wait(100);
    }
    await coord.rename("Rix");
    await guard.rename("Guard");

    const { loadModelOptions } = await import("../src/cli/agent/models");
    const label = (await loadModelOptions())[0]!.label;

    const set = await run("send_message", { to: guard.sessionId, mode: "review", model: label, workspaceSessionId: coord.sessionId });
    expect(set.success).toBe(true);
    expect(set.text).toContain(`Mode set to Review and model to ${label} by Rix. From the next turn.`);

    for (let i = 0; i < 50 && guard.state.mode !== "review"; i++) await wait(100);
    expect(guard.state.mode).toBe("review");
    expect(guard.model?.name).toBe((await loadModelOptions())[0]!.name);
    expect(JSON.stringify(guard.state.cells)).toContain("Mode set to Review");

    const { db } = await import("../src/db");
    const { chatSessions } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const row = await db.query.chatSessions.findFirst({ where: eq(chatSessions.id, guard.sessionId) });
    expect(row?.workMode).toBe("review");

    const list = await run("list_sessions", { workspaceSessionId: coord.sessionId });
    expect(list.text).toMatch(/Guard \(id [^)]*· Review · /);
    expect(list.text).toContain(`Models you can set: ${label}`);

    const refused = await run("send_message", { to: guard.sessionId, model: "GPT-6 Astra", workspaceSessionId: coord.sessionId });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("not a model this user has set up");

    await coord.close();
    await guard.close();
    llm.close?.();
  }, 90_000);
});
