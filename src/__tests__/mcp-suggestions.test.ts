import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The agent suggests an MCP server; the user connects it from a card.
 *
 * The model chooses: `wait` makes the tool return the user's answer; without
 * it the tool returns at once and the connection is delivered later like a
 * finished background command (queued for the chat, which is woken). A Stop
 * answers a waiting suggestion, and nothing is ever suggested in an unattended
 * run, where nobody could answer.
 */

vi.mock("electron-log", () => ({
  default: { scope: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn() }) },
}));

const found = vi.fn();
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/mcp/mcp-suggestions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/mcp-suggestions")>()),
  findMcpServer: (...a: unknown[]) => found(...a),
}));

const S = await import("@/lib/mcp/mcp-suggestions");
const { ToolRegistry } = await import("@/lib/tools/registry");
await import("@/lib/tools/mcp-servers");

const base = { chatId: 7, appId: 3, server: "app.linear/linear", title: "Linear", reason: "to read the issue", wait: false };

beforeEach(() => {
  S.clearMcpSuggestionsForTests();
  S.takePendingMcpConnectResults(7);
  found.mockReset();
});

describe("a suggestion the model waits on", () => {
  it("returns the user's connection", async () => {
    const s = S.addMcpSuggestion({ ...base, wait: true });
    const waiting = S.waitForMcpSuggestion(s.id);
    S.resolveMcpSuggestion(s.id, { connected: true, server: "Linear", where: "account", tools: ["list_issues"] });
    expect(await waiting).toEqual({ connected: true, server: "Linear", where: "account", tools: ["list_issues"] });
    // Delivered as the tool result, so nothing is queued to wake the chat as well.
    expect(S.hasPendingMcpConnectResults(7)).toBe(false);
  });

  it("is answered 'no' by a Stop", async () => {
    const s = S.addMcpSuggestion({ ...base, wait: true });
    const controller = new AbortController();
    const waiting = S.waitForMcpSuggestion(s.id, controller.signal);
    controller.abort();
    expect(await waiting).toMatchObject({ connected: false });
    expect(S.listMcpSuggestions(7)).toHaveLength(0);
  });
});

describe("a suggestion the model doesn't wait on", () => {
  it("queues the connection for the chat and wakes it", () => {
    const woke = vi.fn();
    S.setMcpConnectNotifier(woke);
    const s = S.addMcpSuggestion(base);
    S.resolveMcpSuggestion(s.id, { connected: true, server: "Linear", where: "account", tools: ["list_issues", "create_issue"] });
    expect(woke).toHaveBeenCalledWith(7, { server: "Linear", status: "finished" });
    expect(S.describePendingMcpConnectResults(7)).toEqual(["Linear connected"]);
    const body = S.takePendingMcpConnectResults(7)!;
    expect(body).toContain('MCP SERVER "Linear" connected');
    expect(body).toContain("list_issues, create_issue");
    // Take-once.
    expect(S.takePendingMcpConnectResults(7)).toBeNull();
  });

  it("'not now' queues nothing", () => {
    const woke = vi.fn();
    S.setMcpConnectNotifier(woke);
    const s = S.addMcpSuggestion(base);
    S.resolveMcpSuggestion(s.id, { connected: false, reason: "the user said not now" });
    expect(woke).not.toHaveBeenCalled();
    expect(S.hasPendingMcpConnectResults(7)).toBe(false);
  });
});

describe("cards", () => {
  it("one per server per chat: asking again replaces the earlier card", async () => {
    const first = S.addMcpSuggestion({ ...base, wait: true });
    const waiting = S.waitForMcpSuggestion(first.id);
    const second = S.addMcpSuggestion(base);
    expect(await waiting).toMatchObject({ connected: false, reason: "replaced by a newer suggestion" });
    expect(S.listMcpSuggestions(7).map((s) => s.id)).toEqual([second.id]);
  });

  it("every surface hears a card come and go", () => {
    const heard = vi.fn();
    S.setMcpSuggestionListener(heard);
    const s = S.addMcpSuggestion(base);
    S.resolveMcpSuggestion(s.id, { connected: false, reason: "no" });
    expect(heard.mock.calls.map((c) => c[0].type)).toEqual(["added", "resolved"]);
  });
});

describe("the mcp_servers tool", () => {
  const tool = () => ToolRegistry.get("mcp_servers")!;

  it("never suggests in an unattended run", async () => {
    const r = (await tool().handler({
      operation: "suggest",
      server: "app.linear/linear",
      _chatSessionId: 7,
      _mcpSuggestContext: { unattended: true },
    })) as { error?: string };
    expect(r.error).toMatch(/unattended/);
    expect(S.listMcpSuggestions(7)).toHaveLength(0);
  });

  it("says so when the server is already connected", async () => {
    found.mockResolvedValue({ where: "account", id: "a", name: "Linear", enabled: true, needs: null, authType: "oauth", registryName: "app.linear/linear" });
    const r = await tool().handler({ operation: "suggest", server: "app.linear/linear", workspaceId: 3, _chatSessionId: 7 });
    expect(r).toMatchObject({ connected: true, server: "Linear" });
    expect(S.listMcpSuggestions(7)).toHaveLength(0);
  });

  it("puts up a card for a server that is added but signed out", async () => {
    found.mockResolvedValue({ where: "account", id: "a", name: "Linear", enabled: false, needs: "sign-in", authType: "oauth", registryName: "app.linear/linear" });
    const r = await tool().handler({ operation: "suggest", server: "Linear", reason: "to read the issue", workspaceId: 3, _chatSessionId: 7 });
    expect(r).toMatchObject({ shown: true });
    expect(S.listMcpSuggestions(7)).toMatchObject([{ server: "app.linear/linear", title: "Linear", reason: "to read the issue" }]);
  });

  it("won't turn on a server that still needs the user", async () => {
    found.mockResolvedValue({ where: "local", id: 4, name: "gh", enabled: false, needs: "key", authType: "api_key", registryName: null });
    const r = (await tool().handler({ operation: "start", server: "gh", workspaceId: 3 })) as { error?: string };
    expect(r.error).toMatch(/needs its key first/);
  });
});
