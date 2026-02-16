/**
 * OpenTelemetry SpanExporter that writes spans to SQLite.
 * Used for lightweight in-process tracing; DB at ~/.atlarix/telemetry.db (or userData/telemetry.db).
 */

import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

function hrTimeToMs(hrTime: [number, number]): number {
  return hrTime[0] * 1000 + hrTime[1] / 1e6;
}

export interface SqliteExporterOptions {
  dbPath: string;
}

export class SqliteExporter implements SpanExporter {
  private db: Database.Database;

  constructor(options: SqliteExporterOptions) {
    const dir = path.dirname(options.dbPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // may already exist
    }
    this.db = new Database(options.dbPath);

    this.db.exec(`
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
    `);
  }

  export(spans: ReadableSpan[], resultCallback: (result: { code: number; error?: Error }) => void): void {
    if (spans.length === 0) {
      resultCallback({ code: 0 });
      return;
    }
    try {
      const insert = this.db.prepare(`
        INSERT OR REPLACE INTO spans (span_id, trace_id, parent_span_id, name, start_time, end_time, duration_ms, attributes, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const runMany = this.db.transaction((list: ReadableSpan[]) => {
        for (const span of list) {
          const ctx = span.spanContext();
          const startMs = hrTimeToMs(span.startTime);
          const endMs = hrTimeToMs(span.endTime);
          const durationMs = endMs - startMs;
          insert.run(
            ctx.spanId,
            ctx.traceId,
            span.parentSpanId ?? null,
            span.name,
            Math.round(startMs),
            Math.round(endMs),
            durationMs,
            JSON.stringify(span.attributes ?? {}),
            span.status?.code ?? 0
          );
        }
      });

      runMany(spans);
      resultCallback({ code: 0 });
    } catch (err) {
      resultCallback({ code: 1, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }

  shutdown(): Promise<void> {
    return new Promise((resolve) => {
      this.db.close();
      resolve();
    });
  }
}
