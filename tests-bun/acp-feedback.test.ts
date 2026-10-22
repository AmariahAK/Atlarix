/**
 * The session rating and /feedback over ACP (owner, 2026-10-22). Any editor
 * takes `/feedback [1|2|3] [text]`: answered by Atlarix, never sent to the
 * model. The VS Code panel draws its own rating card from `_atlarix/rating_due`
 * and answers it with `_atlarix/rate`; no editor gets an unprompted question in
 * the chat itself.
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { startFakeLlm } from "./fixtures/fake-llm";

const sent: Array<[unknown, unknown]> = [];
let asked = 0;
const real = await import("../src/main/lib/session-feedback");
mock.module("@/main/lib/session-feedback", () => ({
  ...real,
  sendSessionFeedback: async (answer: unknown, session: unknown) => (sent.push([answer, session]), { ok: true }),
  noteRatingAsked: () => void asked++,
  ratingAskedAt: () => undefined,
}));

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acp-fb-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  process.env.ATLARIX_PEER_SURFACE = "editor";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "acp-fb-ws-"));
});

async function editor() {
  const llm = startFakeLlm([{ text: "Hello." }, { text: "Again." }]);
  const { AgentSession, seedDevProvider, listFolderSessions, changeFolderSession } = await import("../src/cli/agent/session");
  const { AcpAgent } = await import("../src/cli/acp/agent");
  const { buildAgentApp } = await import("../src/cli/acp/server");
  const model = await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" });
  const agent = new AcpAgent({
    createSession: async (cwd) => {
      const s = new AgentSession({ workspaceDir: cwd, model, surface: "editor", idlePeerMessages: "hold" });
      await s.start();
      return s;
    },
    models: async () => ({ options: [{ ...model, label: "Fake" }], current: model }),
    rememberModel: () => {},
    listSessions: (cwd) => listFolderSessions(cwd),
    changeSession: (id, change) => changeFolderSession(id, change),
  });
  const chunks: string[] = [];
  const conn = acp
    .client({ name: "test-editor" })
    .onNotification("session/update", (ctx) => {
      const u = ctx.params.update as { sessionUpdate: string; content?: { text?: string } };
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.text) chunks.push(u.content.text);
    })
    .connect(buildAgentApp(agent, "test"));
  await conn.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  return { llm, conn, chunks };
}

describe("feedback from an editor", () => {
  it("/feedback rates and sends text, and the model never sees it", async () => {
    const e = await editor();
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/feedback 3 great at refactors" }] });
    expect(e.llm.requests?.length ?? 0).toBe(0);
    expect(sent.map((s) => s[0])).toEqual([
      { kind: "rating", rating: 3 },
      { kind: "text", body: "great at refactors" },
    ]);
    expect(sent[0]![1]).toMatchObject({ mode: "build", provider: expect.any(String), model: "fake-model" });
    expect(e.chunks.join("")).toContain("Thanks");
    expect(asked).toBe(1);
    e.llm.close?.();
  }, 60_000);

  it("the panel's card: due after the turns, once, and a dismissal sends nothing", async () => {
    sent.length = 0;
    process.env.ATLARIX_FORCE_RATING = "1";
    try {
      const e = await editor();
      const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
      const due = () => e.conn.agent.request("_atlarix/rating_due" as never, { sessionId } as never) as Promise<{ ask: boolean }>;
      expect((await due()).ask).toBe(false);
      await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
      expect((await due()).ask).toBe(true);
      await e.conn.agent.request("_atlarix/rate" as never, { sessionId, rating: 0 } as never);
      expect(sent).toHaveLength(0);
      expect((await due()).ask).toBe(false);
      e.llm.close?.();
    } finally {
      delete process.env.ATLARIX_FORCE_RATING;
    }
  }, 60_000);
});
