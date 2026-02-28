/**
 * DB Extension IPC handlers — CRUD connections, connect/disconnect, schema, query.
 */

import { ipcMain } from "electron";
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

export function registerDbExtensionHandlers() {
  ipcMain.handle(
    "db:list-connections",
    async (_, { workspaceId }: { workspaceId: number | null }) => {
      const conns = listConnections();
      const activeId = getActiveConnectionId(workspaceId);
      return {
        connections: conns.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          status: c.status,
          isProd: c.isProd,
        })),
        activeId,
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
      deleteConnection(connectionId);
      return { success: true };
    }
  );

  ipcMain.handle(
    "db:connect",
    async (_, { connectionId }: { connectionId: string }) => {
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
      setActiveConnection(workspaceId, connectionId);
      return { success: true };
    }
  );

  ipcMain.handle(
    "db:get-schema",
    async (_, { workspaceId }: { workspaceId: number | null }) => {
      const connId = getActiveConnectionId(workspaceId);
      if (!connId) return null;
      const conn = getConnection(connId);
      const client = getClient(connId);
      if (!conn || !client || conn.status !== "connected") return null;
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
      const connId = getActiveConnectionId(workspaceId);
      if (!connId) return { error: "No active connection" };
      const conn = getConnection(connId);
      const client = getClient(connId);
      if (!conn || !client || conn.status !== "connected") return { error: "Not connected" };
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
