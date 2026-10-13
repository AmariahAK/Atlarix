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

async function editor(
  script: Reply[],
  decide: Decide = () => ({ outcome: "selected", optionId: "once" }),
  clientCapabilities: acp.ClientCapabilities = {},
) {
  const llm = startFakeLlm(script);
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
  const updates: SessionNotification[] = [];
  const asked: RequestPermissionRequest[] = [];
  /** Atlarix's own notifications to its extension (`_atlarix/*`). */
  const ext: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = acp
    .client({ name: "test-editor" })
    .onRequest("session/request_permission", (ctx) => {
      asked.push(ctx.params);
      return { outcome: decide(ctx.params) };
    })
    .onNotification("session/update", (ctx) => {
      updates.push(ctx.params);
    })
    .onNotification("_atlarix/tasks_changed", (p) => p as Record<string, unknown>, (ctx) => {
      ext.push({ method: "_atlarix/tasks_changed", params: ctx.params });
    })
    .onNotification("_atlarix/background_ready", (p) => p as Record<string, unknown>, (ctx) => {
      ext.push({ method: "_atlarix/background_ready", params: ctx.params });
    });
  const conn = client.connect(buildAgentApp(agent, "test"));
  const init = await conn.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities });
  const text = (sessionId: string) =>
    updates
      .filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk")
      .map((u) => ((u.update as { content: { text?: string } }).content.text ?? ""))
      .join("");
  return { llm, agent, conn, init, updates, asked, text, ext };
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

  it("Plan → Build: the plan goes out as a plan list, and the mode picker follows the switch to Build", async () => {
    const e = await editor([
      { tool: "plan", args: { operation: "write", title: "Add a health endpoint", content: "# Add a health endpoint\n\n- [ ] Add GET /health\n- [ ] Test it" } },
      { text: "The plan is ready." },
      { text: "Building it now." },
    ]);
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await e.conn.agent.request("session/set_config_option", { sessionId, configId: "mode", value: "plan" });
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "plan a /health endpoint" }] });
    await Bun.sleep(300);
    const plan = e.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "plan").at(-1)?.update as
      | { entries: Array<{ content: string; status: string }>; _meta?: unknown }
      | undefined;
    expect(plan?.entries.map((x) => x.content)).toEqual(["Add GET /health", "Test it"]);
    expect(plan?.entries.every((x) => x.status === "pending")).toBe(true);
    // A plain editor gets the list, not Atlarix's extras.
    expect(plan?._meta).toBeUndefined();

    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/build" }] });
    await Bun.sleep(200);
    const mine = e.updates.filter((u) => u.sessionId === sessionId).map((u) => u.update);
    expect(mine).toContainEqual(expect.objectContaining({ sessionUpdate: "current_mode_update", currentModeId: "build" }));
    const cfg = mine.filter((u) => u.sessionUpdate === "config_option_update").at(-1) as
      | { configOptions: Array<{ id: string; currentValue: unknown }> }
      | undefined;
    expect(cfg?.configOptions.find((o) => o.id === "mode")?.currentValue).toBe("build");
    // The plan stays on screen through the build (it used to be cleared the moment Build started).
    const after = mine.filter((u) => u.sessionUpdate === "plan").at(-1) as { entries: unknown[] } | undefined;
    expect(after?.entries.length).toBe(2);
  }, 60_000);

  it("Atlarix's own extension also gets the plan document and whether it can be built", async () => {
    const e = await editor(
      [
        { tool: "plan", args: { operation: "write", title: "Rename a flag", content: "# Rename a flag\n\n- [ ] Rename it\n- [x] Agree the name" } },
        { text: "Ready." },
      ],
      undefined,
      { _meta: { atlarix: { version: 1 } } },
    );
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await e.conn.agent.request("session/set_config_option", { sessionId, configId: "mode", value: "plan" });
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "plan a rename" }] });
    await Bun.sleep(300);
    const plan = e.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "plan").at(-1)?.update as
      | { entries: Array<{ content: string; status: string }>; _meta?: { atlarix?: { plan?: Record<string, unknown> } } }
      | undefined;
    expect(plan?.entries.map((x) => x.status)).toEqual(["pending", "completed"]);
    expect(plan?._meta?.atlarix?.plan).toMatchObject({ title: "Rename a flag", buildable: true });
    expect(String(plan?._meta?.atlarix?.plan?.content)).toContain("Rename it");
    const status = await e.conn.agent.request<{ chrome: string }>("_atlarix/status", {});
    expect(typeof status.chrome).toBe("string");
  }, 60_000);

  it("a reopened chat shows its ready plan again, buildable (QA #54)", async () => {
    const extras = { _meta: { atlarix: { version: 1 } } };
    const plan = { tool: "plan", args: { operation: "write", title: "Add a ping route", content: "# Add a ping route\n\n- [ ] Add GET /ping\n- [ ] Test it" } } as const;
    const first = await editor([plan, { text: "Ready." }], undefined, extras);
    const { sessionId } = await first.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await first.conn.agent.request("session/set_config_option", { sessionId, configId: "mode", value: "plan" });
    await first.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "plan a ping route" }] });
    await Bun.sleep(300);

    // The same process, the chat opened again (Past chats): its screen was cleared.
    const before = first.updates.length;
    await first.conn.agent.request("session/load", { sessionId, cwd: ws, mcpServers: [] });
    await Bun.sleep(200);
    const again = first.updates.slice(before).filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "plan").at(-1)?.update as
      | { entries: Array<{ content: string }>; _meta?: { atlarix?: { plan?: Record<string, unknown> } } }
      | undefined;
    expect(again?.entries.map((x) => x.content)).toEqual(["Add GET /ping", "Test it"]);
    expect(again?._meta?.atlarix?.plan).toMatchObject({ title: "Add a ping route", buildable: true });
    await first.agent.closeAll();

    // A new process (the editor restarted): the stored chat brings its plan back too.
    const second = await editor([], undefined, extras);
    await second.conn.agent.request("session/load", { sessionId, cwd: ws, mcpServers: [] });
    await Bun.sleep(200);
    const loaded = second.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "plan").at(-1)?.update as
      | { _meta?: { atlarix?: { plan?: Record<string, unknown> } } }
      | undefined;
    expect(loaded?._meta?.atlarix?.plan).toMatchObject({ title: "Add a ping route", buildable: true });
  }, 60_000);

  it("automations: the editor's page manages them, and /automations answers in any editor", async () => {
    const e = await editor([{ text: "ok" }], undefined, { _meta: { atlarix: { version: 1 } } });
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    type Page = { automations: Array<{ id: string; name: string; enabled: boolean; runMode: string }> };
    const draft = { name: "Tests every morning", enabled: true, trigger: { kind: "schedule", cron: "0 9 * * 1-5" }, prompt: "Run the tests and say what fails.", runMode: "read-only", notifyAgent: false, model: null };
    const made = await e.conn.agent.request<Page>("_atlarix/automations", { sessionId, action: "create", draft });
    const mine = made.automations.find((a) => a.name === "Tests every morning")!;
    expect(mine).toMatchObject({ enabled: true, runMode: "read-only" });

    const off = await e.conn.agent.request<Page>("_atlarix/automations", { sessionId, action: "toggle", id: mine.id, enabled: false });
    expect(off.automations.find((a) => a.id === mine.id)?.enabled).toBe(false);

    // Plain ACP editors: the list as a message, and on/off by name.
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/automations" }] });
    expect(e.text(sessionId)).toContain("Tests every morning");
    expect(e.text(sessionId)).toContain("weekday mornings (off)");
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/automations on tests every" }] });
    expect(e.text(sessionId)).toContain("“Tests every morning” is on.");
    await Bun.sleep(200);
    const commands = e.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "available_commands_update").at(-1)?.update as { availableCommands: Array<{ name: string }> } | undefined;
    expect(commands?.availableCommands.map((c) => c.name)).toContain("automations");

    const gone = await e.conn.agent.request<Page>("_atlarix/automations", { sessionId, action: "remove", id: mine.id });
    expect(gone.automations.some((a) => a.id === mine.id)).toBe(false);
  }, 60_000);

  it("automations: the agent makes one with its tool, after the editor's Allow", async () => {
    const e = await editor([
      {
        tool: "automations",
        args: {
          operation: "create",
          name: "Nightly lint",
          trigger: { kind: "schedule", cron: "0 2 * * *" },
          run_mode: "read-only",
          prompt: "Run the linter and list new warnings.",
          notify_agent: true,
        },
      },
      { text: "Set up: Nightly lint runs at 2am and its results come to me." },
    ]);
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    const r = await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "lint every night and tell me" }] });
    expect(r.stopReason).toBe("end_turn");
    // A standing job is the user's call: the editor was asked first.
    const ask = e.asked.find((a) => a.sessionId === sessionId);
    expect(ask?.toolCall.title).toBe("Create this automation?");
    expect(JSON.stringify(ask?.toolCall.content)).toContain("Nightly lint");
    const page = await e.conn.agent.request<{ automations: Array<{ name: string; notifyAgent: boolean; trigger: { cron?: string } }> }>("_atlarix/automations", { sessionId, action: "list" });
    expect(page.automations.find((a) => a.name === "Nightly lint")).toMatchObject({ notifyAgent: true, trigger: { cron: "0 2 * * *" } });
  }, 60_000);

  it("Atlarix's extension: a message sent while it works steers the turn (Enter) or waits for the next (Tab)", async () => {
    const pending: unknown[] = [];
    const e = await editor(
      [
        { tool: "run_command", args: { command: "sleep 1", description: "wait" }, delayMs: 50 },
        { text: "Done. STEER-OK" },
        { text: "Queued one answered." },
      ],
      undefined,
      { _meta: { atlarix: { version: 1 } } },
    );
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    const turn = e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "wait a second" }] });
    await Bun.sleep(150);
    const steer = await e.conn.agent.request<{ started: boolean }>("_atlarix/interject", { sessionId, text: "Also end with STEER-OK", kind: "steer" });
    const queued = await e.conn.agent.request<{ started: boolean; pending: Array<{ kind: string }> }>("_atlarix/interject", { sessionId, text: "then say QUEUED-2", kind: "queue" });
    expect(steer.started).toBe(true);
    expect(queued.pending.map((p) => p.kind)).toContain("queued");
    void pending;
    await turn;
    await Bun.sleep(1500);
    // The steer reached the model inside the running turn; the queued one opened the next turn.
    const asked = e.llm.requests.map((r) => JSON.stringify(r.messages));
    expect(asked.some((m) => m.includes("Also end with STEER-OK"))).toBe(true);
    expect(asked.some((m) => m.includes("then say QUEUED-2"))).toBe(true);
    // Idle: nothing to steer, the editor sends a prompt instead.
    const idle = await e.conn.agent.request<{ started: boolean }>("_atlarix/interject", { sessionId, text: "hello", kind: "steer" });
    expect(idle.started).toBe(false);
  }, 60_000);

  it("a finished automation never wakes the chat; it goes into your next message (QA: 11 wake turns in a row)", async () => {
    const e = await editor(
      [{ text: "Working on it, this takes a moment to finish.", delayMs: 60 }, { text: "The automation said the tests fail; here's why." }],
      undefined,
      { _meta: { atlarix: { version: 1 } } },
    );
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    const { appId } = e.agent.sessionInfo(sessionId);
    const { recordAutomationResult } = await import("../src/lib/agent/automation-results");
    const turn = e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "do a thing" }] });
    // Once the turn's request is out (its context already built), as a run
    // finishing mid-turn does.
    const sent = Date.now();
    while (!e.llm.requests.some((r) => (r as { tools?: unknown[] }).tools?.length) && Date.now() - sent < 10_000) await Bun.sleep(10);
    await Bun.sleep(20);
    // Finishes while the turn runs, as QA's 'Run now' right after Allow did.
    recordAutomationResult(appId, { automationId: "a1", automationName: "Weekday tests", status: "error", body: "2 failing: subtract", finishedAt: Date.now() });
    await turn;
    await Bun.sleep(1500);
    const turns = () => e.llm.requests.filter((r) => (r as { tools?: unknown[] }).tools?.length).length;
    expect(turns()).toBe(1); // no wake turns
    expect(e.ext.some((x) => x.method === "_atlarix/background_ready")).toBe(false);
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "anything new?" }] });
    expect(turns()).toBe(2);
    expect(JSON.stringify(e.llm.requests.at(-1)?.messages)).toContain("2 failing: subtract");
  }, 60_000);

  it("loading a session this process already has open replays it in full", async () => {
    const e = await editor([{ text: "The codeword is heron." }]);
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "codeword?" }] });
    await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    const before = e.updates.length;
    await e.conn.agent.request("session/load", { sessionId, cwd: ws, mcpServers: [] });
    const replayed = e.updates.slice(before).filter((u) => u.sessionId === sessionId);
    expect(replayed.some((u) => u.update.sessionUpdate === "user_message_chunk")).toBe(true);
    expect(JSON.stringify(replayed)).toContain("heron");
  }, 60_000);

  it("/mcp and /status answer as a message in editors with no Atlarix panel", async () => {
    const e = await editor([]);
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    const r = await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/mcp" }] });
    expect(r.stopReason).toBe("end_turn");
    expect(e.text(sessionId)).toContain("MCP servers");
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/status" }] });
    // The test data folder has no sign-in: the answer says how to sign in.
    expect(e.text(sessionId)).toMatch(/atlarix login|Atlarix status/);
  }, 60_000);

  it("a session that cannot start says why, not just \"Internal error\"", async () => {
    const { AcpAgent } = await import("../src/cli/acp/agent");
    const { buildAgentApp } = await import("../src/cli/acp/server");
    const agent = new AcpAgent({
      createSession: async () => {
        throw new Error("The Atlarix desktop app on this computer is older than this CLI");
      },
      models: async () => ({ options: [] }),
      rememberModel: () => {},
      listSessions: async () => [],
    });
    const conn = acp.client({ name: "t" }).connect(buildAgentApp(agent, "test"));
    await conn.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const err = await conn.agent.request("session/new", { cwd: ws, mcpServers: [] }).then(() => null, (e: Error) => e);
    expect(String((err as { message?: string })?.message)).toContain("older than this CLI");
  }, 60_000);
  it("Atlarix's extension: Restore files only puts the file back, keeps the chat, and tells the agent next time (QA E3)", async () => {
    const file = path.join(ws, "restore-only.ts");
    fs.writeFileSync(file, "export const r = 1;\n");
    const e = await editor(
      [
        { tool: "edit_file", args: { path: "restore-only.ts", operation: "replace", old_content: "export const r = 1;", new_content: "export const r = 2;" } },
        { text: "Set r to 2." },
        { text: "Understood." },
      ],
      undefined,
      { _meta: { atlarix: { version: 1 } } },
    );
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "set r to 2" }] });
    expect(fs.readFileSync(file, "utf8")).toContain("r = 2");
    const { messages } = await e.conn.agent.request<{ messages: Array<{ id: number; text: string }> }>("_atlarix/undo", { sessionId, action: "list" });
    const r = await e.conn.agent.request<{ restoredFiles: number }>("_atlarix/undo", { sessionId, action: "restore_files", messageId: messages[0]!.id });
    expect(r.restoredFiles).toBeGreaterThan(0);
    expect(fs.readFileSync(file, "utf8")).toContain("r = 1");
    // The conversation is untouched.
    const after = await e.conn.agent.request<{ messages: Array<{ text: string }> }>("_atlarix/undo", { sessionId, action: "list" });
    expect(after.messages.map((m) => m.text)).toEqual(["set r to 2"]);
    // The next message tells the agent the edit is gone, once.
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "what is r now?" }] });
    const last = JSON.stringify(e.llm.requests.at(-1)?.messages ?? []);
    expect(last).toContain("restored these files");
    expect(last).toContain("restore-only.ts");
  }, 60_000);

  it("Atlarix's extension: going back to an earlier message puts the file back and carries on from there", async () => {
    const file = path.join(ws, "undo.ts");
    fs.writeFileSync(file, "export const u = 1;\n");
    const e = await editor(
      [
        { tool: "edit_file", args: { path: "undo.ts", operation: "replace", old_content: "export const u = 1;", new_content: "export const u = 2;" } },
        { text: "Set u to 2." },
        { text: "Noted." },
        { text: "Done differently." },
      ],
      undefined,
      { _meta: { atlarix: { version: 1 } } },
    );
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "set u to 2" }] });
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "thanks" }] });
    expect(fs.readFileSync(file, "utf8")).toContain("u = 2");
    await Bun.sleep(200);

    // Each message the editor drew live is named by an echo carrying its stored id.
    const echoes = e.updates
      .filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "user_message_chunk")
      .map((u) => (u.update as { _meta?: { atlarix?: { messageId?: number; echo?: boolean } } })._meta?.atlarix);
    expect(echoes.length).toBe(2);
    expect(echoes.every((m) => m?.echo === true && typeof m.messageId === "number")).toBe(true);

    const { messages } = await e.conn.agent.request<{ messages: Array<{ id: number; text: string }> }>("_atlarix/undo", { sessionId, action: "list" });
    expect(messages.map((m) => m.text)).toEqual(["thanks", "set u to 2"]);
    const first = messages[1]!;
    expect(first.id).toBe(echoes[0]!.messageId!);
    const preview = await e.conn.agent.request<{ filesChanged: string[] }>("_atlarix/undo", { sessionId, action: "preview", messageId: first.id });
    expect(preview.filesChanged.some((f) => f.endsWith("undo.ts"))).toBe(true);

    const before = e.updates.length;
    const r = await e.conn.agent.request<{ stopReason: string }>("_atlarix/undo", {
      sessionId,
      action: "resend",
      messageId: first.id,
      text: "leave u alone",
      restore: true,
    });
    expect(r.stopReason).toBe("end_turn");
    expect(fs.readFileSync(file, "utf8")).toContain("u = 1");
    // The editor cleared its view: the transcript comes again from the top, the edited message with its id.
    const again = e.updates.slice(before).filter((u) => u.sessionId === sessionId);
    const users = again.filter((u) => u.update.sessionUpdate === "user_message_chunk").map((u) => (u.update as { content: { text: string } }).content.text);
    expect(users).toEqual(["leave u alone"]);
    const replied = again
      .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
      .map((u) => (u.update as { content: { text: string } }).content.text)
      .join("");
    expect(replied).toContain("Done differently.");
    const after = await e.conn.agent.request<{ messages: Array<{ text: string }> }>("_atlarix/undo", { sessionId, action: "list" });
    expect(after.messages.map((m) => m.text)).toEqual(["leave u alone"]);
  }, 90_000);

  it("Atlarix's extension: a background command is listed, and finishing it wakes the agent", async () => {
    const e = await editor(
      [
        { tool: "run_command", args: { command: "sleep 1 && echo built-ok", description: "build in the background", background: true } },
        { text: "Started the build." },
        { text: "The build finished." },
      ],
      undefined,
      { _meta: { atlarix: { version: 1 } } },
    );
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    const r = await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "build it in the background" }] });
    expect(r.stopReason).toBe("end_turn");

    const { tasks } = await e.conn.agent.request<{ tasks: Array<{ id: string; kind: string; label: string; canStop: boolean }> }>(
      "_atlarix/tasks",
      { sessionId, action: "list" },
    );
    const job = tasks.find((t) => t.kind === "command" && t.label.includes("sleep 1"));
    expect(job?.canStop).toBe(true);

    // The job ends: the extension is told what is running changed, and that the agent can be woken.
    const deadline = Date.now() + 15_000;
    while (!e.ext.some((n) => n.method === "_atlarix/background_ready") && Date.now() < deadline) await Bun.sleep(100);
    expect(e.ext.find((n) => n.method === "_atlarix/background_ready")?.params.sessionId).toBe(sessionId);
    expect(e.ext.some((n) => n.method === "_atlarix/tasks_changed" && n.params.sessionId === sessionId)).toBe(true);

    // The extension opens the wake turn; the agent deals with the result.
    const w = await e.conn.agent.request("session/prompt", {
      sessionId,
      prompt: [],
      _meta: { atlarix: { wakeTurn: true } },
    });
    expect(w.stopReason).toBe("end_turn");
    expect(e.text(sessionId)).toContain("The build finished.");
    // The wake turn adds its reply; the one before it is not sent again.
    expect(e.text(sessionId).split("Started the build.").length - 1).toBe(1);
  }, 90_000);

  it("another editor is never sent a turn it did not ask for", async () => {
    const e = await editor([
      { tool: "run_command", args: { command: "sleep 1 && echo done", description: "wait", background: true } },
      { text: "Started." },
    ]);
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    const sent = e.updates.length;
    await Bun.sleep(3_000);
    expect(e.ext).toEqual([]);
    expect(e.text(sessionId)).not.toContain("The build finished.");
    expect(e.updates.slice(sent).filter((u) => u.update.sessionUpdate === "agent_message_chunk")).toEqual([]);
  }, 60_000);

  it("Past chats: rename and delete a stored chat, open or not", async () => {
    const e = await editor([{ text: "One." }, { text: "Two." }]);
    const a = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await e.conn.agent.request("session/prompt", { sessionId: a.sessionId, prompt: [{ type: "text", text: "first chat" }] });
    const b = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await e.conn.agent.request("session/prompt", { sessionId: b.sessionId, prompt: [{ type: "text", text: "second chat" }] });

    await e.conn.agent.request("_atlarix/session", { sessionId: a.sessionId, action: "rename", title: "Cache work" });
    let list = await e.conn.agent.request("session/list", { cwd: ws });
    expect(list.sessions.find((s) => s.sessionId === a.sessionId)?.title).toBe("Cache work");

    await e.conn.agent.request("_atlarix/session", { sessionId: b.sessionId, action: "delete" });
    list = await e.conn.agent.request("session/list", { cwd: ws });
    expect(list.sessions.map((s) => s.sessionId)).not.toContain(b.sessionId);
    expect(list.sessions.map((s) => s.sessionId)).toContain(a.sessionId);
  }, 60_000);

  it("the model picker comes grouped by provider", async () => {
    const e = await editor([]);
    const s = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    const model = s.configOptions?.find((o) => o.id === "model") as { options: Array<{ group?: string; options?: unknown[] }> } | undefined;
    expect(model?.options[0]?.group).toBeTruthy();
    expect(model?.options[0]?.options?.length).toBe(1);
  }, 60_000);

  it("/keys answers in the thread, and adding one points to the terminal", async () => {
    const e = await editor([]);
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/keys add openai" }] });
    expect(e.text(sessionId)).toContain("atlarix keys add openai");
    expect(e.llm.requests?.length ?? 0).toBe(0);
  }, 60_000);

  it("this folder's skills are / commands, and /skill asks for that skill", async () => {
    const skills = path.join(ws, ".atlarix", "skills");
    fs.mkdirSync(skills, { recursive: true });
    fs.writeFileSync(path.join(skills, "deploy.md"), "---\nname: deploy\ndescription: Ship the app to staging.\n---\nRun the deploy script.\n");
    const e = await editor([{ text: "Deploying." }]);
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await Bun.sleep(400);
    const lists = e.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "available_commands_update");
    const names = (lists.at(-1)?.update as { availableCommands: Array<{ name: string }> }).availableCommands.map((c) => c.name);
    expect(names).toContain("deploy");
    expect(names).toContain("keys");
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/deploy to staging" }] });
    const sent = JSON.stringify(e.llm.requests?.at(-1) ?? "");
    expect(sent).toContain(".atlarix/skills/deploy.md");
    fs.rmSync(path.join(ws, ".atlarix", "skills"), { recursive: true, force: true });
  }, 60_000);

  it("Compare at a checkpoint: the files changed since a message, and each one's version from before", async () => {
    const file = path.join(ws, "cmp.ts");
    fs.writeFileSync(file, "export const c = 1;\n");
    const e = await editor(
      [
        { tool: "edit_file", args: { path: "cmp.ts", operation: "replace", old_content: "export const c = 1;", new_content: "export const c = 2;" } },
        { text: "Done." },
      ],
      undefined,
      { _meta: { atlarix: { version: 1 } } },
    );
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "set c to 2" }] });
    const { messages } = await e.conn.agent.request<{ messages: Array<{ id: number }> }>("_atlarix/undo", { sessionId, action: "list" });
    const { files } = await e.conn.agent.request<{ files: Array<{ path: string; turnId: string; created: boolean }> }>("_atlarix/checkpoint", {
      sessionId,
      action: "files",
      messageId: messages[0]!.id,
    });
    const f = files.find((x) => x.path.endsWith("cmp.ts"))!;
    expect(f.created).toBe(false);
    const { file: before } = await e.conn.agent.request<{ file: { existed: boolean; content: string } }>("_atlarix/checkpoint", {
      sessionId,
      action: "before",
      turnId: f.turnId,
      path: f.path,
    });
    expect(before).toEqual({ existed: true, content: "export const c = 1;\n" });
    expect(fs.readFileSync(file, "utf8")).toContain("c = 2");
  }, 90_000);

  it("Auto-approve: edits in this folder without asking, then back to asking", async () => {
    const e = await editor([]);
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    const on = await e.conn.agent.request<{ folderEdits: boolean }>("_atlarix/permissions", { sessionId, action: "edits", on: true });
    expect(on.folderEdits).toBe(true);
    const off = await e.conn.agent.request<{ folderEdits: boolean; rules: unknown[] }>("_atlarix/permissions", { sessionId, action: "edits", on: false });
    expect(off.folderEdits).toBe(false);
    expect(Array.isArray(off.rules)).toBe(true);
  }, 60_000);

  it("Past chats: this folder's with mode and star, every folder's with its folder", async () => {
    const e = await editor([{ text: "Hi." }]);
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });
    const mine = await e.conn.agent.request<{ sessions: Array<{ sessionId: string; mode: string | null; starred: boolean }> }>("_atlarix/sessions", { cwd: ws });
    expect(mine.sessions.find((s) => s.sessionId === sessionId)?.starred).toBe(false);
    const all = await e.conn.agent.request<{ sessions: Array<{ sessionId: string; folder?: string }> }>("_atlarix/sessions", { all: true });
    expect(all.sessions.find((s) => s.sessionId === sessionId)?.folder).toBeTruthy();
  }, 60_000);
});
