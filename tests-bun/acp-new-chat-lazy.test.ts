/**
 * Every New chat in an editor (the VS Code panel's button and command, Zed's
 * new thread) used to store an empty "Untitled" session and a live-session row
 * at once, so clicking New chat 8 times left 8 of each, and the stored ones
 * outlived the editor (QA 4(a), 2026-10-22). A new chat now has its id at
 * `session/new` and is stored, under that id, at its first message.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { startFakeLlm } from "./fixtures/fake-llm";

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acp-lazy-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  process.env.ATLARIX_PEER_SURFACE = "editor";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "acp-lazy-ws-"));
});

async function editor() {
  const llm = startFakeLlm([{ text: "Hello." }]);
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
  const conn = acp
    .client({ name: "test-editor" })
    .onNotification("session/update", () => {})
    .connect(buildAgentApp(agent, "test"));
  await conn.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  return { llm, conn };
}

async function storedSessionIds(): Promise<string[]> {
  const { db } = await import("../src/db");
  const { chatSessions } = await import("../src/db/schema");
  return (await db.select({ id: chatSessions.id }).from(chatSessions)).map((r) => r.id);
}

describe("an editor's New chat", () => {
  it("stores nothing until the first message, then exactly one session under the id it was given", async () => {
    const e = await editor();
    const before = await storedSessionIds();
    const { localSessionIds } = await import("../src/lib/peers/peers");
    // Other files in this process leave their own sessions registered.
    const liveBefore = new Set(localSessionIds());
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] })).sessionId);
    }
    expect(new Set(ids).size).toBe(5);
    expect(await storedSessionIds()).toEqual(before);
    // At most the process's one placeholder, never a row per click.
    expect(localSessionIds().filter((id) => ids.includes(id))).toEqual([]);
    expect(localSessionIds().filter((id) => !liveBefore.has(id)).length).toBeLessThanOrEqual(1);

    const last = ids[4]!;
    await e.conn.agent.request("session/prompt", { sessionId: last, prompt: [{ type: "text", text: "hi" }] });
    const after = (await storedSessionIds()).filter((id) => !before.includes(id));
    expect(after).toEqual([last]);
    expect(localSessionIds()).toContain(last);
    e.llm.close?.();
  }, 60_000);

  it("a mode chosen before the first message is stored with the session (QA E1)", async () => {
    const e = await editor();
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await e.conn.agent.request("session/set_config_option", { sessionId, configId: "mode", value: "ask" } as never);
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
    const { db } = await import("../src/db");
    const { chatSessions } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const row = await db.query.chatSessions.findFirst({ where: eq(chatSessions.id, sessionId) });
    expect(row?.workMode).toBe("ask");
    e.llm.close?.();
  }, 60_000);

  it("an empty new chat reopened after the agent restarted comes back, still unstored", async () => {
    const first = await editor();
    const { sessionId } = await first.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    first.llm.close?.();
    // A fresh agent: what the editor sees after the agent process restarts.
    const second = await editor();
    await second.conn.agent.request("session/load", { sessionId, cwd: ws, mcpServers: [] });
    expect(await storedSessionIds()).not.toContain(sessionId);
    await second.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
    expect(await storedSessionIds()).toContain(sessionId);
    second.llm.close?.();
  }, 60_000);
});
