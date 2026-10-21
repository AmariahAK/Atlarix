/**
 * The CLI's /mcp says whether a server connects, not only whether its switch is on.
 *
 * 15.7.0 QA: a server that was on but failed to connect read "✓ on" in the CLI
 * while the editor's page said "Couldn't connect: Connection closed".
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/main/settings", () => ({ readSettings: () => ({}) }));
vi.mock("@/lib/mcp/firejail", () => ({
  wrapStdioSpawnForFirejail: async (command: string, args: string[]) => ({ command, args }),
}));

import { mcpManager } from "@/ipc/utils/mcp_manager";
import { mcpServerDetail, mcpServerRight } from "@/cli/tui/mcp-row";

describe("McpManager remembers how a server connected", () => {
  it("a server whose connect fails is recorded as failed, once", async () => {
    mcpManager.setSessionServers("s-ai2a", [
      { name: "broken", transport: "stdio", command: "/nonexistent/atlarix-mcp-ai2a", args: [], env: {} },
    ]);
    const [{ id }] = mcpManager.listSessionServers("s-ai2a");
    expect(mcpManager.connectionStatus(id)).toBeUndefined();

    await mcpManager.probe(id);
    const st = mcpManager.connectionStatus(id);
    expect(st?.ok).toBe(false);
    expect(st && !st.ok && st.error.length).toBeGreaterThan(0);

    // Known now: a second look doesn't connect again.
    const spy = vi.spyOn(mcpManager, "getClient");
    await mcpManager.probe(id);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    // A config change (dispose) forgets it, so the next look tries again.
    mcpManager.dispose(id);
    expect(mcpManager.connectionStatus(id)).toBeUndefined();
    mcpManager.clearSessionServers("s-ai2a");
  });
});

describe("/mcp row", () => {
  const base = { id: 1, name: "Brave", transport: "stdio", enabled: true };

  it("an enabled server that couldn't connect says so, with the reason", () => {
    const s = { ...base, connection: { ok: false as const, error: "Connection closed" } };
    expect(mcpServerRight(s)).toEqual({ text: "✗ couldn't connect", tone: "error" });
    expect(mcpServerDetail(s)).toBe("this computer · stdio · Connection closed");
  });

  it("connected, not yet tried, off, and sign-in", () => {
    expect(mcpServerRight({ ...base, connection: { ok: true } }).text).toBe("✓ connected");
    expect(mcpServerRight(base).text).toBe("connecting…");
    expect(mcpServerRight({ ...base, enabled: false, connection: { ok: false, error: "x" } }).text).toBe("○ off");
    expect(mcpServerRight({ ...base, needsSignIn: true }).text).toBe("sign in");
  });
});

describe("a stdio server's stderr (QA B1)", () => {
  it("is kept, not printed over the terminal, and says why it couldn't connect", async () => {
    const home = (await import("node:os")).homedir();
    const key = `sk-ant-api03-${"x".repeat(40)}`;
    const script = [
      `console.error("node:internal/modules/cjs/loader:1458");`,
      `console.error("Error: Cannot find module '${home}/no-such-server.mjs' ${key}");`,
      `console.error("    at Module._resolveFilename (node:internal/modules/cjs/loader:1455:15)");`,
      `process.exit(1);`,
    ].join("");
    mcpManager.setSessionServers("s-ai2a-b1", [
      { name: "broken", transport: "stdio", command: process.execPath, args: ["-e", script], env: {} },
    ]);
    const [{ id }] = mcpManager.listSessionServers("s-ai2a-b1");
    await mcpManager.probe(id);
    const st = mcpManager.connectionStatus(id);
    expect(st?.ok).toBe(false);
    const error = st && !st.ok ? st.error : "";
    // Read from the pipe: with the SDK's default ("inherit") it went to the terminal and nothing kept it.
    expect(error).toContain("Error: Cannot find module '~/no-such-server.mjs'");
    expect(error).not.toContain(home);
    expect(error).not.toContain(key);
    mcpManager.clearSessionServers("s-ai2a-b1");
  });

  it("picks the line that says why", async () => {
    const { stderrLine } = await import("@/ipc/utils/mcp_manager");
    expect(stderrLine("loading\nError: boom\n    at x (y.js:1:2)\n\nNode.js v25.7.0\n")).toBe("Error: boom");
    expect(stderrLine("listening on stdio\nbye\n")).toBe("bye");
    expect(stderrLine("")).toBe("");
  });
});
