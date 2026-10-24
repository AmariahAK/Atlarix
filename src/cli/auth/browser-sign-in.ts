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
import { rixSvg } from "@/lib/rix/rix-svg";
import type { BrowserProvider } from "./sign-in-choices";

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
  /** Where the user goes back to, for the browser's page: "the terminal" (default), "your editor". */
  returnTo?: string;
  /** The way in the person already chose; the page starts it instead of asking again. */
  provider?: BrowserProvider;
}

/**
 * The page the browser lands on: Rix, then what happened, in Atlarix's own
 * colours. It said one plain line ("Signed in as … return to the terminal"),
 * the terminal even when the editor asked (owner). `returnTo` names where to go.
 */
export function callbackPage(returnTo: string): string {
  const rix = rixSvg({ state: "working", size: "120px", label: "", id: "rix", detail: "mid" });
  const where = returnTo.replace(/[<>&"]/g, "");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atlarix · Signing in</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0e0d; color: #cfe8dd;
    font: 15px/1.5 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { width: min(440px, calc(100vw - 32px)); padding: 32px 28px 26px; text-align: center; background: #111715;
    border: 1px solid #35413b; border-radius: 16px; box-shadow: 0 0 60px rgba(61, 220, 151, 0.08); }
  .rix { display: block; margin: 0 auto 10px; }
  h1 { margin: 0 0 6px; font-size: 20px; font-weight: 650; color: #e8f5ee; display: flex; align-items: center; justify-content: center; gap: 8px; }
  .who { margin: 0 0 14px; color: #7dbbe8; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 14px; word-break: break-all; }
  .next { margin: 0; color: #7c948a; font-size: 14px; }
  .mark { display: inline-flex; width: 22px; height: 22px; border-radius: 999px; align-items: center; justify-content: center;
    flex: none; font-size: 13px; font-weight: 700; }
  .ok .mark { background: #12271e; color: #3ddc97; border: 1px solid #1f5a42; }
  .bad h1 { color: #f07c7c; }
  .bad .mark { background: #2a1618; color: #f07c7c; border: 1px solid #5a2c2e; }
  .foot { margin-top: 22px; padding-top: 14px; border-top: 1px solid #26302c; color: #6b8077; font-size: 12px; }
  .foot b { color: #3ddc97; font-weight: 600; }
</style>
<main class="card" id="card">
  ${rix}
  <h1 id="h">Finishing sign-in…</h1>
  <p class="who" id="who"></p>
  <p class="next" id="next">One moment.</p>
  <div class="foot"><b>Atlarix</b> · this page talks only to Atlarix on this computer (127.0.0.1)</div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const done = (ok, title, who, next) => {
  $("card").className = "card " + (ok ? "ok" : "bad");
  $("h").innerHTML = '<span class="mark">' + (ok ? "&#10003;" : "!") + "</span>";
  $("h").append(title);
  $("who").textContent = who || "";
  $("next").textContent = next;
  const r = document.querySelector(".rix");
  if (r) r.setAttribute("class", "rix " + (ok ? "found" : "rest"));
};
fetch("/token", { method: "POST", headers: { "content-type": "text/plain" }, body: location.hash.slice(1) })
  .then(async (r) => {
    const t = await r.text();
    history.replaceState(null, "", "/callback");
    const m = /^Signed in as (.+)$/.exec(t);
    if (r.ok && m) done(true, "You're signed in", m[1], "Go back to ${where}. You can close this tab.");
    else done(false, "Sign-in didn't finish", "", t);
  })
  .catch(() => done(false, "Couldn't reach Atlarix", "", "Atlarix stopped waiting on this computer. Start signing in again from ${where}."));
</script></html>`;
}

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
        res.end(callbackPage(opts.returnTo ?? "the terminal"));
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
        // The page reads this exact form (callbackPage).
        reply(200, `Signed in as ${email}`);
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
      if (opts.provider) page.searchParams.set("provider", opts.provider);
      opts.openUrl(page.toString());
    });
    server.on("error", (e) => finish(e));
  });
}
