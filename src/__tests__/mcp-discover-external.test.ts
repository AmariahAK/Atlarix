/**
 * MCP servers set up in other tools are found (each tool's own format), shown
 * without any environment or header value, and only added on request.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverExternalMcpServers, findExternalMcpServers, maskSecrets, parseJsonc } from "@/lib/mcp/discover-external";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-home-"));
const folder = path.join(home, "code", "shop");
const write = (rel: string, body: string) => {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
fs.mkdirSync(folder, { recursive: true });
write(
  ".claude.json",
  JSON.stringify({
    mcpServers: { gsc: { command: "uvx", args: ["gsc-mcp"], env: { GSC_TOKEN: "secret-gsc-token-value-123" } } },
    projects: { [folder]: { mcpServers: { shopdb: { command: "npx", args: ["-y", "pg-mcp", "--api-key", "sk-live-abcdef"] } } } },
  }),
);
write(".cursor/mcp.json", JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/sse", headers: { Authorization: "Bearer lin_secret_token" } } } }));
// Where each OS keeps VS Code's and Zed's settings, under the test's home.
const appData = process.platform === "win32" ? "AppData/Roaming" : process.platform === "darwin" ? "Library/Application Support" : ".config";
const vscodeDir = `${appData}/Code/User`;
const zedDir = process.platform === "win32" ? `${appData}/zed` : ".config/zed";
write(`${vscodeDir}/mcp.json`, `{
  // VS Code's own file: comments and trailing commas
  "servers": {
    "github": { "type": "stdio", "command": "docker", "args": ["run", "ghcr.io/github/github-mcp-server"], },
    "prompted": { "command": "x", "env": { "TOKEN": "\${input:token}" } },
  },
}`);
write(`${zedDir}/settings.json`, `{ "context_servers": { "postgres": { "command": { "path": "pg-mcp", "args": ["--db", "shop"], "env": { "PGPASS": "zed-secret" } } } } }`);
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe("MCP servers found on this computer", () => {
  it("finds each tool's servers, this folder's included, and skips VS Code's prompted ones", () => {
    const found = discoverExternalMcpServers(folder, home);
    const byName = Object.fromEntries(found.map((f) => [f.name, f]));
    expect(Object.keys(byName).sort()).toEqual(["github", "gsc", "linear", "postgres", "shopdb"]);
    expect(byName.shopdb).toMatchObject({ source: "Claude Code", scope: "folder", transport: "stdio" });
    expect(byName.linear).toMatchObject({ source: "Cursor", transport: "http", summary: "https://mcp.linear.app/sse" });
    expect(byName.postgres).toMatchObject({ source: "Zed", summary: "pg-mcp --db shop", envNames: ["PGPASS"] });
    expect(byName.gsc!.envNames).toEqual(["GSC_TOKEN"]);
  });

  it("never shows a secret: env and header values stay in the file, keys in a command line are masked", () => {
    const shown = JSON.stringify(discoverExternalMcpServers(folder, home));
    for (const secret of ["secret-gsc-token-value-123", "lin_secret_token", "zed-secret", "sk-live-abcdef"]) expect(shown).not.toContain(secret);
    expect(shown).toContain("--api-key …");
  });

  it("adding reads the values again: env, and a bearer token from its header", () => {
    const full = findExternalMcpServers(folder, home);
    expect(full.find((f) => f.name === "gsc")?.env).toEqual({ GSC_TOKEN: "secret-gsc-token-value-123" });
    expect(full.find((f) => f.name === "linear")?.bearer).toBe("lin_secret_token");
  });

  it("parses JSON with comments and trailing commas, leaving strings alone", () => {
    expect(parseJsonc('{ "a": "http://x//y", /* c */ "b": [1,2,], }')).toEqual({ a: "http://x//y", b: [1, 2] });
  });

  it("masks query values and long tokens", () => {
    expect(maskSecrets("https://x.dev/mcp?key=abc123&team=t")).toBe("https://x.dev/mcp?key=…&team=…");
    expect(maskSecrets("run --token=abcd server ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4")).toBe("run --token=… server …");
  });
});
