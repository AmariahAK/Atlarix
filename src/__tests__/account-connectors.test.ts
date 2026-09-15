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
vi.mock("@/lib/auth/supabase-client", () => ({
  getSession: async () => (token ? { access_token: token } : null),
}));

let proxyBase: string | undefined = "https://proxy.test/v1";
vi.mock("@/ipc/shared/core_proxy", () => ({
  ATLARIX_SURFACE: "app",
  getCoreProxyBaseUrl: () => proxyBase,
}));

import {
  callAccountConnector,
  clearAccountConnectorsCache,
  listAccountConnectors,
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
