/**
 * proxy.js – zero-dependency worker-based HTTP/WS forwarder
 */

const { parentPort, workerData } = require("worker_threads");

const http = require("http");
const https = require("https");

const { URL } = require("url");
// `fs` and `path` were only needed to read the injected client scripts off disk.

/* ──────────────────────────── worker code ─────────────────────────────── */
const LISTEN_HOST = "localhost";
const LISTEN_PORT = workerData.port;
let rememberedOrigin = null; // e.g. "http://localhost:5173"

/* ---------- pre-configure rememberedOrigin from workerData ------- */
{
  const fixed = workerData?.targetOrigin;
  if (fixed) {
    try {
      rememberedOrigin = new URL(fixed).origin;
      parentPort?.postMessage(
        `[proxy-worker] fixed upstream: ${rememberedOrigin}`,
      );
    } catch {
      throw new Error(
        `Invalid target origin "${fixed}". Must be absolute http/https URL.`,
      );
    }
  }
}

/* ---------------------- HTML injection: REMOVED -------------------------
 * This proxy used to inject stacktrace.js, html-to-image, and four `dyad-*.js`
 * client scripts (error shim, component selector, screenshot, visual editor) into
 * every proxied HTML response.
 *
 * All of it was dead. Those scripts communicate by posting message types
 * (`window-error`, `build-error-report`, `dyad-component-selected`,
 * `dyad-screenshot-response`, `dyad-text-updated`, …) and NOTHING in `src/` has
 * listened for any of them since the preview surface was removed in v14.15.0 and
 * the app unified on the Browser tab.
 *
 * Worse, it was noisy dead code: `html-to-image` and `stacktrace-js` are not
 * declared dependencies, so every proxy start logged two ENOENT failures and every
 * proxied page got a `console.error` telling the user a library had not loaded.
 *
 * What this proxy still does IS used: it proxies the user's dev-server URL and
 * announces it as `[atlarix-preview-proxy]started=[…]`, which `useRunApp.ts`
 * consumes. That behaviour is untouched.
 * --------------------------------------------------------------------- */

/* ---------------- helper: build upstream URL from request -------------- */
function buildTargetURL(clientReq) {
  if (!rememberedOrigin) throw new Error("No upstream configured.");

  // Forward to the remembered origin keeping path & query
  return new URL(clientReq.url, rememberedOrigin);
}

/* ----------------------------------------------------------------------- */
/* 1. Plain HTTP request / response                                        */
/* ----------------------------------------------------------------------- */

const server = http.createServer((clientReq, clientRes) => {
  let target;
  try {
    target = buildTargetURL(clientReq);
  } catch (err) {
    clientRes.writeHead(400, { "content-type": "text/plain" });
    return void clientRes.end("Bad request: " + err.message);
  }

  const isTLS = target.protocol === "https:";
  const lib = isTLS ? https : http;

  /* Copy request headers but rewrite Host / Origin / Referer */
  const headers = { ...clientReq.headers, host: target.host };
  if (headers.origin) headers.origin = target.origin;
  if (headers.referer) {
    try {
      const ref = new URL(headers.referer);
      headers.referer = target.origin + ref.pathname + ref.search;
    } catch {
      delete headers.referer;
    }
  }
  // NOTE: we used to strip `accept-encoding` and `if-none-match` for HTML routes so
  // the body arrived uncompressed and uncached and could be rewritten. With script
  // injection gone there is nothing to rewrite, so compression and conditional
  // requests are now passed through — the proxy is a plain pass-through again.

  const upOpts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isTLS ? 443 : 80),
    path: target.pathname + target.search,
    method: clientReq.method,
    headers,
  };

  // Straight pass-through: stream upstream's response untouched. Previously the
  // whole HTML body was buffered so scripts could be spliced into <head>; that
  // apparatus is gone (see the note above), so nothing needs the full body.
  const upReq = lib.request(upOpts, (upRes) => {
    clientRes.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(clientRes);
  });

  clientReq.pipe(upReq);
  upReq.on("error", (e) => {
    clientRes.writeHead(502, { "content-type": "text/plain" });
    clientRes.end("Upstream error: " + e.message);
  });
});

/* ----------------------------------------------------------------------- */
/* 2. WebSocket / generic Upgrade tunnelling                               */
/* ----------------------------------------------------------------------- */

server.on("upgrade", (req, socket, _head) => {
  let target;
  try {
    target = buildTargetURL(req);
  } catch (err) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n" + err.message);
    return socket.destroy();
  }

  const isTLS = target.protocol === "https:";
  const headers = { ...req.headers, host: target.host };
  if (headers.origin) headers.origin = target.origin;

  const upReq = (isTLS ? https : http).request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isTLS ? 443 : 80),
    path: target.pathname + target.search,
    method: "GET",
    headers,
  });

  upReq.on("upgrade", (upRes, upSocket, upHead) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        Object.entries(upRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (upHead && upHead.length) socket.write(upHead);

    upSocket.pipe(socket).pipe(upSocket);
  });

  upReq.on("error", () => socket.destroy());
  upReq.end();
});

/* ----------------------------------------------------------------------- */

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  parentPort?.postMessage(
    `proxy-server-start url=http://${LISTEN_HOST}:${LISTEN_PORT}`,
  );
});
