/**
 * The MCP marketplace catalog: cache, don't proxy.
 *
 * The official registry is a preview service; a search against it once hung
 * for over a minute. So the catalog is synced in the background and searched
 * locally, and every failure keeps what is already there:
 *   - no network on a first run: the shipped snapshot (or the Verified five);
 *   - a sync that fails half-way changes nothing;
 *   - after the first sync only what changed is fetched (`updated_since`),
 *     and a server deleted or deprecated upstream drops out.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

const TMP = path.join(os.tmpdir(), `atlarix-mcp-registry-test-${process.pid}`);
const USER_DATA = path.join(TMP, "userData");
const SNAPSHOT = path.join(TMP, "mcp-registry-snapshot.json.gz");

vi.mock("@/paths/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/paths/paths")>()),
  getUserDataPath: () => USER_DATA,
}));
vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: { getAllWindows: () => [] },
}));

const { refreshMcpRegistry, resetMcpRegistryState, searchMcpCatalog, getMcpRegistryServer } = await import(
  "@/lib/mcp/registry-catalog"
);

const OFFICIAL = "io.modelcontextprotocol.registry/official";
const item = (name: string, opts: { status?: string; updatedAt?: string; title?: string; web?: boolean } = {}) => ({
  server: {
    $schema: "https://static.modelcontextprotocol.io/schemas/x.json",
    name,
    title: opts.title,
    description: `${name} description`,
    ...(opts.web === false
      ? { packages: [{ registryType: "npm", identifier: name.split("/")[1] }] }
      : { remotes: [{ type: "streamable-http", url: `https://${name.split("/")[1]}.example.com/mcp` }] }),
  },
  _meta: { [OFFICIAL]: { status: opts.status ?? "active", updatedAt: opts.updatedAt ?? "2026-10-01T00:00:00Z", isLatest: true } },
});

type Page = { servers: unknown[]; metadata: { nextCursor?: string } };
let pages: Page[] = [];
let calls: URL[] = [];
let failAt: number | null = null;

function stubRegistry() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      calls.push(url);
      const i = calls.length - 1;
      if (failAt !== null && i >= failAt) return new Response("down", { status: 503 }); // retries fail too
      const page = pages[i] ?? { servers: [], metadata: {} };
      return new Response(JSON.stringify(page), { status: 200 });
    }),
  );
}

async function cacheFile() {
  return JSON.parse(await fs.readFile(path.join(USER_DATA, "cache", "mcp-registry.json"), "utf8"));
}

beforeEach(async () => {
  resetMcpRegistryState();
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(TMP, { recursive: true });
  delete process.env.ATLARIX_MCP_REGISTRY_SNAPSHOT;
  pages = [];
  failAt = null;
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("before any sync", () => {
  it("shows the Verified five even with no cache and no snapshot", async () => {
    const r = await searchMcpCatalog("");
    expect(r.entries.map((e) => e.title)).toEqual(["Sentry", "Notion", "Supabase", "Canva", "Linear"]);
    expect(await getMcpRegistryServer("app.linear/linear")).toMatchObject({ remotes: [{ url: "https://mcp.linear.app/mcp" }] });
  });

  it("uses the shipped snapshot when there is no cache", async () => {
    await fs.writeFile(
      SNAPSHOT,
      gzipSync(JSON.stringify({ version: 1, syncedAt: "2026-10-01T00:00:00Z", records: [{ server: { name: "io.github.a/snap", title: "Snap", remotes: [{ type: "streamable-http", url: "https://snap.dev/mcp" }] }, status: "active" }] })),
    );
    process.env.ATLARIX_MCP_REGISTRY_SNAPSHOT = SNAPSHOT;
    const r = await searchMcpCatalog("snap");
    expect(r.entries.map((e) => e.name)).toEqual(["io.github.a/snap"]);
  });
});

describe("syncing", () => {
  it("pages through the first sync, keeps the latest active entries, and drops what it can't install", async () => {
    pages = [
      { servers: [item("io.github.a/one", { title: "One" }), item("io.github.a/gone", { status: "deleted" })], metadata: { nextCursor: "c1" } },
      {
        servers: [
          item("io.github.a/two", { title: "Two", web: false, updatedAt: "2026-10-05T00:00:00Z" }),
          { ...item("io.github.a/sse"), server: { name: "io.github.a/sse", remotes: [{ type: "sse", url: "https://x/sse" }] } },
        ],
        metadata: {},
      },
    ];
    stubRegistry();
    await refreshMcpRegistry();

    expect(calls).toHaveLength(2);
    expect(calls[0]!.searchParams.get("version")).toBe("latest");
    expect(calls[0]!.searchParams.get("updated_since")).toBeNull();
    expect(calls[1]!.searchParams.get("cursor")).toBe("c1");

    const file = await cacheFile();
    expect(file.records.map((r: { server: { name: string } }) => r.server.name).sort()).toEqual(["io.github.a/one", "io.github.a/two"]);
    expect(file.syncedAt).toBe("2026-10-05T00:00:00Z");
    // Publisher-provided _meta and $schema are not kept.
    expect(JSON.stringify(file)).not.toContain("$schema");

    const r = await searchMcpCatalog("one");
    expect(r.entries[0]).toMatchObject({ name: "io.github.a/one", title: "One", kind: "web" });
  });

  it("then fetches only what changed, applying additions and removals", async () => {
    pages = [{ servers: [item("io.github.a/one"), item("io.github.a/two", { updatedAt: "2026-10-05T00:00:00Z" })], metadata: {} }];
    stubRegistry();
    await refreshMcpRegistry();

    resetMcpRegistryState();
    pages = [
      {
        servers: [
          item("io.github.a/one", { status: "deprecated", updatedAt: "2026-10-06T00:00:00Z" }),
          item("io.github.a/three", { updatedAt: "2026-10-07T00:00:00Z" }),
        ],
        metadata: {},
      },
    ];
    stubRegistry();
    await refreshMcpRegistry();

    // A minute early: re-reading an entry is harmless, missing one is not.
    expect(calls[0]!.searchParams.get("updated_since")).toBe("2026-10-04T23:59:00.000Z");
    const names = (await cacheFile()).records.map((r: { server: { name: string } }) => r.server.name).sort();
    expect(names).toEqual(["io.github.a/three", "io.github.a/two"]);
  });

  it("changes nothing when a page fails part-way", async () => {
    pages = [{ servers: [item("io.github.a/one")], metadata: {} }];
    stubRegistry();
    await refreshMcpRegistry();
    const before = await cacheFile();

    resetMcpRegistryState();
    pages = [
      { servers: [item("io.github.a/new", { updatedAt: "2026-10-09T00:00:00Z" })], metadata: { nextCursor: "c" } },
    ];
    failAt = 1;
    stubRegistry();
    await refreshMcpRegistry();

    expect(await cacheFile()).toEqual(before);
    expect((await searchMcpCatalog("new")).entries.find((e) => e.name === "io.github.a/new")).toBeUndefined();
  });

  it("shares one sync between callers", async () => {
    pages = [{ servers: [item("io.github.a/one")], metadata: {} }];
    stubRegistry();
    await Promise.all([refreshMcpRegistry(), refreshMcpRegistry(), refreshMcpRegistry()]);
    expect(calls).toHaveLength(1);
  });
});
