/**
 * DB Extension — Introspect schema (tables, columns, indexes, FK) from active connection.
 */

import type { DBConnection, DBConnectionType } from "./connection-manager";

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  defaultValue?: string;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  rowCount?: number;
}

export interface FKInfo {
  table: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface DBSchema {
  tables: TableInfo[];
  foreignKeys: FKInfo[];
}

/**
 * Fetch schema from a live connection. Caller must pass the raw client (pg Client or better-sqlite3).
 * For SQLite we use better-sqlite3 pragmas; for PostgreSQL we use information_schema.
 */
export async function introspectSchema(
  conn: DBConnection,
  client: unknown
): Promise<DBSchema> {
  if (conn.type === "sqlite") {
    return introspectSQLite(client);
  }
  if (conn.type === "postgresql") {
    return introspectPostgres(client);
  }
  return { tables: [], foreignKeys: [] };
}

async function introspectPostgres(client: unknown): Promise<DBSchema> {
  const tables: TableInfo[] = [];
  const foreignKeys: FKInfo[] = [];
  try {
    const pg = await import("pg");
    const c = client as pg.Client;
    const tablesRes = await c.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    for (const row of tablesRes.rows) {
      const tableName = row.table_name;
      const colsRes = await c.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);
      const pkRes = await c.query(`
        SELECT a.attname
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
      `, [tableName]);
      const pkSet = new Set(pkRes.rows.map((r: { attname: string }) => r.attname));
      const columns: ColumnInfo[] = colsRes.rows.map((r: { column_name: string; data_type: string; is_nullable: string; column_default: string | null }) => ({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === "YES",
        isPrimaryKey: pkSet.has(r.column_name),
        defaultValue: r.column_default ?? undefined,
      }));
      tables.push({ name: tableName, columns });
    }
    const fkRes = await c.query(`
      SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    `);
    for (const row of fkRes.rows) {
      foreignKeys.push({
        table: row.table_name,
        column: row.column_name,
        referencedTable: row.ref_table,
        referencedColumn: row.ref_column,
      });
    }
  } catch (e) {
    console.warn("[db-extension] introspectPostgres error:", e);
  }
  return { tables, foreignKeys };
}

async function introspectSQLite(client: unknown): Promise<DBSchema> {
  const tables: TableInfo[] = [];
  const foreignKeys: FKInfo[] = [];
  try {
    const db = client as { prepare: (sql: string) => { all: () => unknown[] } };
    const tableList = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    for (const { name } of tableList) {
      const cols = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string; type: string; notnull: number; pk: number }[];
      const columns: ColumnInfo[] = cols.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.notnull === 0,
        isPrimaryKey: c.pk === 1,
      }));
      tables.push({ name, columns });
    }
    const fkList = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    for (const { name } of fkList) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${name})`).all() as { table: string; from: string; to: string }[];
      for (const fk of fks) {
        foreignKeys.push({
          table: name,
          column: fk.from,
          referencedTable: fk.table,
          referencedColumn: fk.to,
        });
      }
    }
  } catch (e) {
    console.warn("[db-extension] introspectSQLite error:", e);
  }
  return { tables, foreignKeys };
}
