/**
 * DB Extension — Parse connection strings and auto-detect engine.
 * Supports: postgres/postgresql, mysql, mariadb, sqlite, mssql.
 */

export type ParsedEngine = "postgresql" | "mysql" | "sqlite" | "mssql";

export interface ParsedConnection {
  type: ParsedEngine;
  database?: string;
  config: {
    connectionString?: string;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    database?: string;
    filename?: string;
    ssl?: boolean;
  };
}

/**
 * Detect engine from connection string prefix and parse into config.
 * Returns null if string is empty or unrecognized.
 */
export function parseConnectionString(raw: string): ParsedConnection | null {
  const s = raw.trim();
  if (!s) return null;

  const lower = s.toLowerCase();

  // PostgreSQL: postgres://, postgresql://
  if (lower.startsWith("postgresql://") || lower.startsWith("postgres://")) {
    try {
      const url = new URL(s);
      const dbName = url.pathname ? url.pathname.replace(/^\//, "").replace(/\/$/, "") : undefined;
      const config: ParsedConnection["config"] = {
        connectionString: s,
        host: url.hostname || undefined,
        port: url.port ? parseInt(url.port, 10) : 5432,
        username: url.username || undefined,
        password: url.password || undefined,
        database: dbName || undefined,
        ssl: url.searchParams.get("sslmode") === "require" || url.protocol === "https:",
      };
      return {
        type: "postgresql",
        database: config.database,
        config,
      };
    } catch {
      return { type: "postgresql", config: { connectionString: s } };
    }
  }

  // MySQL / MariaDB: mysql://, mariadb://
  if (lower.startsWith("mysql://") || lower.startsWith("mariadb://")) {
    try {
      const url = new URL(s);
      const dbName = url.pathname ? url.pathname.replace(/^\//, "").replace(/\/$/, "") : undefined;
      const config: ParsedConnection["config"] = {
        connectionString: s,
        host: url.hostname || undefined,
        port: url.port ? parseInt(url.port, 10) : 3306,
        username: url.username || undefined,
        password: url.password || undefined,
        database: dbName || undefined,
      };
      return {
        type: "mysql",
        database: config.database,
        config,
      };
    } catch {
      return { type: "mysql", config: { connectionString: s } };
    }
  }

  // SQLite: sqlite:, sqlite3:, file:
  if (lower.startsWith("sqlite:") || lower.startsWith("sqlite3:") || lower.startsWith("file:")) {
    const path = s.replace(/^(sqlite3?|file):\/?\s*/i, "").trim() || ":memory:";
    return {
      type: "sqlite",
      config: { filename: path },
    };
  }

  // MSSQL: mssql://, sqlserver://
  if (lower.startsWith("mssql://") || lower.startsWith("sqlserver://")) {
    try {
      const url = new URL(s);
      const dbName = url.pathname ? url.pathname.replace(/^\//, "").replace(/\/$/, "") : undefined;
      const config: ParsedConnection["config"] = {
        connectionString: s,
        host: url.hostname || undefined,
        port: url.port ? parseInt(url.port, 10) : 1433,
        username: url.username || undefined,
        password: url.password || undefined,
        database: dbName || undefined,
      };
      return {
        type: "mssql",
        database: config.database,
        config,
      };
    } catch {
      return { type: "mssql", config: { connectionString: s } };
    }
  }

  return null;
}
