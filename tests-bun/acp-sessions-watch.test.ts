/**
 * The panel's Past chats did not change while open: a chat the CLI saved only
 * appeared after it was reopened (QA 4(b), 2026-10-22). While a page watches
 * (`_atlarix/sessions_watch`), the agent says `_atlarix/sessions_changed` when
 * the stored chats change, and only then.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { startFakeLlm } from "./fixtures/fake-llm";

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acp-watch-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  process.env.ATLARIX_PEER_SURFACE = "editor";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "acp-watch-ws-"));
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Past chats follows the stored chats", () => {
  it("is told when a chat is stored elsewhere, and not when nothing changed", async () => {
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
    let changed = 0;
    const conn = acp
      .client({ name: "test-editor" })
      .onNotification("session/update", () => {})
      .onNotification("_atlarix/sessions_changed", (p) => p as Record<string, never>, () => void changed++)
      .connect(buildAgentApp(agent, "test"));
    await conn.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

    await conn.agent.request("_atlarix/sessions_watch" as never, { on: true } as never);
    await wait(2_500);
    expect(changed).toBe(0);

    // A chat stored by someone else: the CLI, in its own session.
    const cli = new AgentSession({ workspaceDir: ws, model });
    await cli.start();
    await cli.submit("hi");
    for (let i = 0; i < 100 && (cli.state.busy || !cli.sessionId); i++) await wait(100);
    await wait(2_500);
    expect(changed).toBeGreaterThan(0);

    await conn.agent.request("_atlarix/sessions_watch" as never, { on: false } as never);
    const seen = changed;
    await cli.rename("Renamed while nobody watches");
    await wait(2_500);
    expect(changed).toBe(seen);
    await cli.close();
    llm.close?.();
  }, 60_000);

  it("an open chat takes a name another process gives it (QA E4)", async () => {
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
    const titles: string[] = [];
    const conn = acp
      .client({ name: "test-editor" })
      .onNotification("session/update", (ctx) => {
        const u = ctx.params.update as { sessionUpdate: string; title?: string };
        if (u.sessionUpdate === "session_info_update" && u.title) titles.push(u.title);
      })
      .connect(buildAgentApp(agent, "test"));
    await conn.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
    // Another process renames it: straight in the database, as the CLI's rename lands for us.
    const { db } = await import("../src/db");
    const { chatSessions } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(chatSessions).set({ title: "Renamed in the CLI", titleSource: "user" } as never).where(eq(chatSessions.id, sessionId));
    for (let i = 0; i < 50 && !titles.includes("Renamed in the CLI"); i++) await wait(100);
    expect(titles).toContain("Renamed in the CLI");
    llm.close?.();
  }, 60_000);
});
