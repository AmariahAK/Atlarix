/**
 * An editor's own MCP servers over ACP.
 *
 * `session/new` (and `session/load`) carry the `mcpServers` the user set up in
 * their editor. Atlarix used to ignore them; now they are connected for that
 * session, listed first by `list_available_mcps`, and run by `mcp_call` after
 * the same per-tool consent a folder's servers get — asked of the editor as
 * `session/request_permission`. `initialize` says Atlarix takes http ones too.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { startFakeLlm, type Reply } from "./fixtures/fake-llm";

let ws: string;
const ECHO = path.join(import.meta.dir, "fixtures", "echo-mcp.mjs");

beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acp-mcp-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  process.env.ATLARIX_PEER_SURFACE = "editor";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "acp-mcp-ws-"));
});

async function editor(script: Reply[]) {
  const llm = startFakeLlm(script);
  const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
  const { AcpAgent } = await import("../src/cli/acp/agent");
  const { buildAgentApp } = await import("../src/cli/acp/server");
  const { mcpManager } = await import("../src/ipc/utils/mcp_manager");
  const model = await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" });
  const agent = new AcpAgent({
    createSession: async (cwd) => {
      const s = new AgentSession({ workspaceDir: cwd, model, surface: "editor", idlePeerMessages: "hold" });
      await s.start();
      return s;
    },
    models: async () => ({ options: [{ ...model, label: "Fake" }], current: model }),
    rememberModel: () => {},
    listSessions: async () => [],
    // As server.ts wires it.
    setSessionMcpServers: (sessionId, servers) => {
      if (servers.length > 0) mcpManager.setSessionServers(sessionId, servers);
      else mcpManager.clearSessionServers(sessionId);
    },
  });
  const asked: RequestPermissionRequest[] = [];
  const client = acp.client({ name: "test-editor" }).onRequest("session/request_permission", (ctx) => {
    asked.push(ctx.params);
    return { outcome: { outcome: "selected", optionId: "accept-once" } };
  });
  const conn = client.connect(buildAgentApp(agent, "test"));
  const init = await conn.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  return { llm, agent, conn, init, asked, mcpManager };
}

/** The tool results the model was sent, as one string. */
const toolResults = (llm: ReturnType<typeof startFakeLlm>) =>
  JSON.stringify((llm.requests.at(-1)?.messages ?? []).filter((m) => m.role === "tool"));

describe("an editor's MCP servers", () => {
  it("initialize says http servers are welcome (and SSE is not spoken)", async () => {
    const e = await editor([]);
    expect(e.init.agentCapabilities?.mcpCapabilities).toEqual({ http: true, sse: false });
  });

  it("a stdio server from session/new is listed, asked about, and runs with the editor's env", async () => {
    const e = await editor([
      { tool: "list_available_mcps", args: {} },
      { tool: "mcp_call", args: { server: "echoer", tool: "echo", arguments: { text: "hello" } } },
      { text: "done" },
    ]);
    const { sessionId } = await e.conn.agent.request("session/new", {
      cwd: ws,
      mcpServers: [{ name: "echoer", command: "node", args: [ECHO], env: [{ name: "ECHO_PREFIX", value: "pfx:" }] }],
    });
    const r = await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "use it" }] });
    expect(r.stopReason).toBe("end_turn");

    const results = toolResults(e.llm);
    expect(results).toContain("echoer");
    expect(results).toContain("editor");
    expect(results).toContain("pfx:hello");
    // The same consent a folder's server gets, asked of the editor.
    expect(e.asked.some((a) => a.toolCall.title?.includes("echo") && a.toolCall.title?.includes("echoer"))).toBe(true);
    e.llm.stop();
  }, 60_000);

  it("declining the consent stops the call", async () => {
    const e = await editor([
      { tool: "mcp_call", args: { server: "echoer", tool: "echo", arguments: { text: "nope" } } },
      { text: "ok" },
    ]);
    const decline = acp.client({ name: "declining-editor" }).onRequest("session/request_permission", () => ({
      outcome: { outcome: "selected", optionId: "decline" },
    }));
    // Same agent, an editor that says No.
    const conn = decline.connect((await import("../src/cli/acp/server")).buildAgentApp(e.agent, "test"));
    await conn.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await conn.agent.request("session/new", {
      cwd: ws,
      mcpServers: [{ name: "echoer", command: "node", args: [ECHO], env: [] }],
    });
    await conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "try" }] });
    const results = toolResults(e.llm);
    expect(results).toContain("declined");
    expect(results).not.toContain("nope\"");
    e.llm.stop();
  }, 60_000);

  describe("over http", () => {
    let server: http.Server;
    let url = "";
    let sawHeader: string | undefined;

    beforeAll(async () => {
      const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
      const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
      const { z } = await import("zod");
      server = http.createServer(async (req, res) => {
        sawHeader = req.headers["x-team"] as string | undefined;
        const mcp = new McpServer({ name: "web-echo", version: "1.0.0" });
        mcp.registerTool("shout", { inputSchema: { text: z.string() } }, async ({ text }) => ({
          content: [{ type: "text", text: text.toUpperCase() }],
        }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcp.connect(transport);
        let body = "";
        for await (const chunk of req) body += chunk;
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const addr = server.address() as { port: number };
      url = `http://127.0.0.1:${addr.port}/mcp`;
    });
    afterAll(() => server?.close());

    it("an http server from session/load is used, with the editor's headers", async () => {
      const e = await editor([
        { text: "first" },
        { tool: "mcp_call", args: { server: "web", tool: "shout", arguments: { text: "quiet" } } },
        { text: "done" },
      ]);
      const { sessionId } = await e.conn.agent.request("session/new", { cwd: ws, mcpServers: [] });
      await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
      await e.conn.agent.request("session/load", {
        sessionId,
        cwd: ws,
        mcpServers: [{ type: "http", name: "web", url, headers: [{ name: "X-Team", value: "atlarix" }] }],
      });
      await e.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "shout" }] });
      expect(toolResults(e.llm)).toContain("QUIET");
      expect(sawHeader).toBe("atlarix");
      e.llm.stop();
    }, 60_000);
  });

  it("an sse server is left out rather than half-connected", async () => {
    const { sessionMcpServersFrom } = await import("../src/cli/acp/agent");
    expect(
      sessionMcpServersFrom([
        { type: "sse", name: "old", url: "https://x/sse", headers: [] },
        { name: "", command: "x", args: [], env: [] },
        { name: "ok", command: "node", args: ["a.js"], env: [{ name: "A", value: "1" }] },
      ]),
    ).toEqual([{ name: "ok", transport: "stdio", command: "node", args: ["a.js"], env: { A: "1" } }]);
  });
});
