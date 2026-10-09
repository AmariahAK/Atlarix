/**
 * `atlarix acp` end to end, minus the pipes: the real ACP method table
 * (buildAgentApp) and the real agent loop, against a scripted model, with the
 * SDK's own client standing in for the editor.
 *
 * What an editor relies on: a prompt resolves when the turn ends; text and tool
 * calls arrive as updates; an edit asks Allow/Deny with its diff, and the answer
 * is obeyed; modes switch; past sessions
 * list and replay; and each thread's approvals reach that thread. Cancel, and
 * stdout carrying nothing but JSON-RPC, are tested over real pipes: acp-stdio.test.ts.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { RequestPermissionRequest, SessionNotification } from "@agentclientprotocol/sdk";
import { startFakeLlm, type Reply } from "./fixtures/fake-llm";

let ws: string;

beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acp-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  process.env.ATLARIX_PEER_SURFACE = "editor";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "acp-ws-"));
});

type Decide = (req: RequestPermissionRequest) => acp.RequestPermissionOutcome;

async function editor(script: Reply[], decide: Decide = () => ({ outcome: "selected", optionId: "once" })) {
  const llm = startFakeLlm(script);
  const { AgentSession, seedDevProvider, listFolderSessions } = await import("../src/cli/agent/session");
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
  });
  const updates: SessionNotification[] = [];
  const asked: RequestPermissionRequest[] = [];
  const client = acp
    .client({ name: "test-editor" })
    .onRequest("session/request_permission", (ctx) => {
      asked.push(ctx.params);
      return { outcome: decide(ctx.params) };
    })
    .onNotification("session/update", (ctx) => {
      updates.push(ctx.params);
    });
  const conn = client.connect(buildAgentApp(agent, "test"));
  const init = await conn.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  const text = (sessionId: string) =>
    updates
      .filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk")
      .map((u) => ((u.update as { content: { text?: string } }).content.text ?? ""))
      .join("");
  return { llm, agent, conn, init, updates, asked, text };
}

describe("atlarix acp", () => {
  it("initializes as Atlarix with sign-in methods, and runs a text turn", async () => {
    const e = await editor([{ text: "Hello from Atlarix." }]);
    expect(e.init.agentInfo?.name).toBe("atlarix");
    expect(e.init.agentCapabilities?.loadSession).toBe(true);
    expect(e.init.authMethods?.map((m) => m.id)).toEqual(["atlarix-browser", "atlarix-login"]);

    const s = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    expect(s.sessionId).toBeTruthy();
    expect(s.configOptions?.map((o) => o.id)).toEqual(["mode", "model"]);
    expect(s.modes?.currentModeId).toBe("build");

    const r = await e.conn.agent.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "hi" }] });
    expect(r.stopReason).toBe("end_turn");
    expect(e.text(s.sessionId)).toContain("Hello from Atlarix.");
  }, 60_000);

  it("an edit asks Allow/Deny with its diff, and Allow makes the change", async () => {
    const file = path.join(ws, "v.ts");
    fs.writeFileSync(file, "export const v = 1;\n");
    const e = await editor([
      { tool: "edit_file", args: { path: "v.ts", operation: "replace", old_content: "export const v = 1;", new_content: "export const v = 2;" } },
      { text: "Changed v." },
    ]);
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    const r = await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "set v to 2" }] });
    expect(r.stopReason).toBe("end_turn");
    expect(fs.readFileSync(file, "utf8")).toContain("v = 2");
    expect(e.asked).toHaveLength(1);
    expect(e.asked[0]!.sessionId).toBe(sessionId);
    // The prompt lives inside the edit's own tool call (one card in the editor).
    const owner = e.updates.find(
      (u) => u.update.sessionUpdate === "tool_call" && u.update.toolCallId === e.asked[0]!.toolCall.toolCallId,
    );
    expect(owner?.update).toMatchObject({ kind: "edit" });
    expect(e.asked[0]!.toolCall.content?.[0]).toMatchObject({ type: "diff", newText: expect.stringContaining("v = 2") });
    expect(e.asked[0]!.options.map((o) => o.kind)).toContain("reject_once");
    const kinds = e.updates.filter((u) => u.sessionId === sessionId).map((u) => u.update.sessionUpdate);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_call_update");
    expect(e.text(sessionId)).toContain("Changed v.");
  }, 60_000);

  it("No is obeyed: the command never runs", async () => {
    const doomed = path.join(ws, "doomed.txt");
    fs.writeFileSync(doomed, "keep me");
    const e = await editor(
      [
        { tool: "run_command", args: { command: "rm doomed.txt", description: "remove the file" } },
        { text: "Okay, I left it." },
      ],
      () => ({ outcome: "selected", optionId: "deny" }),
    );
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    const r = await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "delete doomed.txt" }] });
    expect(r.stopReason).toBe("end_turn");
    const owner = e.updates.find(
      (u) => u.update.sessionUpdate === "tool_call" && u.update.toolCallId === e.asked[0]!.toolCall.toolCallId,
    );
    expect(owner?.update).toMatchObject({ kind: "execute" });
    expect(fs.existsSync(doomed)).toBe(true);
  }, 60_000);

  it("switches mode through the config option and the legacy set_mode", async () => {
    const e = await editor([]);
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    const r = await e.conn.agent.request("session/set_config_option", { sessionId, configId: "mode", value: "plan" });
    expect(r.configOptions.find((o) => o.id === "mode")).toMatchObject({ currentValue: "plan" });
    await e.conn.agent.request("session/set_mode", { sessionId, modeId: "ask" });
    const again = await e.conn.agent.request("session/set_config_option", { sessionId, configId: "mode", value: "ask" });
    expect(again.configOptions.find((o) => o.id === "mode")).toMatchObject({ currentValue: "ask" });
  }, 60_000);

  it("lists this folder's sessions and replays one on load", async () => {
    const first = await editor([{ text: "Remember the cache key." }]);
    const { sessionId } = await first.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await first.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "note this" }] });
    await first.agent.closeAll();

    const second = await editor([]);
    const list = await second.conn.agent.request("session/list", { cwd: ws });
    expect(list.sessions.map((s) => s.sessionId)).toContain(sessionId);
    await second.conn.agent.request("session/load", { sessionId, cwd: ws, mcpServers: [] });
    const replayed = second.updates.filter((u) => u.sessionId === sessionId);
    expect(replayed.some((u) => u.update.sessionUpdate === "user_message_chunk")).toBe(true);
    expect(second.text(sessionId)).toContain("Remember the cache key.");
  }, 60_000);

  it("an older thread's approval still reaches it after a newer thread opens", async () => {
    const e = await editor([
      { tool: "run_command", args: { command: "rm older.txt", description: "remove" } },
      { text: "Removed." },
    ]);
    fs.writeFileSync(path.join(ws, "older.txt"), "x");
    const older = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    const newer = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    // Both are still empty: the newer must not be handed the older's session.
    expect(newer.sessionId).not.toBe(older.sessionId);
    const r = await e.conn.agent.request("session/prompt", {
      sessionId: older.sessionId,
      prompt: [{ type: "text", text: "remove older.txt" }],
    });
    expect(r.stopReason).toBe("end_turn");
    expect(e.asked.map((a) => a.sessionId)).toEqual([older.sessionId]);
    expect(fs.existsSync(path.join(ws, "older.txt"))).toBe(false);
  }, 60_000);
});
