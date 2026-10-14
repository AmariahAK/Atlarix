import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where an added MCP server lives, and the limit on how many are on.
 *
 *   - a public https server → the ACCOUNT, so the app, the CLI, editors and
 *     the Chrome extension all have it;
 *   - a command, or a local / private address → this computer, for the folder;
 *   - signed out, a public server stays on this computer rather than failing;
 *   - 10 on at once (folder + account): one more is added switched OFF, with
 *     a line saying so, never refused or thrown away.
 */

vi.mock("electron-log", () => ({
  default: { scope: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn() }) },
}));

let localRows: Array<{ id: number; name: string; enabled: boolean }> = [];
const inserted: Array<Record<string, unknown>> = [];
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => localRows,
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { returning: async () => [{ id: 100 + inserted.length, ...v }] };
      },
    }),
  },
}));

let accountRows: Array<{ id: string; enabled: boolean }> | null = [];
const created: Array<Record<string, unknown>> = [];
const secrets: Array<[string, string]> = [];
const enabledIds: string[] = [];
vi.mock("@/lib/mcp/account-connectors", () => ({
  listConnectorRows: async () => accountRows,
  enabledConnectorCount: async () => (accountRows ?? []).filter((r) => r.enabled).length,
  createConnector: async (input: Record<string, unknown>) => {
    created.push(input);
    return { ok: true, value: { id: `acct-${created.length}` } };
  },
  setConnectorSecret: async (id: string, s: string) => {
    secrets.push([id, s]);
    return { ok: true, value: true };
  },
  setConnectorEnabled: async (id: string) => {
    enabledIds.push(id);
    return { ok: true, value: true };
  },
  beginConnectorSignIn: vi.fn(),
  waitForConnectorCredential: vi.fn(),
}));

vi.mock("@/lib/mcp/registry-catalog", async () => {
  const { VERIFIED_MCP_SERVERS } = await import("@/shared/mcp-catalog");
  return {
    getMcpRegistryServer: async (name: string) => VERIFIED_MCP_SERVERS.find((v) => v.name === name)?.fallback ?? null,
  };
});

const { addPasted, addServerFromUrl, installFromCatalog, mcpOnCount } = await import("@/lib/mcp/mcp-add");

/** The URL probe: 401 plus OAuth metadata, 401 without, or 200. */
function serverSays(kind: "oauth" | "key" | "open") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Response("", { status: kind === "open" ? 200 : 401 });
      if (kind === "oauth" && url.includes("oauth-protected-resource")) {
        return new Response(JSON.stringify({ authorization_servers: ["https://auth.example.com"] }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }),
  );
}

beforeEach(() => {
  localRows = [];
  inserted.length = 0;
  accountRows = [];
  created.length = 0;
  secrets.length = 0;
  enabledIds.length = 0;
  vi.unstubAllGlobals();
});

describe("a public https server goes on the account", () => {
  it("with browser sign-in when the server asks for it, switched on after", async () => {
    serverSays("oauth");
    const a = await addServerFromUrl(7, { url: "https://mcp.example.com/mcp" }, { enable: true });
    expect(a).toMatchObject({ where: "account", needsSignIn: true, enabled: false });
    expect(created[0]).toMatchObject({ authType: "oauth", url: "https://mcp.example.com/mcp", name: "example", slug: "example" });
    expect(inserted).toHaveLength(0);
  });

  it("with its one named header as the secret, and on at once", async () => {
    const a = await addServerFromUrl(7, { url: "https://api.acme.dev/mcp", headers: { "X-Api-Key": "k1" } }, { enable: true });
    expect(created[0]).toMatchObject({ authType: "header", authHeader: "X-Api-Key" });
    expect(secrets).toEqual([["acct-1", "k1"]]);
    expect(a).toMatchObject({ where: "account", enabled: true, needsSignIn: false });
  });

  it("a Bearer header is a key like any other", async () => {
    await addServerFromUrl(7, { url: "https://api.acme.dev/mcp", headers: { Authorization: "Bearer tok" } }, { enable: true });
    expect(created[0]).toMatchObject({ authType: "api_key" });
    expect(secrets).toEqual([["acct-1", "tok"]]);
  });

  it("asks for a key the server wants but the paste didn't have", async () => {
    serverSays("key");
    const a = await addServerFromUrl(7, { url: "https://api.acme.dev/mcp" }, { enable: true });
    expect(a).toMatchObject({ where: "account", enabled: false, needsSecret: { header: null } });
  });

  it("the Verified ones install from the marketplace with one click", async () => {
    serverSays("oauth");
    const a = await installFromCatalog(7, { name: "app.linear/linear", optionId: "remote:0", values: {} });
    expect(a).toMatchObject({ where: "account", needsSignIn: true });
    expect(created[0]).toMatchObject({ url: "https://mcp.linear.app/mcp", registryName: "app.linear/linear", name: "Linear" });
  });
});

