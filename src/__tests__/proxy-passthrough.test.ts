/**
 * `worker/proxy_server.js` end-to-end: a real upstream server, the real worker, a
 * real HTTP round-trip.
 *
 * The proxy used to buffer every HTML response and splice six `<script>` tags into
 * `<head>` (stacktrace.js, html-to-image, and four injected client scripts). That
 * apparatus was dead — nothing in `src/` had listened for the messages those
 * scripts post since the preview surface was removed in v14.15.0 — and two of the
 * libraries were never declared dependencies, so it logged ENOENT on every start
 * and put a `console.error` into every proxied page.
 *
 * Removing it changed the request path from "buffer, rewrite, re-header" to a
 * straight pipe, which is worth testing directly: the `proxy-worker` self-test
 * probe resolves the worker via `__dirname/../../worker` and therefore only runs in
 * a PACKAGED build (see start_proxy_server.ts:30), so from source it cannot cover
 * this. Here we load the worker by absolute path instead.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import path from "node:path";
import { Worker } from "node:worker_threads";

const WORKER_PATH = path.resolve(process.cwd(), "worker", "proxy_server.js");

let upstream: http.Server | null = null;
let worker: Worker | null = null;

afterEach(async () => {
  await worker?.terminate();
  worker = null;
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = null;
});

/** Start an upstream server; resolves with its origin. */
function startUpstream(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    upstream = http.createServer(handler);
    upstream.listen(0, "127.0.0.1", () => {
      const addr = upstream!.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** Start the proxy worker against `targetOrigin`; resolves with the proxy's URL. */
function startProxyWorker(targetOrigin: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    worker = new Worker(WORKER_PATH, { workerData: { targetOrigin, port } });
    const timer = setTimeout(() => reject(new Error("proxy worker never announced start")), 15_000);
    worker.on("message", (m) => {
      if (typeof m === "string" && m.startsWith("proxy-server-start url=")) {
        clearTimeout(timer);
        resolve(m.slice("proxy-server-start url=".length));
      }
    });
    worker.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function get(url: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      })
      .on("error", reject);
  });
}

// Ports are picked high and per-test to avoid collisions in a parallel suite.
let nextPort = 39_871;

describe("proxy_server pass-through", () => {
  it("forwards HTML byte-for-byte, with NO injected scripts", async () => {
    const html = "<html><head><title>t</title></head><body>hello</body></html>";
    const origin = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    });
    const proxyUrl = await startProxyWorker(origin, nextPort++);

    const got = await get(proxyUrl + "/");
    expect(got.status).toBe(200);
    // The whole point: identical bytes. Any injection would fail this.
    expect(got.body).toBe(html);
    expect(got.body).not.toContain("<script>");
    expect(got.body).not.toContain("proxy-worker");
  }, 30_000);

  it("passes the request path and query through", async () => {
    const origin = await startUpstream((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`saw:${req.url}`);
    });
    const proxyUrl = await startProxyWorker(origin, nextPort++);

    const got = await get(proxyUrl + "/deep/path?a=1&b=2");
    expect(got.body).toBe("saw:/deep/path?a=1&b=2");
  }, 30_000);

  it("forwards non-HTML content untouched", async () => {
    const js = "export const x = 1;\n";
    const origin = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(js);
    });
    const proxyUrl = await startProxyWorker(origin, nextPort++);

    const got = await get(proxyUrl + "/main.js");
    expect(got.body).toBe(js);
  }, 30_000);

  it("no longer strips accept-encoding (it only did so to enable rewriting)", async () => {
    // Stripping accept-encoding forced upstream to send uncompressed bodies purely
    // so they could be rewritten. With injection gone that cost is unnecessary, so
    // the client's header must reach upstream intact.
    let seen: string | undefined;
    const origin = await startUpstream((req, res) => {
      seen = req.headers["accept-encoding"] as string | undefined;
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head></head></html>");
    });
    const proxyUrl = await startProxyWorker(origin, nextPort++);

    await new Promise<void>((resolve, reject) => {
      http
        .get(proxyUrl + "/", { headers: { "accept-encoding": "gzip" } }, (res) => {
          res.resume();
          res.on("end", () => resolve());
        })
        .on("error", reject);
    });
    expect(seen).toBe("gzip");
  }, 30_000);

  it("reports a clear error when no upstream is configured", async () => {
    const proxyUrl = await startProxyWorker("", nextPort++);
    const got = await get(proxyUrl + "/");
    expect(got.status).toBe(400);
    expect(got.body).toContain("No upstream configured");
  }, 30_000);
});
