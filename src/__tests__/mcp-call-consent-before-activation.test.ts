/**
 * `mcp_call` on a server that is configured but switched off: the consent card
 * comes BEFORE the server is switched on or its process started. Until
 * 2026-10-30 the row was enabled and `getClient` spawned the command first, so
 * an imported, off stdio config ran with no card in front of it (found by the
 * plugins session's security review). A run with nobody to ask refuses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateSet = vi.fn();
const update = vi.fn(() => ({ set: (v: unknown) => { updateSet(v); return { where: async () => undefined }; } }));
let row: { id: number; name: string; enabled: boolean } | undefined;
vi.mock("@/db", () => ({ db: {} }));
vi.mock("electron-log", () => ({ default: { scope: () => ({ log: () => {}, warn: () => {}, error: () => {} }) } }));
vi.mock("@/lib/mcp/account-connectors", () => ({
  callAccountConnector: vi.fn(),
  listAccountConnectors: async () => [],
  listConnectorRows: async () => [],
}));
vi.mock("@/lib/mcp/mcp-add", () => ({ mcpOnCount: async () => 0 }));
const getClient = vi.fn(async () => ({ tools: async () => ({ ping: { execute: async () => "pong" } }) }));
vi.mock("@/ipc/utils/mcp_manager", () => ({
  mcpManager: { listSessionServers: () => [], getClient: (...a: unknown[]) => getClient(...a) },
  McpNeedsAuthError: class extends Error {},
  McpNeedsOAuthError: class extends Error {},
}));

const dbMod = await import("@/db");
Object.assign(dbMod.db as object, {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }) }),
  update,
});
const { ToolRegistry } = await import("@/lib/tools/registry");
await import("@/lib/tools/mcp");
const tool = () => ToolRegistry.get("mcp_call")!;

beforeEach(() => {
  updateSet.mockClear();
  getClient.mockClear();
  row = { id: 3, name: "imported", enabled: false };
});

describe("mcp_call on a switched-off server", () => {
  it("asks first, and a 'no' leaves the server off and never started", async () => {
    const requireConsent = vi.fn(async () => false);
    const out = await tool().handler({
      server: "imported",
      tool: "ping",
      workspaceId: 1,
      _mcpInvocationContext: { requireConsent },
    } as never);
    expect(requireConsent).toHaveBeenCalledTimes(1);
    expect(requireConsent.mock.calls[0]![0]).toMatchObject({ serverName: "imported", toolName: "ping" });
    expect(out).toMatchObject({ error: expect.stringMatching(/declined/i) });
    expect(updateSet).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });

  it("a 'yes' switches it on, runs the tool, and does not ask twice", async () => {
    const requireConsent = vi.fn(async () => true);
    const out = await tool().handler({
      server: "imported",
      tool: "ping",
      workspaceId: 1,
      _mcpInvocationContext: { requireConsent },
    } as never);
    expect(requireConsent).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith({ enabled: true });
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ server: "imported", tool: "ping" });
  });

  it("with nobody to ask, refuses instead of switching it on", async () => {
    const out = await tool().handler({ server: "imported", tool: "ping", workspaceId: 1 } as never);
    expect(out).toMatchObject({ error: expect.stringMatching(/nobody to ask|enable it/i) });
    expect(updateSet).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });

  it("an already-enabled server still gets the per-tool card, once", async () => {
    row = { id: 4, name: "on", enabled: true };
    const requireConsent = vi.fn(async () => true);
    const out = await tool().handler({
      server: "on",
      tool: "ping",
      workspaceId: 1,
      _mcpInvocationContext: { requireConsent },
    } as never);
    expect(requireConsent).toHaveBeenCalledTimes(1);
    expect(updateSet).not.toHaveBeenCalled();
    expect(out).toMatchObject({ server: "on", tool: "ping" });
  });
});