describe("everything else stays on this computer", () => {
  it("a local address, with its headers encrypted", async () => {
    serverSays("open");
    const a = await addServerFromUrl(7, { url: "http://localhost:3000/mcp", headers: { "X-Dev": "secret-value" } }, { enable: true });
    expect(a).toMatchObject({ where: "local", enabled: true });
    expect(created).toHaveLength(0);
    expect(inserted[0]).toMatchObject({ transport: "http", url: "http://localhost:3000/mcp", appId: 7 });
    // Stored as a Secret blob, the same as env values (plaintext only where
    // the OS keychain is unavailable, as in this test run).
    const stored = (inserted[0]!.headersJson as Record<string, string>)["X-Dev"]!;
    expect(stored).not.toBe("secret-value");
    expect(JSON.parse(stored)).toHaveProperty("encryptionType");
  });

  it("a public server when nobody is signed in, and it says why", async () => {
    accountRows = null;
    serverSays("open");
    const a = await addServerFromUrl(7, { url: "https://mcp.example.com/mcp" }, { enable: true });
    expect(a.where).toBe("local");
    expect(a.note).toMatch(/sign in to Atlarix to share it/);
  });

  it("a public server with more headers than the account holds", async () => {
    const a = await addServerFromUrl(7, { url: "https://x.dev/mcp", headers: { A: "1", B: "2" } }, { enable: true });
    expect(a.where).toBe("local");
  });

  it("a command, with its env encrypted and a unique name", async () => {
    localRows = [{ id: 1, name: "mcp-thing", enabled: false }];
    const out = await addPasted(7, "npx -y @acme/mcp-thing");
    expect(out.added[0]).toMatchObject({ where: "local", name: "mcp-thing-2" });
    expect(inserted[0]).toMatchObject({ transport: "stdio", command: "npx", args: ["-y", "@acme/mcp-thing"] });
  });
});

describe("the limit: 10 on, this folder's and the account's", () => {
  it("counts both", async () => {
    localRows = Array.from({ length: 4 }, (_, i) => ({ id: i, name: `l${i}`, enabled: true }));
    accountRows = Array.from({ length: 3 }, (_, i) => ({ id: `a${i}`, enabled: true }));
    expect(await mcpOnCount(7)).toBe(7);
  });

  it("adds one more switched off, and says so", async () => {
    localRows = Array.from({ length: 6 }, (_, i) => ({ id: i, name: `l${i}`, enabled: true }));
    accountRows = Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, enabled: true }));
    const local = await addPasted(7, "node server.js");
    expect(local.added[0]).toMatchObject({ enabled: false, note: expect.stringMatching(/switched off/) });
    const web = await addServerFromUrl(7, { url: "https://x.dev/mcp", headers: { K: "v" } }, { enable: true });
    expect(web).toMatchObject({ where: "account", enabled: false });
    expect(enabledIds).toHaveLength(0);
  });
});

describe("a pasted config", () => {
  it("adds each server where it belongs, and reports what it skipped", async () => {
    serverSays("oauth");
    const out = await addPasted(
      7,
      JSON.stringify({
        mcpServers: {
          linear: { url: "https://mcp.linear.app/mcp" },
          fs: { command: "node", args: ["fs.js"] },
          vs: { command: "npx", env: { K: "${input:k}" } },
        },
      }),
    );
    expect(out.added.map((a) => [a.name, a.where])).toEqual([
      ["linear", "account"],
      ["fs", "local"],
    ]);
    expect(out.skipped.map((s) => s.name)).toEqual(["vs"]);
  });

  it("explains a paste it can't read", async () => {
    await expect(addPasted(7, '{"theme":"dark"}')).rejects.toThrow("No MCP servers found");
  });
});
