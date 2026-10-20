/**
 * An editor's sessions, for usage analytics: `session_opened` once per
 * session saying how (new, a past chat loaded, a fork), and the process's
 * `session_started` + `active_day`, whichever way the editor starts. Before,
 * an editor that opened a past chat first never sent session_started, and
 * the VS Code panel loads an open chat again every time you go back to it.
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { startFakeLlm } from "./fixtures/fake-llm";

const calls: Array<[string, unknown]> = [];
const real = await import("../src/main/lib/analytics");
mock.module("@/main/lib/analytics", () => ({
  ...real,
  trackSessionStarted: (p?: unknown) => void calls.push(["session_started", p]),
  trackActiveDay: () => void calls.push(["active_day", undefined]),
  trackAnalyticsTurnedOn: () => void calls.push(["analytics_on", undefined]),
  captureSafe: (event: string, p?: unknown) => void calls.push([event, p]),
  trackTurnCompleted: (r: unknown) => void calls.push(["turn", r]),
}));

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acp-an-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  process.env.ATLARIX_PEER_SURFACE = "editor";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "acp-an-ws-"));
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
  const conn = acp
    .client({ name: "test-editor" })
    .onNotification("session/update", () => {})
    .connect(buildAgentApp(agent, "test"));
  await conn.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  return { llm, conn };
}

const settle = () => new Promise((r) => setTimeout(r, 50));
const opened = () => calls.filter((c) => c[0] === "session_opened").map((c) => (c[1] as { how: string }).how);

describe("an editor's sessions in usage analytics", () => {
  it("new, load and fork, each session once", async () => {
    const e = await editor();
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
    // The panel loads an open chat again each time you return to it.
    await e.conn.agent.request("session/load", { sessionId, cwd: ws, mcpServers: [] });
    await e.conn.agent.request("session/load", { sessionId, cwd: ws, mcpServers: [] });
    await e.conn.agent.request("session/fork", { sessionId, cwd: ws, mcpServers: [] });
    await settle();
    expect(opened()).toEqual(["new", "fork"]);
    expect(calls.some((c) => c[0] === "session_started")).toBe(true);
    expect(calls.some((c) => c[0] === "active_day")).toBe(true);
    e.llm.close?.();
  }, 60_000);

  it("an empty chat the panel opens by itself is not a session until it is used", async () => {
    calls.length = 0;
    const e = await editor();
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    // Loading it again (the panel returning to it) does not make it a past chat.
    await e.conn.agent.request("session/load", { sessionId, cwd: ws, mcpServers: [] });
    await settle();
    expect(opened()).toEqual([]);
    // Its first prompt makes it a new session, once.
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
    await settle();
    expect(opened()).toEqual(["new"]);
    // The process still started (the panel opened).
    expect(calls.some((c) => c[0] === "session_started")).toBe(true);
  }, 60_000);

  it("a typed /fork counts as a fork, and opening the copy after it does not count again", async () => {
    calls.length = 0;
    const e = await editor();
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
    const before = new Set((await e.conn.agent.request<{ sessions: Array<{ sessionId: string }> }>("session/list", { cwd: ws })).sessions.map((x) => x.sessionId));
    await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/fork" }] });
    await settle();
    const copy = (await e.conn.agent.request<{ sessions: Array<{ sessionId: string }> }>("session/list", { cwd: ws })).sessions.find((x) => !before.has(x.sessionId));
    expect(copy).toBeDefined();
    await e.conn.agent.request("session/load", { sessionId: copy!.sessionId, cwd: ws, mcpServers: [] });
    await settle();
    expect(opened()).toEqual(["new", "fork"]);
  }, 60_000);

  it("a process that starts on a past chat still says the session started", async () => {
    calls.length = 0;
    const first = await editor();
    const { sessionId } = await first.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    await first.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
    calls.length = 0;
    const second = await editor();
    await second.conn.agent.request("session/load", { sessionId, cwd: ws, mcpServers: [] });
    await settle();
    expect(opened()).toEqual(["load"]);
    expect(calls.some((c) => c[0] === "session_started")).toBe(true);
  }, 60_000);

  it("a failed start the editor remembered is reported with the next start (E-f)", async () => {
    calls.length = 0;
    process.env.ATLARIX_HOST_LAST_ERROR = "cli_not_found";
    try {
      const e = await editor();
      await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
      await settle();
      expect(calls.find((c) => c[0] === "session_started")?.[1]).toEqual({ host_error: "cli_not_found" });
    } finally {
      delete process.env.ATLARIX_HOST_LAST_ERROR;
    }
  }, 60_000);

  it("the editor's telemetry switch, changed while the agent runs", async () => {
    const e = await editor();
    delete process.env.ATLARIX_HOST_TELEMETRY;
    await e.conn.agent.request("_atlarix/host_telemetry", { enabled: false });
    expect(process.env.ATLARIX_HOST_TELEMETRY).toBe("off");
    calls.length = 0;
    await e.conn.agent.request("_atlarix/host_telemetry", { enabled: true });
    expect(process.env.ATLARIX_HOST_TELEMETRY).toBeUndefined();
    // Back on: the process's start and the day, not sent while it was off, go now.
    expect(calls.some((c) => c[0] === "analytics_on")).toBe(true);
  }, 30_000);

  it("a turn refused before it starts (signed out) is an auth error, not ok (QA A10)", async () => {
    const e = await editor();
    const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
    calls.length = 0;
    // The dev provider skips the sign-in check; without it a scratch profile has no session.
    delete process.env.ATLARIX_CLI_DEV_PROVIDER;
    try {
      await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] }).catch(() => {});
      await settle();
    } finally {
      process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
    }
    const turns = calls.filter((c) => c[0] === "turn").map((c) => (c[1] as { end: unknown }).end);
    expect(turns).toEqual([{ outcome: "error", errorKind: "auth" }]);
  }, 60_000);
});
