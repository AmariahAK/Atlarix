// startProxy.js – helper to launch proxy.js as a worker

import { Worker } from "worker_threads";
import { existsSync } from "fs";
import path from "path";
import { findAvailablePort } from "./port_utils";
import log from "electron-log";

const logger = log.scope("start_proxy_server");

/**
 * Locate `worker/proxy_server.js`.
 *
 * A single hardcoded `__dirname/../../worker` only worked in the PACKAGED build,
 * where `__dirname` is `.vite/build`. Under vitest `__dirname` is `src/ipc/utils`,
 * so it resolved to a non-existent `src/worker/` and the worker died with
 * "Cannot find module" — which meant the `proxy-worker` self-test probe could never
 * run from source, and a resolution regression would only ever be caught by a
 * packaged run.
 *
 * Try the candidates and use the one that exists, so the same code works packaged,
 * in dev, and under test. Throws with every path it tried rather than letting the
 * Worker fail with a bare module error.
 */
function resolveProxyWorkerPath(): string {
  const candidates = [
    // Packaged: .vite/build -> app root
    path.resolve(__dirname, "..", "..", "worker", "proxy_server.js"),
    // From source (src/ipc/utils -> repo root)
    path.resolve(__dirname, "..", "..", "..", "worker", "proxy_server.js"),
    // Last resort: whatever the process considers its working directory.
    path.resolve(process.cwd(), "worker", "proxy_server.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `startProxy: could not locate worker/proxy_server.js. Tried:\n  ${candidates.join("\n  ")}`,
  );
}

export async function startProxy(
  targetOrigin: string,
  opts: {
    // host?: string;
    // port?: number;
    // env?: Record<string, string>;
    onStarted?: (proxyUrl: string) => void;
  } = {},
) {
  if (!/^https?:\/\//.test(targetOrigin))
    throw new Error("startProxy: targetOrigin must be absolute http/https URL");
  const port = await findAvailablePort(50_000, 60_000);
  logger.info("Found available port", port);
  const {
    // host = "localhost",
    // env = {}, // additional env vars to pass to the worker
    onStarted,
  } = opts;

  const worker = new Worker(
    resolveProxyWorkerPath(),
    {
      workerData: {
        targetOrigin,
        port,
      },
    },
  );

  worker.on("message", (m) => {
    logger.info("[proxy]", m);
    if (typeof m === "string" && m.startsWith("proxy-server-start url=")) {
      const url = m.substring("proxy-server-start url=".length);
      onStarted?.(url);
    }
  });
  worker.on("error", (e) => logger.error("[proxy] error:", e));
  worker.on("exit", (c) => logger.info("[proxy] exit", c));

  return worker; // let the caller keep a handle if desired
}
