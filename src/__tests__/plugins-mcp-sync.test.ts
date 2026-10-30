import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A plugin's MCP servers become this folder's rows: added switched off, updated
 * (and switched off again) when an approved update changes them, removed when
 * the plugin goes or stops verifying. Other rows are never touched.
 */

type Row = {
  id: number;
  name: string;
  transport: string;
  command: string | null;
  args: string[] | null;
  url: string | null;
  enabled: boolean;
  registryId: string | null;
  envJson?: { enc?: Record<string, string> } | null;
};
let rows: Row[] = [];
const inserted: Array<Record<string, unknown>> = [];
const updated: Array<Record<string, unknown>> = [];
const deleted: number[] = [];

vi.mock("@/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => rows }) }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        inserted.push(v);
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          updated.push(v);
        },
      }),
    }),
    delete: () => ({
      where: async (cond: unknown) => {
        deleted.push((cond as { _id?: number })._id ?? -1);
      },
    }),
  },
}));
vi.mock("drizzle-orm", async (orig) => {
  const actual = await orig<typeof import("drizzle-orm")>();
  return { ...actual, eq: (_c: unknown, v: unknown) => ({ _id: v }) };
});
vi.mock("@/lib/security/db-secrets", () => ({
  decryptEnvFromDb: (env: { enc?: Record<string, string> } | null) =>
    env?.enc ?? {},
  encryptEnvForDb: (env: Record<string, string> | null) =>
    env ? { enc: env } : null,
}));

const { removePluginMcpRows, syncPluginMcpServers } = await import(
  "@/lib/plugins/mcp-sync"
);
const { commitPluginInstall, preparePluginInstall, removePlugin } =
  await import("@/lib/plugins/install");
const { pluginDir } = await import("@/lib/plugins/paths");

let home: string;
let work: string;
let saved: string | undefined;

beforeEach(() => {
  home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-mcpsync-home-")),
  );
  work = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-mcpsync-src-")),
  );
  saved = process.env.ATLARIX_HOME_DIR;
  process.env.ATLARIX_HOME_DIR = home;
  rows = [];
  inserted.length = 0;
  updated.length = 0;
  deleted.length = 0;
});
afterEach(() => {
  if (saved === undefined) delete process.env.ATLARIX_HOME_DIR;
  else process.env.ATLARIX_HOME_DIR = saved;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

async function installDbPlugin() {
  const dir = path.join(work, "dbkit");
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "dbkit" }),
  );
  fs.writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        db: {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/server.js"],
          env: { DB_URL: "x" },
        },
      },
    }),
  );
  return commitPluginInstall(await preparePluginInstall(dir), {
    runnablesConfirmed: true,
  });
}

describe("plugin MCP rows", () => {
  it("adds a verified plugin's server switched off, with the plugin folder filled in", async () => {
    await installDbPlugin();
    await syncPluginMcpServers(7, "/ws");
    expect(inserted).toEqual([
      expect.objectContaining({
        name: "dbkit-db",
        transport: "stdio",
        command: "node",
        args: [path.join(pluginDir("dbkit"), "server.js")],
        envJson: { enc: { DB_URL: "x" } },
        enabled: false,
        scope: "workspace",
        appId: 7,
        registryId: "plugin:dbkit:db",
      }),
    ]);
  });

  it("leaves a matching row alone and removes rows of plugins that are gone", async () => {
    await installDbPlugin();
    rows = [
      {
        id: 1,
        name: "dbkit-db",
        transport: "stdio",
        command: "node",
        args: [path.join(pluginDir("dbkit"), "server.js")],
        url: null,
        enabled: true,
        registryId: "plugin:dbkit:db",
        envJson: { enc: { DB_URL: "x" } },
      },
      {
        id: 2,
        name: "old-x",
        transport: "stdio",
        command: "x",
        args: [],
        url: null,
        enabled: true,
        registryId: "plugin:old:x",
      },
      {
        id: 3,
        name: "github",
        transport: "http",
        command: null,
        args: null,
        url: "https://g",
        enabled: true,
        registryId: "github",
      },
    ];
    await syncPluginMcpServers(7, "/ws");
    expect(inserted).toEqual([]);
    expect(updated).toEqual([]);
    expect(deleted).toEqual([2]);
  });

  it("puts back a plugin row's env that was changed outside the plugin", async () => {
    await installDbPlugin();
    rows = [
      {
        id: 1,
        name: "dbkit-db",
        transport: "stdio",
        command: "node",
        args: [path.join(pluginDir("dbkit"), "server.js")],
        url: null,
        enabled: true,
        registryId: "plugin:dbkit:db",
        envJson: {
          enc: { DB_URL: "x", NODE_OPTIONS: "--require /tmp/evil.js" },
        },
      },
    ];
    await syncPluginMcpServers(7, "/ws");
    expect(updated).toEqual([
      expect.objectContaining({
        envJson: { enc: { DB_URL: "x" } },
        enabled: false,
      }),
    ]);
  });

  it("switches a row off again when the approved update changed its command", async () => {
    await installDbPlugin();
    rows = [
      {
        id: 1,
        name: "dbkit-db",
        transport: "stdio",
        command: "python",
        args: [],
        url: null,
        enabled: true,
        registryId: "plugin:dbkit:db",
      },
    ];
    await syncPluginMcpServers(7, "/ws");
    expect(updated).toEqual([
      expect.objectContaining({ command: "node", enabled: false }),
    ]);
  });

  it("removes the rows of a plugin that changed on disk or was removed", async () => {
    await installDbPlugin();
    rows = [
      {
        id: 1,
        name: "dbkit-db",
        transport: "stdio",
        command: "node",
        args: [path.join(pluginDir("dbkit"), "server.js")],
        url: null,
        enabled: true,
        registryId: "plugin:dbkit:db",
      },
    ];
    fs.writeFileSync(path.join(pluginDir("dbkit"), "server.js"), "evil");
    await syncPluginMcpServers(7, "/ws");
    expect(deleted).toEqual([1]);

    deleted.length = 0;
    removePlugin("dbkit");
    await syncPluginMcpServers(7, "/ws");
    expect(deleted).toEqual([1]);
  });

  it("never takes a name the folder already uses", async () => {
    await installDbPlugin();
    rows = [
      {
        id: 9,
        name: "DBKIT-DB",
        transport: "stdio",
        command: "mine",
        args: [],
        url: null,
        enabled: true,
        registryId: null,
      },
    ];
    await syncPluginMcpServers(7, "/ws");
    expect(inserted).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("removes exactly one plugin's rows (an underscore is not a wildcard)", async () => {
    const r = (id: number, registryId: string): Row => ({
      id,
      name: `n${id}`,
      transport: "stdio",
      command: "x",
      args: [],
      url: null,
      enabled: true,
      registryId,
    });
    rows = [
      r(1, "plugin:a_b:db"),
      r(2, "plugin:axb:db"),
      r(3, "plugin:a_bc:db"),
    ];
    await removePluginMcpRows("a_b");
    expect(deleted).toEqual([1]);
  });
});
