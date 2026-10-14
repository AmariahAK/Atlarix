import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/mcp/account-connectors", () => ({
  listConnectorRows: async () => [
    { id: "a9", name: "Linear", url: "https://mcp.linear.app/mcp/", enabled: true, connected: true, authType: "oauth", registryName: null },
  ],
}));

describe("a Verified server added by its address is that server (QA F2)", () => {
  it("findMcpServer matches it by URL when it has no registry name", async () => {
    const { findMcpServer } = await import("@/lib/mcp/mcp-suggestions");
    const hit = await findMcpServer(null, "app.linear/linear");
    expect(hit?.name).toBe("Linear");
    expect(hit?.enabled).toBe(true);
  });

  it("a server that isn't Verified is not matched by someone else's address", async () => {
    const { findMcpServer } = await import("@/lib/mcp/mcp-suggestions");
    expect(await findMcpServer(null, "io.github.someone/linear-clone")).toBeNull();
  });
});
