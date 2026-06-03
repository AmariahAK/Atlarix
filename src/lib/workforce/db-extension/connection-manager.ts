/**
 * DB Extension — Connection lifecycle and active connection per workspace or global.
 * Connections are persisted in user settings; active is one global + one per workspace.
 */

import { readSettings, writeSettings } from "../../../main/settings";
import type { DBConnectionStored } from "../../../lib/schemas";

export type DBConnectionType = "postgresql" | "sqlite" | "mysql";

export interface DBConnectionConfig {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
  /** For SQLite: path to .db file */
  filename?: string;
  connectionString?: string;
}

export interface DBConnection {
  id: string;
  name: string;
  type: DBConnectionType;
  config: DBConnectionConfig;
  isProd: boolean;
  status: "connected" | "disconnected" | "error";
  errorMessage?: string;
}

/** Global active connection ID (used when workspaceId is null). */
let activeGlobalId: string | null = null;

/** Workspace ID -> active connection ID */
const activeConnectionByWorkspace = new Map<number, string>();

/** Connection configs (loaded from persistence, then in-memory). */
const connections = new Map<string, DBConnection>();

/** Raw client instances (pg Client or better-sqlite3 Database) — main process only */
let clientInstances: Map<string, unknown> = new Map();

let loadedFromSettings = false;

function loadFromSettings(): void {
  if (loadedFromSettings) return;
  loadedFromSettings = true;
  const settings = readSettings();
  const stored = settings.dbConnections ?? [];
  connections.clear();
  for (const s of stored) {
    connections.set(s.id, {
      id: s.id,
      name: s.name,
      type: s.type,
      config: { ...s.config },
      isProd: s.isProd ?? false,
      status: "disconnected",
    });
  }
  activeGlobalId = settings.dbActiveGlobalId ?? null;
  activeConnectionByWorkspace.clear();
  const byWorkspace = settings.dbActiveByWorkspace ?? {};
  for (const [wid, cid] of Object.entries(byWorkspace)) {
    const n = parseInt(wid, 10);
    if (!Number.isNaN(n)) activeConnectionByWorkspace.set(n, cid);
  }
}

function persistConnections(): void {
  const list: DBConnectionStored[] = Array.from(connections.values()).map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    config: { ...c.config },
    isProd: c.isProd,
    scope: "workspace",
    workspaceId: null,
  }));
  const byWorkspace: Record<string, string> = {};
  activeConnectionByWorkspace.forEach((cid, wid) => {
    byWorkspace[String(wid)] = cid;
  });
  writeSettings({
    dbConnections: list,
    dbActiveGlobalId: activeGlobalId,
    dbActiveByWorkspace: byWorkspace,
  });
}

export function setClientInstancesForTesting(instances: Map<string, unknown>) {
  clientInstances = instances;
}

/** workspaceId null = global (chat without workspace); number = that workspace's active. */
export function getActiveConnectionId(workspaceId: number | null): string | null {
  loadFromSettings();
  if (workspaceId === null) return activeGlobalId;
  return activeConnectionByWorkspace.get(workspaceId) ?? null;
}

export function setActiveConnection(workspaceId: number | null, connectionId: string | null): void {
  loadFromSettings();
  if (workspaceId === null) {
    activeGlobalId = connectionId;
  } else {
    if (connectionId === null) {
      activeConnectionByWorkspace.delete(workspaceId);
    } else {
      activeConnectionByWorkspace.set(workspaceId, connectionId);
    }
  }
  persistConnections();
}

export function listConnections(): DBConnection[] {
  loadFromSettings();
  return Array.from(connections.values());
}

export function getConnection(id: string): DBConnection | undefined {
  loadFromSettings();
  return connections.get(id);
}

export function saveConnection(conn: DBConnection): void {
  loadFromSettings();
  connections.set(conn.id, { ...conn });
  persistConnections();
}

export function deleteConnection(id: string): void {
  loadFromSettings();
  connections.delete(id);
  clientInstances.delete(id);
  if (activeGlobalId === id) activeGlobalId = null;
  for (const [wid, cid] of activeConnectionByWorkspace) {
    if (cid === id) activeConnectionByWorkspace.delete(wid);
  }
  persistConnections();
}

export function getClient(connectionId: string): unknown {
  return clientInstances.get(connectionId);
}

export function setClient(connectionId: string, client: unknown): void {
  clientInstances.set(connectionId, client);
}

export function clearClient(connectionId: string): void {
  clientInstances.delete(connectionId);
}
