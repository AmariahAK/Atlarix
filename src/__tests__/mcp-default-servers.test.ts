import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The user's default MCP servers: what every workspace offers in the composer's
 * menu. The Verified five until the user (marketplace) or the agent
 * (`mcp_servers` defaults) changes them; only registry servers can be defaults.
 */

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
    }),
  },
}));

let settings: Record<string, unknown> = {};
vi.mock("@/main/settings", () => ({
  readSettings: () => settings,
  writeSettings: (s: Record<string, unknown>) => {
    settings = { ...settings, ...s };
  },
}));

const broadcast = vi.fn();
vi.mock("@/ipc/utils/broadcast_all_windows", () => ({
  broadcastToAllWindows: (...a: unknown[]) => broadcast(...a),
}));

type Option = {
  id: string;
  kind: "web" | "package";
  supported?: boolean;
  inputs: Array<{ required: boolean }>;
};
const catalog: Record<
  string,
  { name: string; title: string; options: Option[] }
> = {
  "app.linear/linear": {
    name: "app.linear/linear",
    title: "Linear",
    options: [{ id: "remote:0", kind: "web", inputs: [] }],
  },
  "io.github.x/files": {
    name: "io.github.x/files",
    title: "Files",
    options: [
      {
        id: "npm:0",
        kind: "package",
        supported: true,
        inputs: [{ required: true }],
      },
    ],
  },
  "com.notion/mcp": {
    name: "com.notion/mcp",
    title: "Notion",
    options: [{ id: "remote:0", kind: "web", inputs: [] }],
  },
};
vi.mock("@/lib/mcp/registry-catalog", () => ({
  getMcpCatalogEntry: async (name: string) => catalog[name] ?? null,
}));

const found = vi.fn();
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/mcp/mcp-suggestions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/mcp-suggestions")>()),
  findMcpServer: (...a: unknown[]) => found(...a),
}));

const D = await import("@/lib/mcp/default-servers");
const { VERIFIED_MCP_SERVERS } = await import("@/shared/mcp-catalog");
const { ToolRegistry } = await import("@/lib/tools/registry");
await import("@/lib/tools/mcp-servers");

const tool = (args: Record<string, unknown>) =>
  ToolRegistry.get("mcp_servers")!.handler({
    workspaceId: 3,
    ...args,
  }) as Promise<Record<string, unknown>>;

beforeEach(() => {
  settings = {};
  broadcast.mockReset();
  found.mockReset();
  found.mockResolvedValue(null);
});

describe("the defaults list", () => {
  it("is the Verified five until the user changes it", () => {
    expect(D.defaultMcpServerNames()).toEqual(
      VERIFIED_MCP_SERVERS.map((v) => v.name),
    );
  });

  it("is replaced in the given order, once each, and every window is told", async () => {
    const out = await D.setDefaultMcpServers([
      "app.linear/linear",
      " com.notion/mcp ",
      "app.linear/linear",
    ]);
    expect(out).toEqual({
      ok: true,
      servers: ["app.linear/linear", "com.notion/mcp"],
    });
    expect(D.defaultMcpServerNames()).toEqual([
      "app.linear/linear",
      "com.notion/mcp",
    ]);
    expect(broadcast).toHaveBeenCalledWith("mcp:servers-changed", {
      appId: null,
    });
  });

  it("refuses a name the registry doesn't have, and changes nothing", async () => {
    const out = await D.setDefaultMcpServers([
      "app.linear/linear",
      "made.up/server",
    ]);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toContain("made.up/server");
    expect(settings.defaultMcpServers).toBeUndefined();
  });

  it("can be emptied", async () => {
    expect(await D.setDefaultMcpServers([])).toEqual({ ok: true, servers: [] });
    expect(D.defaultMcpServerNames()).toEqual([]);
  });

  it("adds one at the end and takes one out", async () => {
    await D.setDefaultMcpServers(["com.notion/mcp"]);
    await D.toggleDefaultMcpServer("app.linear/linear", true);
    expect(D.defaultMcpServerNames()).toEqual([
      "com.notion/mcp",
      "app.linear/linear",
    ]);
    await D.toggleDefaultMcpServer("com.notion/mcp", false);
    expect(D.defaultMcpServerNames()).toEqual(["app.linear/linear"]);
  });
});

describe("where each default stands in a workspace", () => {
  it("says how a server that isn't added yet would be added", async () => {
    await D.setDefaultMcpServers(["app.linear/linear", "io.github.x/files"]);
    expect(await D.defaultMcpServersStatus(3)).toEqual([
      {
        name: "app.linear/linear",
        title: "Linear",
        state: "not-added",
        optionId: "remote:0",
        needsInputs: false,
      },
      // A local server that asks for values goes to the marketplace to ask them.
      {
        name: "io.github.x/files",
        title: "Files",
        state: "not-added",
        optionId: "npm:0",
        needsInputs: true,
      },
    ]);
  });

  it("shows an added one as on, off or what it still needs", async () => {
    await D.setDefaultMcpServers(["app.linear/linear", "com.notion/mcp"]);
    found.mockImplementation(async (_appId: number, name: string) =>
      name === "app.linear/linear"
        ? {
            where: "account",
            id: "c1",
            name: "Linear",
            enabled: true,
            needs: null,
          }
        : {
            where: "local",
            id: 9,
            name: "Notion",
            enabled: false,
            needs: "sign-in",
          },
    );
    const status = await D.defaultMcpServersStatus(3);
    expect(status.map((s) => [s.name, s.state, s.where])).toEqual([
      ["app.linear/linear", "on", "account"],
      ["com.notion/mcp", "needs-sign-in", "local"],
    ]);
    expect(found).toHaveBeenCalledWith(3, "app.linear/linear");
  });
});

describe("mcp_servers defaults (the agent)", () => {
  it("lists the defaults", async () => {
    await D.setDefaultMcpServers(["app.linear/linear"]);
    expect(await tool({ operation: "defaults" })).toEqual({
      defaults: [
        { server: "app.linear/linear", title: "Linear", state: "not-added" },
      ],
    });
  });

  it("replaces them and returns the new list", async () => {
    const out = await tool({
      operation: "defaults",
      servers: ["com.notion/mcp", "app.linear/linear"],
    });
    expect(out).toEqual({
      defaults: [
        { server: "com.notion/mcp", title: "Notion", state: "not-added" },
        { server: "app.linear/linear", title: "Linear", state: "not-added" },
      ],
    });
    expect(D.defaultMcpServerNames()).toEqual([
      "com.notion/mcp",
      "app.linear/linear",
    ]);
  });

  it("returns the registry's refusal as an error the model can act on", async () => {
    const out = await tool({ operation: "defaults", servers: ["Linear"] });
    expect(out.error).toContain("Linear");
    expect(D.defaultMcpServerNames()).toEqual(
      VERIFIED_MCP_SERVERS.map((v) => v.name),
    );
  });
});
