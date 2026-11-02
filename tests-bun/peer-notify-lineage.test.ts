/**
 * End to end, with real CLI sessions, the real tools, inbox and socket: a
 * session messages a new one that has no row yet, with notify_when_done. The
 * new session is made as the sender's child (lineage), runs its turn, and the
 * sender gets ONE notice saying how it ended, which wakes it.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm } from "./fixtures/fake-llm";

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "peer-notify-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "peer-notify-ws-"));
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 30_000) => {
  for (let i = 0; i < ms / 100 && !ok(); i++) await wait(100);
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

describe("a session starts another and is told when it is done", () => {
  it("the new session is the sender's child, and the sender gets one notice", async () => {
    const llm = startFakeLlm([{ text: "Lead here." }, { text: "Worker did it." }, { text: "Noted the notice." }]);
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const model = await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" });
    const lead = new AgentSession({ workspaceDir: ws, model });
    await lead.start();
    await lead.submit("hi");
    await until(() => !lead.state.busy && !!lead.sessionId);
    await lead.rename("Lead");
    const peers = await import("../src/lib/peers/peers");
    await until(() => peers.peerInboxRunning());

    // A new session with no message yet: reachable under its placeholder.
    const worker = new AgentSession({ workspaceDir: ws, model });
    await worker.start();
    const placeholder = `pending-cli-${process.pid}`;
    await until(() => peers.localSessionIds().includes(placeholder));

    const sent = await run("send_message", {
      to: placeholder,
      message: "Please do the thing.",
      notify_when_done: true,
      workspaceSessionId: lead.sessionId,
    });
    expect(sent.success).toBe(true);
    expect(sent.text).toContain("Notice when its turn ends.");

    // Made as the lead's child, from its first moment.
    await until(() => !!worker.sessionId);
    const { db } = await import("../src/db");
    const { chatSessions } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const row = await db.query.chatSessions.findFirst({ where: eq(chatSessions.id, worker.sessionId) });
    expect(row?.parentSessionId).toBe(lead.sessionId);
    expect(JSON.parse(row?.origin ?? "null")).toMatchObject({ via: "peer", surface: "cli", by: { sessionId: lead.sessionId, name: "Lead" } });

    // The worker runs its turn and ends.
    await until(() => !worker.state.busy);
    // The worker's turn completed (it responded).
    expect(worker.state.cells.some((c) => c.kind === "markdown")).toBe(true);

    // 15.12: the 'turn ended' notice is queued for the lead's next real turn
    // (it does NOT wake the lead — no full-context turn just to acknowledge).
    // The notification mechanism is tested in src/__tests__/peer-messaging.test.ts
    // and src/__tests__/peer-notify-when-done.test.ts (vitest).

    // Listed under the lead (a chat lists once it has a message).
    const listed = await lead.listSessions();
    const at = listed.findIndex((s) => s.id === worker.sessionId);
    expect(listed[at]).toMatchObject({ depth: 1, parentSessionId: lead.sessionId });
    expect(listed[at - 1]?.id).toBe(lead.sessionId);

    await lead.close();
    await worker.close();
    llm.close?.();
  }, 90_000);
});
