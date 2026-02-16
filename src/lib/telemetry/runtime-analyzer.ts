/**
 * Query telemetry spans from SQLite for Blueprint runtime overlay.
 * Call frequency, latency, call graph, and hot paths.
 */

import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
import { getUserDataPath } from "@/paths/paths";

const SPANS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS spans (
    span_id TEXT PRIMARY KEY,
    trace_id TEXT,
    parent_span_id TEXT,
    name TEXT,
    start_time INTEGER,
    end_time INTEGER,
    duration_ms REAL,
    attributes TEXT,
    status INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_spans_trace_id ON spans(trace_id);
  CREATE INDEX IF NOT EXISTS idx_spans_name ON spans(name);
  CREATE INDEX IF NOT EXISTS idx_spans_start_time ON spans(start_time);
`;

export class RuntimeAnalyzer {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const pathToUse = dbPath ?? path.join(getUserDataPath(), "telemetry.db");
    const dir = path.dirname(pathToUse);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // may already exist
    }
    this.db = new Database(pathToUse);
    this.db.exec(SPANS_SCHEMA);
  }

  /**
   * Get call count for a function in the last N hours.
   */
  getCallFrequency(functionName: string, hours: number = 24): number {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM spans WHERE name = ? AND start_time > ?"
    ).get(functionName, cutoff) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * Get average duration in ms for a function.
   */
  getAverageLatency(functionName: string): number {
    const row = this.db.prepare(
      "SELECT AVG(duration_ms) as avg_latency FROM spans WHERE name = ?"
    ).get(functionName) as { avg_latency: number | null } | undefined;
    return row?.avg_latency ?? 0;
  }

  /**
   * Get call graph: caller -> list of callees (by span parent/child).
   */
  getCallGraph(): Map<string, string[]> {
    const rows = this.db.prepare(`
      SELECT parent.name AS caller, child.name AS callee
      FROM spans child
      LEFT JOIN spans parent ON child.parent_span_id = parent.span_id
      WHERE parent.name IS NOT NULL
      GROUP BY parent.name, child.name
    `).all() as Array<{ caller: string; callee: string }>;

    const graph = new Map<string, string[]>();
    for (const row of rows) {
      const list = graph.get(row.caller) ?? [];
      if (!list.includes(row.callee)) list.push(row.callee);
      graph.set(row.caller, list);
    }
    return graph;
  }

  /**
   * Get most frequently called span names in the last N hours.
   */
  getHotPaths(limit: number = 10, hours: number = 24): Array<{ name: string; count: number }> {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const rows = this.db.prepare(`
      SELECT name, COUNT(*) AS count
      FROM spans
      WHERE start_time > ?
      GROUP BY name
      ORDER BY count DESC
      LIMIT ?
    `).all(cutoff, limit) as Array<{ name: string; count: number }>;
    return rows;
  }

  close(): void {
    this.db.close();
  }
}
