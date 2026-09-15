#!/usr/bin/env node
/**
 * Mint the Chrome Web Store refresh token, once, on this machine.
 *
 * `scripts/cws-submit.mjs` runs in CI with three secrets — CWS_CLIENT_ID,
 * CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN — exactly like the Azure trio behind
 * `store-submit.mjs`. The first two come out of the OAuth client's downloaded
 * JSON. The third cannot: a refresh token is only ever issued to a human who
 * clicked through a consent screen, so it is minted here and then lives in
 * GitHub secrets forever.
 *
 * WHY THE LOOPBACK AND NOT A PASTED CODE. Google's "Desktop app" client type
 * declares `http://localhost` as its redirect, and RFC 8252 lets an installed
 * app bind ANY port on the loopback interface. The alternative — the
 * out-of-band `urn:ietf:wg:oauth:2.0:oob` flow where the user copies a code
 * out of a web page — was shut off by Google in 2022 and returns
 * `invalid_request`. So the server here is not a convenience; it is the only
 * remaining path for this client type.
 *
 * THE TOKEN IS NEVER PRINTED. It is written into the credentials file beside
 * the client secret, mode 600. A refresh token echoed to a terminal lands in
 * scrollback, in tmux history and in any transcript of the session, and unlike
 * an access token it does not expire on its own.
 *
 * TWO EXPIRIES, AND ONLY ONE OF THEM IS SOLVED. An OAuth consent screen set to
 * External + Testing issues refresh tokens that die after SEVEN DAYS, unless
 * the only scopes are a subset of name/email/profile — and the Chrome Web Store
 * scope is not in that subset. `atlarix-cws` is set to **Internal** under the
 * atlarix.dev Workspace org, which has no such limit. What survives that
 * setting is the other rule: a refresh token Google has not seen used for SIX
 * MONTHS is revoked. A slow release cadence can reach six months, and the
 * symptom is a pipeline that 401s with nothing in the diff to explain it.
 */

import { createServer } from "node:http";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const CREDS =
  process.env.CWS_CREDENTIALS_FILE ??
  join(homedir(), ".config", "atlarix", "cws-oauth-client.json");

const SCOPE = "https://www.googleapis.com/auth/chromewebstore";

/**
 * PKCE, even though this client has a secret.
 *
 * A "Desktop app" client secret is not a secret in any meaningful sense — it
 * ships inside whatever binary uses it — so Google treats these clients as
 * public and recommends PKCE regardless. It costs four lines and closes the
 * authorization-code interception window on a shared machine, where another
 * local process could otherwise race us to the loopback port.
 */
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function open(url) {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
}

/**
 * Serve exactly one request, and hand back the code.
 *
 * The `state` check is not ceremony: without it any page the user has open can
 * navigate them to our loopback port with a code the attacker obtained, and we
 * would happily exchange it and store a refresh token for the attacker's
 * account. It is compared before the code is read.
 */
function waitForCode(port, state) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const done = (status, body) => {
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
        res.end(body);
        server.close();
      };
      const err = url.searchParams.get("error");
      if (err) {
        done(400, `Authorization failed: ${err}. You can close this tab.`);
        reject(new Error(`authorization denied: ${err}`));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        // Deliberately vague to the browser, loud to the operator.
        done(400, "State mismatch. You can close this tab.");
        reject(new Error("state mismatch — the response did not come from the request we made"));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        done(400, "No code in the response. You can close this tab.");
        reject(new Error("no code in redirect"));
        return;
      }
      done(200, "Atlarix: Chrome Web Store authorization complete. You can close this tab.");
      resolve(code);
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1");
  });
}

async function main() {
  let creds;
  try {
    creds = JSON.parse(await readFile(CREDS, "utf8"));
  } catch (e) {
    console.error(
      `Could not read ${CREDS}: ${e.message}\n` +
        `Download the OAuth client JSON from Google Cloud console → ` +
        `Google Auth Platform → Clients → atlarix-cws-ci, and save it there.`,
    );
    process.exit(1);
  }
  const app = creds.installed ?? creds.web;
  if (!app?.client_id || !app?.client_secret) {
    console.error(`${CREDS} has no installed/web client with an id and secret.`);
    process.exit(1);
  }

  // Port 0 lets the OS pick; we only learn the real one after `listen`, and the
  // redirect URI has to carry it, so bind first and build the URL second.
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));

  const redirectUri = `http://127.0.0.1:${port}`;
  const state = randomBytes(16).toString("base64url");
  const { verifier, challenge } = pkce();

  const authUrl = new URL(app.auth_uri ?? "https://accounts.google.com/o/oauth2/auth");
  authUrl.search = new URLSearchParams({
    client_id: app.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    // `offline` is what asks for a refresh token at all, and `consent` is what
    // makes Google re-issue one. Without `prompt=consent` a second run on an
    // already-authorized account returns an access token and NO refresh token,
    // which reads as a silent failure — the script would look like it worked.
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const pending = waitForCode(port, state);
  console.log(`Sign in as the account that owns the Web Store item.`);
  console.log(`AUTH_URL ${authUrl}`);
  // CWS_NO_OPEN exists so the URL can be driven in a browser we have already
  // chosen. Letting `open` fire as well would start a SECOND flow in the
  // default browser, and whichever one reaches the loopback first closes the
  // server — so the other fails with a connection error that looks like a bug.
  if (!process.env.CWS_NO_OPEN) open(authUrl.toString());

  const code = await pending;

  const res = await fetch(app.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: app.client_id,
      client_secret: app.client_secret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error(`Token exchange failed (${res.status}): ${JSON.stringify(body)}`);
    process.exit(1);
  }
  if (!body.refresh_token) {
    // The specific, recoverable case: Google withheld it because this account
    // had already granted the scope and `prompt=consent` did not take.
    console.error(
      `Google returned an access token but NO refresh token. Revoke this app at ` +
        `https://myaccount.google.com/permissions and run this again.`,
    );
    process.exit(1);
  }

  creds.refresh_token = body.refresh_token;
  creds.refresh_token_minted = new Date().toISOString();
  await writeFile(CREDS, `${JSON.stringify(creds, null, 2)}\n`, "utf8");
  await chmod(CREDS, 0o600);

  console.log(`\nRefresh token written to ${CREDS} (not printed).`);
  console.log(`Set the three GitHub secrets from that file:\n`);
  console.log(`  gh secret set CWS_CLIENT_ID     --repo AmariahAK/Atlarix --body "$(jq -r '.installed.client_id' ${CREDS})"`);
  console.log(`  gh secret set CWS_CLIENT_SECRET --repo AmariahAK/Atlarix --body "$(jq -r '.installed.client_secret' ${CREDS})"`);
  console.log(`  gh secret set CWS_REFRESH_TOKEN --repo AmariahAK/Atlarix --body "$(jq -r '.refresh_token' ${CREDS})"`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
