/**
 * DB Extension — Inject active schema into system prompt so AI understands DB structure.
 */

import {
  getActiveConnectionId,
  getConnection,
  getClient,
} from "./connection-manager";
import { introspectSchema } from "./schema-introspector";

/** workspaceId null = use global DB connection (chat without workspace); number = workspace active. */
export async function getSchemaContextForWorkspace(workspaceId: number | null): Promise<string> {
  const connId = getActiveConnectionId(workspaceId);
  if (!connId) return "";
  const conn = getConnection(connId);
  if (!conn || conn.status !== "connected") return "";
  const client = getClient(connId);
  if (!client) return "";
  const schema = await introspectSchema(conn, client);
  return formatSchemaBlock(conn.name, conn.type, schema);
}

function formatSchemaBlock(name: string, type: string, schema: { tables: { name: string; columns: { name: string; type: string; nullable: boolean; isPrimaryKey: boolean }[] }[]; foreignKeys: { table: string; column: string; referencedTable: string; referencedColumn: string }[] }): string {
  const lines: string[] = [
    "## Active Database: " + name + " (" + type + ")",
    "### Schema",
  ];
  for (const table of schema.tables) {
    lines.push("  " + table.name + ":");
    for (const c of table.columns) {
      let s = "    - " + c.name + ": " + c.type;
      if (!c.nullable) s += " NOT NULL";
      if (c.isPrimaryKey) s += " [PK]";
      lines.push(s);
    }
  }
  if (schema.foreignKeys.length > 0) {
    lines.push("### Relationships");
    for (const fk of schema.foreignKeys) {
      lines.push("  " + fk.table + "." + fk.column + " -> " + fk.referencedTable + "." + fk.referencedColumn);
    }
  }
  return lines.join("\n");
}
