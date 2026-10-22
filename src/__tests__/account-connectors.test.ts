/**
 * Connectors set up on atlarix.dev, reached from the desktop.
 *
 * The properties worth pinning are all about what happens when something is
 * absent or ambiguous, because those are the paths that fail QUIETLY:
 *
 *  - Signed out, no proxy configured, or the network down must produce "no
 *    connectors", not an error the user cannot act on. Atlarix runs on BYOK
 *    without an account at all.
 *  - `X-Atlarix-Surface` must be on every call. A ledger row cannot be
 *    re-attributed later, so a missing header is a permanent misattribution
 *    rather than a bug that can be fixed afterwards.
 *  - A server that failed to LIST is returned with its error rather than
 *    dropped. Dropping it tells the model the connector does not exist, so it
 *    plans around an absence instead of reporting something the user could fix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  },
}));

let token: string | null = "user-jwt";
let userId = "u-1";
/** `account_mcp_servers` as PostgREST serves it; every read is counted. */
let rows: Array<Record<string, unknown>> = [];
let rowsError: { message: string } | null = null;
let reads = 0;
let gate: Promise<void> | null = null;
vi.mock("@/lib/auth/supabase-client", () => ({
  getSession: async () => (token ? { access_token: token, user: { id: userId } } : null),
  getSupabaseClient: () => ({
    from: (table: string) => {
      if (table === "account_mcp_servers") reads++;
      return {
        select: () => ({
          order: async () => {
            if (gate) await gate;
            return rowsError ? { data: null, error: rowsError } : { data: rows, error: null };
          },
        }),
      };
    },
  }),
}));

const LINEAR_ROW = {
  id: "c-1",
  name: "Linear",
  slug: "linear",
  description: null,
  url: "https://mcp.linear.app/mcp",
  auth_type: "oauth",
  auth_header: null,
  registry_name: null,
  enabled: true,
  credential_set_at: "2026-10-01T00:00:00Z",
  last_error: null,
  tools_cache: [],
};

let proxyBase: string | undefined = "https://proxy.test/v1";
vi.mock("@/ipc/shared/core_proxy", () => ({
  surfaceHeaders: () => ({ "X-Atlarix-Surface": "app" }),
  getCoreProxyBaseUrl: () => proxyBase,
  // The fallback wrapper (item 10) passes straight through with none configured.
  coreProxyFetch: (input: string, init?: RequestInit) => fetch(input, init),
}));

import {
  callAccountConnector,
  clearAccountConnectorsCache,
  enabledConnectorCount,
  listAccountConnectors,
  listConnectorRows,
} from "@/lib/mcp/account-connectors";

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let sent: Sent[];

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      });
      return { ok: status < 400, status, json: async () => body };
    }),
  );
}

beforeEach(() => {
  sent = [];
  token = "user-jwt";
  userId = "u-1";
  rows = [LINEAR_ROW];
  rowsError = null;
  reads = 0;
  gate = null;
  proxyBase = "https://proxy.test/v1";
  clearAccountConnectorsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listing", () => {
  it("labels the spend as the app, on the proxy's own endpoint", async () => {
    respond(200, { ok: true, servers: [{ name: "Linear", tools: [] }] });

    await listAccountConnectors();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://proxy.test/v1/mcp/list");
    expect(sent[0]!.headers["X-Atlarix-Surface"]).toBe("app");
    expect(sent[0]!.headers.Authorization).toBe("Bearer user-jwt");
  });

  it("keeps a server that failed, with its reason", async () => {
    // Dropping it would tell the model the connector does not exist, and it
    // would plan around an absence rather than report something fixable.
    respond(200, {
      ok: true,
      servers: [{ name: "Linear", tools: [], error: "upstream timed out" }],
    });

    const servers = await listAccountConnectors();

    expect(servers).toHaveLength(1);
    expect(servers[0]!.error).toBe("upstream timed out");
  });
});

