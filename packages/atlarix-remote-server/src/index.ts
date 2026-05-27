/**
 * Atlarix remote server — version-locked headless bundle for SSH workspaces.
 * Bootstrap installs to ~/.atlarix-server/bin/<version-hash>/ on the remote host.
 */
import http from "node:http";

const PORT = Number(process.env.ATLARIX_REMOTE_PORT ?? 0);
const VERSION = process.env.ATLARIX_REMOTE_VERSION ?? "8.9.0";

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: VERSION }));
    return;
  }
  if (req.url === "/shutdown" && req.method === "POST") {
    res.writeHead(200);
    res.end("ok");
    server.close();
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT || 0, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : PORT;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event: "listening", port, version: VERSION }));
});
