// A one-tool MCP server over stdio, for tests: `echo` returns its text with
// the value of ECHO_PREFIX in front (so a test sees the editor's env arrived).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "Echo text back", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text: `${process.env.ECHO_PREFIX ?? ""}${text}` }] }),
);
await server.connect(new StdioServerTransport());
