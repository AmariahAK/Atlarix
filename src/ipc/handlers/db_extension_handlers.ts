/**
 * DB Extension IPC handlers — CRUD connections, connect/disconnect, schema, query.
 * v4.0: Gated on Workforce tier or grandfathered Pro (hasDbStudioLegacy).
 */

import { ipcMain } from "electron";
import { SubscriptionManager } from "../../lib/SubscriptionManager";
import { capture as analyticsCapture } from "../../main/lib/analytics";
import { v4 as uuidv4 } from "uuid";
import {
  listConnections,
  getActiveConnectionId,
  getConnection,
  getClient,
  setClient,
  clearClient,
  setActiveConnection,
  saveConnection,
  deleteConnection,
  type DBConnection,
  type DBConnectionConfig,
  type DBConnectionType,
} from "@/lib/workforce/db-extension/connection-manager";
import { introspectSchema } from "@/lib/workforce/db-extension/schema-introspector";
import { parseConnectionString } from "@/lib/workforce/db-extension/connection-string";

/** Run a quick test query; closes client after. */
async function runTestQuery(client: unknown, type: DBConnectionType): Promise<{ ok: boolean; error?: string }> {
  try {
    if (type === "postgresql") {
      const c = client as { query: (sql: string) => Promise<{ rows: unknown[] }> };
      await c.query("SELECT 1");
      return { ok: true };
    }
    if (type === "mysql") {
      const c = client as { execute: (sql: string) => Promise<unknown> };
      await c.execute("SELECT 1");
      return { ok: true };
    }
    if (type === "sqlite") {
      const db = client as { prepare: (sql: string) => { get: () => unknown } };
      db.prepare("SELECT 1").get();
      return { ok: true };
    }
    return { ok: false, error: "Unsupported type for test" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function connectClient(conn: DBConnection): Promise<unknown> {
  if (conn.type === "postgresql") {
    const { Client } = await import("pg");
    const c = new Client({
      host: conn.config.host ?? "127.0.0.1",
      port: conn.config.port ?? 5432,
      user: conn.config.username,
      password: conn.config.password,
      database: conn.config.database,
      ssl: conn.config.ssl ? { rejectUnauthorized: false } : undefined,
      connectionString: conn.config.connectionString || undefined,
    });
    await c.connect();
    return c;
  }
  if (conn.type === "mysql") {
    const mysql2 = await import("mysql2/promise");
    const c = await mysql2.createConnection({
      host: conn.config.host ?? "127.0.0.1",
      port: conn.config.port ?? 3306,
      user: conn.config.username,
      password: conn.config.password,
      database: conn.config.database,
    });
    return c;
  }
  if (conn.type === "sqlite") {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(conn.config.filename ?? ":memory:");
    return db;
  }
  throw new Error(`Unsupported connection type: ${conn.type}`);
}

/** v4.0: DB Studio is Workforce-only; grandfathered Pro users retain access */
function canAccessDbStudio(): boolean {
  return (
    SubscriptionManager.getEffectiveTier() === "workforce" ||
    SubscriptionManager.hasDbStudioLegacy()
  );
}

const DB_STUDIO_UPGRADE_MESSAGE =
  "DB Studio is now part of Workforce. Upgrade to access, or your existing Pro access is maintained if you were subscribed before this change.";

export function registerDbExtensionHandlers() {
  ipcMain.handle(
    "db:parse-connection-string",
    async (_, { connectionString }: { connectionString: string }) => {
      const parsed = parseConnectionString(connectionString);
      if (!parsed) return null;
      const type = parsed.type as DBConnectionType;
      if (type === "mssql") return null; // Not yet supported by connectClient
      return {
        type,
        config: parsed.config,
        database: parsed.database,
      };
    }
  );

  ipcMain.handle(
    "db:test-connection",
    async (
      _,
      payload:
        | { connectionId: string }
        | { type: DBConnectionType; config: DBConnectionConfig }
    ) => {
      if (!canAccessDbStudio()) return { success: false, error: DB_STUDIO_UPGRADE_MESSAGE };
      if ("connectionId" in payload) {
        const conn = getConnection(payload.connectionId);
        if (!conn) return { success: false, error: "Connection not found" };
        const existingClient = getClient(payload.connectionId);
        if (existingClient && conn.status === "connected") {
          const result = await runTestQuery(existingClient, conn.type);
          return result.ok ? { success: true } : { success: false, error: result.error };
        }
        let tempClient: unknown = null;
        try {
          tempClient = await connectClient(conn);
          const result = await runTestQuery(tempClient, conn.type);
          if (!result.ok) return { success: false, error: result.error };
          return { success: true };
        } finally {
          if (tempClient && conn.type === "postgresql") await (tempClient as { end: () => Promise<void> }).end();
          if (tempClient && conn.type === "mysql") await (tempClient as { end: () => Promise<void> }).end();
          if (tempClient && conn.type === "sqlite") (tempClient as { close: () => void }).close();
        }
      } else {
        const { type, config } = payload;
        const conn: DBConnection = {
          id: "test-temp",
          name: "Test",
          type,
          config,
          isProd: false,
          status: "disconnected",
        };
        let client: unknown = null;
        try {
          client = await connectClient(conn);
          const result = await runTestQuery(client, type);
          if (!result.ok) return { success: false, error: result.error };
          return { success: true };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        } finally {
          if (client && type === "postgresql") await (client as { end: () => Promise<void> }).end();
          if (client && type === "mysql") await (client as { end: () => Promise<void> }).end();
          if (client && type === "sqlite") (client as { close: () => void }).close();
        }
      }
    }
  );

  ipcMain.handle(
    "db:list-connections",
    async (_, { workspaceId }: { workspaceId: number | null }) => {
      if (!canAccessDbStudio()) return { connections: [], activeId: null, error: DB_STUDIO_UPGRADE_MESSAGE };
      const conns = listConnections();
      const activeId = getActiveConnectionId(workspaceId);
      const isLegacy = SubscriptionManager.hasDbStudioLegacy();
      return {
        connections: conns.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          status: c.status,
          isProd: c.isProd,
        })),
        activeId,
        dbStudioMigrationNotice: isLegacy
          ? "DB Studio is now part of Workforce. Your existing access is maintained."
          : undefined,
      };
    }
  );

  ipcMain.handle(
    "db:save-connection",
    async (_, { name, type, config, isProd }: {
      name: string;
      type: DBConnectionType;
      config: DBConnectionConfig;
      isProd?: boolean;
    }) => {
      if (!canAccessDbStudio()) return { id: "", success: false, error: DB_STUDIO_UPGRADE_MESSAGE };
      const id = uuidv4();
      const conn: DBConnection = {
        id,
        name,
        type,
        config,
        isProd: isProd ?? false,
        status: "disconnected",
      };
      saveConnection(conn);
      return { id, success: true };
    }
  );

  ipcMain.handle(
    "db:delete-connection",
    async (_, { connectionId }: { connectionId: string }) => {
      if (!canAccessDbStudio()) return { success: false, error: DB_STUDIO_UPGRADE_MESSAGE };
      deleteConnection(connectionId);
      return { success: true };
    }
  );

  ipcMain.handle(
    "db:connect",
    async (_, { connectionId }: { connectionId: string }) => {
      if (!canAccessDbStudio()) return { error: DB_STUDIO_UPGRADE_MESSAGE };
      const conn = getConnection(connectionId);
      if (!conn) return { error: "Connection not found" };
      try {
        const client = await connectClient(conn);
        setClient(connectionId, client);
        conn.status = "connected";
        conn.errorMessage = undefined;
        saveConnection(conn);
        return { success: true };
      } catch (e) {
        conn.status = "error";
        conn.errorMessage = e instanceof Error ? e.message : String(e);
        saveConnection(conn);
        return { error: conn.errorMessage };
      }
    }
  );

  ipcMain.handle(
    "db:disconnect",
    async (_, { connectionId }: { connectionId: string }) => {
      if (!canAccessDbStudio()) return { success: false, error: DB_STUDIO_UPGRADE_MESSAGE };
      const conn = getConnection(connectionId);
      const client = getClient(connectionId);
      if (client) {
        try {
          if (conn?.type === "postgresql" && typeof (client as { end?: () => Promise<void> }).end === "function") {
            await (client as { end: () => Promise<void> }).end();
          }
          if (conn?.type === "mysql" && typeof (client as { end?: () => Promise<void> }).end === "function") {
            await (client as { end: () => Promise<void> }).end();
          }
          if (conn?.type === "sqlite" && typeof (client as { close?: () => void }).close === "function") {
            (client as { close: () => void }).close();
          }
        } catch { /* best-effort */ }
        clearClient(connectionId);
      }
      if (conn) {
        conn.status = "disconnected";
        saveConnection(conn);
      }
      return { success: true };
    }
  );

  ipcMain.handle(
    "db:set-active-connection",
    async (_, { workspaceId, connectionId }: { workspaceId: number | null; connectionId: string | null }) => {
      if (!canAccessDbStudio()) return { success: false, error: DB_STUDIO_UPGRADE_MESSAGE };
      setActiveConnection(workspaceId, connectionId);
      return { success: true };
    }
  );

  ipcMain.handle(
    "db:get-schema",
    async (_, { workspaceId }: { workspaceId: number | null }) => {
      if (!canAccessDbStudio()) return null;
      const connId = getActiveConnectionId(workspaceId);
      if (!connId) return null;
      const conn = getConnection(connId);
      const client = getClient(connId);
      if (!conn || !client || conn.status !== "connected") return null;
      const dbType = conn.type === "postgresql" ? "postgres" : conn.type === "mysql" ? "mysql" : "sqlite";
      analyticsCapture("db_extension_used", { db_type: dbType });
      const schema = await introspectSchema(conn, client);
      return {
        tables: schema.tables.map((t) => ({
          name: t.name,
          columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
        })),
        foreignKeys: schema.foreignKeys,
      };
    }
  );

  ipcMain.handle(
    "db:run-query",
    async (_, { workspaceId, query }: { workspaceId: number | null; query: string }) => {
      if (!canAccessDbStudio()) return { error: DB_STUDIO_UPGRADE_MESSAGE };
      const connId = getActiveConnectionId(workspaceId);
      if (!connId) return { error: "No active connection" };
      const conn = getConnection(connId);
      const client = getClient(connId);
      if (!conn || !client || conn.status !== "connected") return { error: "Not connected" };
      const dbType = conn.type === "postgresql" ? "postgres" : conn.type === "mysql" ? "mysql" : "sqlite";
      analyticsCapture("db_extension_used", { db_type: dbType });
      try {
        if (conn.type === "postgresql") {
          const pgMod = await import("pg");
          type PgClient = InstanceType<typeof pgMod.Client>;
          const c = client as PgClient;
          const res = await c.query(query);
          return { rows: res.rows ?? [] };
        }
        if (conn.type === "sqlite") {
          const db = client as { prepare: (sql: string) => { all: () => unknown[] } };
          const res = db.prepare(query).all();
          return { rows: Array.isArray(res) ? res : [] };
        }
        if (conn.type === "mysql") {
          const c = client as { execute: (sql: string) => Promise<[unknown[], unknown]> };
          const [rows] = await c.execute(query);
          return { rows: Array.isArray(rows) ? rows : [] };
        }
        return { error: "Unsupported connection type" };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }
  );

  ipcMain.handle(
    "db:get-table-data",
    async (_, { workspaceId, table }: { workspaceId: number | null; table: string }) => {
      if (!canAccessDbStudio()) return { error: DB_STUDIO_UPGRADE_MESSAGE, rows: [] };
      const connId = getActiveConnectionId(workspaceId);
      if (!connId) return { error: "No active connection" };
      const conn = getConnection(connId);
      const client = getClient(connId);
      if (!conn || !client || conn.status !== "connected") return { error: "Not connected" };
      const safeTable = table.replace(/[^a-zA-Z0-9_]/g, "");
      if (safeTable !== table) return { error: "Invalid table name" };
      try {
        if (conn.type === "postgresql") {
          const pgMod = await import("pg");
          type PgClient = InstanceType<typeof pgMod.Client>;
          const c = client as PgClient;
          const res = await c.query(`SELECT * FROM "${safeTable}" LIMIT 50`);
          return { rows: res.rows ?? [] };
        }
        if (conn.type === "sqlite") {
          const db = client as { prepare: (sql: string) => { all: () => unknown[] } };
          const res = db.prepare(`SELECT * FROM ${safeTable} LIMIT 50`).all();
          return { rows: Array.isArray(res) ? res : [] };
        }
        if (conn.type === "mysql") {
          const c = client as { execute: (sql: string) => Promise<[unknown[], unknown]> };
          const [rows] = await c.execute(`SELECT * FROM \`${safeTable}\` LIMIT 50`);
          return { rows: Array.isArray(rows) ? rows : [] };
        }
        return { error: "Unsupported connection type" };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }
  );
}
