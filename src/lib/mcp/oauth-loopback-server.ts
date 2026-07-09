import http from "node:http";

export type McpOAuthLoopbackCallback = {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
};

export type McpOAuthLoopbackServer = {
  redirectUrl: string;
  waitForCallback: () => Promise<McpOAuthLoopbackCallback>;
  close: () => void;
};

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Atlarix</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center;">
  <h1>Sign-in complete</h1>
  <p>You're connected. This tab will close automatically — return to Atlarix.</p>
  <script>setTimeout(function () { window.close(); }, 800);</script>
</body>
</html>`;

/**
 * Native OAuth clients must use http://127.0.0.1 loopback redirect URIs
 * (RFC 8252 / MCP OAuth). Custom schemes like atlarix:// are rejected at registration.
 */
export function createMcpOAuthLoopbackServer(): Promise<McpOAuthLoopbackServer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let callbackResolve: ((value: McpOAuthLoopbackCallback) => void) | null =
      null;
    let callbackReject: ((reason?: unknown) => void) | null = null;

    const server = http.createServer((req, res) => {
      try {
        const host = req.headers.host ?? "127.0.0.1";
        const url = new URL(req.url ?? "/", `http://${host}`);
        const payload: McpOAuthLoopbackCallback = {
          code: url.searchParams.get("code") ?? undefined,
          state: url.searchParams.get("state") ?? undefined,
          error: url.searchParams.get("error") ?? undefined,
          errorDescription:
            url.searchParams.get("error_description") ?? undefined,
        };

        // A21/L-6: ignore requests that aren't the OAuth callback (e.g. the
        // browser's automatic favicon.ico fetch) so they don't prematurely
        // resolve the callback with an empty payload. The real state/PKCE
        // validation still happens downstream in finishMcpOAuthCallback.
        if (!payload.code && !payload.state && !payload.error) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(SUCCESS_HTML);

        if (!settled && callbackResolve) {
          settled = true;
          callbackResolve(payload);
        }
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("OAuth callback error");
        }
        if (!settled && callbackReject) {
          settled = true;
          callbackReject(error);
        }
      }
    });

    server.on("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to bind MCP OAuth loopback server"));
        return;
      }

      const redirectUrl = `http://127.0.0.1:${address.port}/callback`;

      resolve({
        redirectUrl,
        waitForCallback: () =>
          new Promise<McpOAuthLoopbackCallback>((res, rej) => {
            callbackResolve = res;
            callbackReject = rej;
          }),
        close: () => {
          settled = true;
          server.close();
        },
      });
    });
  });
}
