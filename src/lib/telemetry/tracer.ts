/**
 * OpenTelemetry tracer initialization for Atlarix.
 * Exports spans to SQLite via SqliteExporter; runs in Electron main process.
 */

import * as path from "node:path";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { Resource } from "@opentelemetry/resources";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SqliteExporter } from "./sqlite-exporter";
import { getUserDataPath } from "@/paths/paths";
import log from "electron-log";

let provider: NodeTracerProvider | null = null;

/**
 * Initialize OpenTelemetry tracing. Spans are written to ~/.atlarix/telemetry.db
 * (or userData/telemetry.db). Call once from main process (e.g. in onReady).
 */
export function initTelemetry(): NodeTracerProvider | null {
  if (provider) return provider;
  try {
    const userData = getUserDataPath();
    const dbPath = path.join(userData, "telemetry.db");

    const res = new Resource({
      "service.name": "atlarix-app",
    });

    provider = new NodeTracerProvider({ resource: res });
    provider.addSpanProcessor(new SimpleSpanProcessor(new SqliteExporter({ dbPath })));
    provider.register();

    return provider;
  } catch (err) {
    // Do not block startup; telemetry is optional
    log.scope("telemetry").warn("Failed to init OpenTelemetry:", err);
    return null;
  }
}