describe("the quiet paths are quiet", () => {
  it("is empty when signed out", async () => {
    token = null;
    respond(200, { ok: true, servers: [{ name: "Linear", tools: [] }] });

    await expect(listAccountConnectors()).resolves.toEqual([]);
    // Not merely empty — it must not have ASKED. There is nothing to ask with.
    expect(sent).toHaveLength(0);
  });

  it("is empty for a headless session, which has no real token", async () => {
    // `require_auth_session` uses this sentinel. Sending it as a bearer would
    // be a guaranteed 401 on every turn.
    token = "atlarix-headless";
    respond(200, { ok: true, servers: [] });

    await expect(listAccountConnectors()).resolves.toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("is empty when no proxy is configured", async () => {
    proxyBase = undefined;
    respond(200, { ok: true, servers: [] });

    await expect(listAccountConnectors()).resolves.toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("is empty when the network throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(listAccountConnectors()).resolves.toEqual([]);
  });
});

describe("read once, again only when something says it changed (owner, 2026-10-20)", () => {
  // A new user's app read `account_mcp_servers` 48 times in 70 minutes, every
  // answer empty: the composer's MCP menu asked once per default server per
  // render, and every other caller asked again.

  it("a session's worth of callers is one read of the table and one proxy list", async () => {
    respond(200, { ok: true, servers: [{ name: "Linear", tools: [] }] });
    for (let turn = 0; turn < 20; turn++) {
      // The MCP menu (5 defaults), the on-count, the model's listing.
      await Promise.all([1, 2, 3, 4, 5].map(() => listConnectorRows()));
      await enabledConnectorCount();
      await listAccountConnectors();
    }
    expect(reads).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("an empty account stays empty: read once, the proxy never asked", async () => {
    rows = [];
    respond(200, { ok: true, servers: [] });
    for (let turn = 0; turn < 20; turn++) {
      await listConnectorRows();
      await expect(listAccountConnectors()).resolves.toEqual([]);
    }
    expect(reads).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("a clear (focus, sign-in, session start, a write) is one more read, not a timer", async () => {
    rows = [];
    await listConnectorRows();
    clearAccountConnectorsCache();
    await Promise.all([listConnectorRows(), listConnectorRows(), enabledConnectorCount()]);
    expect(reads).toBe(2);
  });

  it("another account never sees the last one's rows", async () => {
    await listConnectorRows();
    userId = "u-2";
    rows = [];
    await expect(listConnectorRows()).resolves.toEqual([]);
    expect(reads).toBe(2);
  });

  it("a failed read is not kept: offline is not 'none'", async () => {
    rowsError = { message: "fetch failed" };
    await expect(listConnectorRows()).resolves.toBeNull();
    rowsError = null;
    await expect(listConnectorRows()).resolves.toHaveLength(1);
    expect(reads).toBe(2);
  });

  it("a read that began before a clear is not kept after it", async () => {
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    const early = listConnectorRows();
    await vi.waitFor(() => expect(reads).toBe(1));
    clearAccountConnectorsCache();
    open();
    await early;
    gate = null;
    await listConnectorRows();
    expect(reads).toBe(2);
  });
});

describe("calling", () => {
  it("passes the tool and arguments through, labelled as the app", async () => {
    respond(200, { ok: true, result: { issues: 3 } });

    const out = await callAccountConnector("Linear", "search", { q: "bug" });

    expect(out).toEqual({ ok: true, result: { issues: 3 } });
    expect(sent[0]!.url).toBe("https://proxy.test/v1/mcp/call");
    expect(sent[0]!.headers["X-Atlarix-Surface"]).toBe("app");
    expect(sent[0]!.body).toEqual({
      server: "Linear",
      tool: "search",
      arguments: { q: "bug" },
    });
  });

  it("says the connector lives on the account when it cannot be reached", async () => {
    proxyBase = undefined;
    const out = await callAccountConnector("Linear", "search", {});
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.error).toMatch(/on your account/i);
  });

  it("surfaces the server's own failure rather than inventing one", async () => {
    respond(200, { ok: false, error: "rate limited by Linear" });
    const out = await callAccountConnector("Linear", "search", {});
    expect(out).toEqual({ ok: false, error: "rate limited by Linear" });
  });
});
