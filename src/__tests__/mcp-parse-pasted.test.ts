import { describe, expect, it } from "vitest";
import { nameForCommand, nameForUrl, parsePasted, splitCommandLine } from "@/lib/mcp/parse-pasted";

/**
 * "Add your own" is one box. Whatever a user switching from another tool has
 * on their clipboard should work: a URL, a command, or the config block from
 * Claude Desktop, Cursor, VS Code or Zed — including a fragment copied out of
 * a README and a block whose newlines the terminal turned into spaces.
 */
describe("what a paste is", () => {
  it("a URL", () => {
    expect(parsePasted("  https://mcp.linear.app/mcp ")).toEqual({ kind: "url", url: "https://mcp.linear.app/mcp" });
  });

  it("a command line, quotes kept together", () => {
    expect(parsePasted(`npx -y @acme/mcp --root "/my files"`)).toEqual({
      kind: "command",
      command: "npx",
      args: ["-y", "@acme/mcp", "--root", "/my files"],
    });
  });

  it("nothing", () => {
    expect(parsePasted("   ")).toEqual({ kind: "empty" });
  });
});

describe("configs from other tools", () => {
  it("Claude Desktop / Cursor: mcpServers, stdio and http, all headers kept", () => {
    const r = parsePasted(
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "t" } },
          linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer abc", "X-Org": "acme" } },
        },
      }),
    );
    expect(r.kind).toBe("servers");
    if (r.kind !== "servers") return;
    expect(r.servers).toEqual([
      { name: "github", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "t" } },
      { name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", headers: { "X-Org": "acme" }, bearer: "abc" },
    ]);
  });

  it("VS Code (servers, with // comments and trailing commas) and its prompted values skipped", () => {
    const r = parsePasted(`{
      // my servers
      "servers": {
        "fs": { "type": "stdio", "command": "node", "args": ["fs.js"], },
        "asks": { "command": "npx", "env": { "KEY": "\${input:key}" } },
      },
    }`);
    expect(r.kind).toBe("servers");
    if (r.kind !== "servers") return;
    expect(r.servers.map((s) => s.name)).toEqual(["fs"]);
    expect(r.skipped).toEqual([{ name: "asks", reason: "it asks VS Code for a value when it starts" }]);
  });

  it("Zed's context_servers and VS Code settings' mcp.servers", () => {
    const zed = parsePasted(JSON.stringify({ context_servers: { pg: { command: { path: "pg-mcp", args: ["--ro"], env: {} } } } }));
    expect(zed).toMatchObject({ kind: "servers", servers: [{ name: "pg", command: "pg-mcp", args: ["--ro"] }] });
    const settings = parsePasted(JSON.stringify({ "editor.fontSize": 12, mcp: { servers: { a: { url: "https://a.dev/mcp" } } } }));
    expect(settings).toMatchObject({ kind: "servers", servers: [{ name: "a", url: "https://a.dev/mcp" }] });
  });

  it("a bare map, a single server, and a fragment copied out of a README", () => {
    expect(parsePasted(JSON.stringify({ one: { command: "x" }, two: { url: "https://two.dev/mcp" } }))).toMatchObject({
      kind: "servers",
      servers: [{ name: "one" }, { name: "two" }],
    });
    expect(parsePasted(JSON.stringify({ url: "https://mcp.sentry.dev/mcp" }))).toMatchObject({
      kind: "servers",
      servers: [{ name: "sentry", transport: "http" }],
    });
    expect(parsePasted(`"github": { "command": "npx", "args": ["-y", "gh-mcp"] },`)).toMatchObject({
      kind: "servers",
      servers: [{ name: "github", command: "npx" }],
    });
  });

  it("a config whose newlines a terminal turned into spaces", () => {
    const flattened = JSON.stringify({ mcpServers: { a: { command: "x" } } }, null, 2).replace(/\n/g, " ");
    expect(parsePasted(flattened)).toMatchObject({ kind: "servers", servers: [{ name: "a" }] });
  });

  it("says what is wrong with JSON that holds no servers", () => {
    expect(parsePasted('{"theme": "dark"}')).toEqual({ kind: "invalid", error: "No MCP servers found in that JSON." });
    expect(parsePasted("{ not json")).toMatchObject({ kind: "invalid" });
  });
});

describe("names", () => {
  it("come from the package or the host", () => {
    expect(nameForCommand("npx", ["-y", "@acme/mcp-thing@1.2.0"])).toBe("mcp-thing");
    expect(nameForUrl("https://mcp.linear.app/mcp")).toBe("linear");
    expect(splitCommandLine(`a 'b c' "d"`)).toEqual(["a", "b c", "d"]);
  });
});
