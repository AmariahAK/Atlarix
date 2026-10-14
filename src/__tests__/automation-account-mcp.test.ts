import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An automation can watch a web MCP server on the account, not only one on
 * this computer: the trigger names it (`accountServer`), and the poll calls it
 * by name through the proxy like every surface does. A server that is gone,
 * off, or signed out fails the poll with what to fix — never a silent skip.
 */

vi.mock("electron-log", () => ({
  default: { scope: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn() }) },
}));
vi.mock("@/db", () => ({ db: {} }));

let rows: Array<{ name: string; enabled: boolean; connected: boolean }> | null = [];
vi.mock("@/lib/mcp/account-connectors", () => ({ listConnectorRows: async () => rows }));

const { pollMcp } = await import("@/lib/automations/pollers/mcp");
const { assertMcpTriggerServer, mcpTriggerRef, mcpTriggerServerFromRef } = await import("@/lib/automations/types");

const trigger = { kind: "mcp" as const, accountServer: "Sentry", tool: "list_issues", intervalMinutes: 15 };

beforeEach(() => {
  rows = [{ name: "Sentry", enabled: true, connected: true }];
});

describe("watching an account server", () => {
  it("calls it by name, seeds, then fires on a change", async () => {
    const mcpCall = vi.fn(async () => ({ result: "3 issues" }));
    const seeded = await pollMcp(trigger, null, 5, { mcpCall });
    expect(seeded.fired).toBe(false);
    expect(mcpCall).toHaveBeenCalledWith(expect.objectContaining({ server: "Sentry", tool: "list_issues", workspaceId: 5 }));
    mcpCall.mockResolvedValueOnce({ result: "4 issues" });
    const fired = await pollMcp(trigger, seeded.nextCursor, 5, { mcpCall });
    expect(fired.fired).toBe(true);
    expect(fired.context).toContain("Sentry/list_issues");
  });

  it("says what to fix when the server is gone, off, or signed out", async () => {
    const mcpCall = vi.fn();
    rows = [];
    await expect(pollMcp(trigger, null, 5, { mcpCall })).rejects.toThrow(/no longer on your account/);
    rows = [{ name: "Sentry", enabled: false, connected: true }];
    await expect(pollMcp(trigger, null, 5, { mcpCall })).rejects.toThrow(/is off/);
    rows = [{ name: "Sentry", enabled: true, connected: false }];
    await expect(pollMcp(trigger, null, 5, { mcpCall })).rejects.toThrow(/sign in again/);
    rows = null;
    await expect(pollMcp(trigger, null, 5, { mcpCall })).rejects.toThrow(/Sign in to Atlarix/);
    expect(mcpCall).not.toHaveBeenCalled();
  });
});

describe("which server a trigger names", () => {
  it("is exactly one of this computer's or the account's", () => {
    expect(() => assertMcpTriggerServer({ ...trigger })).not.toThrow();
    expect(() => assertMcpTriggerServer({ kind: "mcp", serverId: 4, tool: "t", intervalMinutes: 5 })).not.toThrow();
    expect(() => assertMcpTriggerServer({ kind: "mcp", tool: "t", intervalMinutes: 5 })).toThrow(/needs one server/);
    expect(() => assertMcpTriggerServer({ kind: "mcp", serverId: 4, accountServer: "x", tool: "t", intervalMinutes: 5 })).toThrow();
  });

  it("round-trips through a picker's ref", () => {
    expect(mcpTriggerRef({ serverId: 12 })).toBe("local:12");
    expect(mcpTriggerRef({ accountServer: "Sentry" })).toBe("account:Sentry");
    expect(mcpTriggerServerFromRef("local:12")).toEqual({ serverId: 12 });
    expect(mcpTriggerServerFromRef("account:Sentry")).toEqual({ accountServer: "Sentry" });
  });
});
