/**
 * Sign the CLI in through the browser, on this machine.
 *
 * The CLI listens on 127.0.0.1 (a random port) for ONE sign-in, and opens
 * atlarix.dev/auth/app?client=cli&port=…&state=…. That page signs in (email and
 * password with Turnstile, or GitHub/Google) with a client that stores nothing,
 * then sends the browser to http://127.0.0.1:<port>/callback#<tokens>&state=….
 * A fragment never reaches a server, so /callback is a tiny page that POSTs
 * the fragment to /token; that is where the tokens are checked and kept.
 *
 * Guards: only the loopback address is bound; the Host header must be exactly
 * 127.0.0.1:<port> (a page on another site cannot reach it by DNS rebinding);
 * `state` is compared in constant time and is single-use; the listener closes
 * after one successful sign-in or on timeout.
 */
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export const SIGN_IN_PAGE = "https://atlarix.dev/auth/app";

export interface Tokens {
  access_token: string;
  refresh_token: string;
}

export interface BrowserSignInOptions {
  /** Opens the URL in the user's browser. Also shown, for a machine where it cannot. */
  openUrl: (url: string) => void;
  /** Store the session; resolve with the account's email, or throw to refuse it. */
  acceptSession: (t: Tokens) => Promise<string>;
  signInPage?: string;
  timeoutMs?: number;
}

const CALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>Atlarix CLI</title>
<body style="font-family:ui-monospace,monospace;background:#0a0a0a;color:#e5e5e5;padding:3rem">
<p id="m">Finishing sign-in…</p>
<script>
fetch("/token", { method: "POST", headers: { "content-type": "text/plain" }, body: location.hash.slice(1) })
  .then((r) => r.text())
  .then((t) => { document.getElementById("m").textContent = t; history.replaceState(null, "", "/callback"); })
  .catch(() => { document.getElementById("m").textContent = "Could not reach the Atlarix CLI. Start signing in again."; });
</script>`;

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Resolves with the signed-in email. `url` is announced through `openUrl`
 * before anything is awaited, so a caller can print it for copying.
 */
export async function signInWithBrowser(opts: BrowserSignInOptions): Promise<string> {
  const state = crypto.randomBytes(24).toString("base64url");
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  let settled = false;

  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const port = (server.address() as AddressInfo).port;
      if (req.headers.host !== `127.0.0.1:${port}`) {
        res.writeHead(403).end();
        return;
      }
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (req.method === "GET" && url.pathname === "/callback") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(CALLBACK_PAGE);
        return;
      }
      if (req.method === "POST" && url.pathname === "/token") {
        let body = "";
        req.on("data", (c: Buffer) => {
          body += c.toString("utf8");
          if (body.length > 16_384) req.destroy();
        });
        req.on("end", () => void onToken(body, res));
        return;
      }
      res.writeHead(404).end();
    });

    const finish = (err: Error | null, email?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve(email!);
    };

    const onToken = async (body: string, res: http.ServerResponse) => {
      const reply = (status: number, text: string) =>
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(text);
      if (settled) return reply(410, "This sign-in has already finished.");
      const p = new URLSearchParams(body);
      const error = p.get("error_description") ?? p.get("error");
      if (error) {
        reply(400, `Sign-in failed: ${error}`);
        return finish(new Error(`Sign-in failed: ${error}`));
      }
      if (!sameSecret(p.get("state") ?? "", state)) {
        // Not this sign-in: refuse, and keep waiting for the real one.
        return reply(400, "That sign-in link doesn't match the one the Atlarix CLI started.");
      }
      const access_token = p.get("access_token");
      const refresh_token = p.get("refresh_token");
      if (!access_token || !refresh_token) return reply(400, "The sign-in came back without a session.");
      try {
        const email = await opts.acceptSession({ access_token, refresh_token });
        reply(200, `Signed in as ${email}. You can close this tab and return to the terminal.`);
        finish(null, email);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        reply(400, msg);
        finish(e instanceof Error ? e : new Error(msg));
      }
    };

    const timer = setTimeout(
      () => finish(new Error("Sign-in timed out. Run `atlarix login` to try again.")),
      timeoutMs,
    );
    (timer as { unref?: () => void }).unref?.();

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const page = new URL(opts.signInPage ?? SIGN_IN_PAGE);
      page.searchParams.set("client", "cli");
      page.searchParams.set("port", String(port));
      page.searchParams.set("state", state);
      opts.openUrl(page.toString());
    });
    server.on("error", (e) => finish(e));
  });
}
