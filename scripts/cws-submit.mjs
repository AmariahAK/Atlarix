#!/usr/bin/env node
/**
 * Upload and publish the Chrome extension via the Chrome Web Store API.
 *
 * The sibling of `scripts/store-submit.mjs`, which does the same job for the
 * Microsoft Store, and it borrows that script's discipline: three secrets, no
 * SDK, and a failure here must never be allowed to block a release (the
 * `continue-on-error: true` lives in the workflow, not in this file — this
 * script exits non-zero and says why).
 *
 * ══ PUBLISH IS A SUBMIT, NOT A DEPLOY ══
 *
 * Unlike Railway or Vercel, `publish` hands the package to a HUMAN REVIEW
 * QUEUE. Nothing reaches a user when this script exits 0; it reaches a
 * reviewer. v1.0.0 was rejected once already — "Spam and Placement in the
 * Store", for a description line naming six file formats — so a green run here
 * is the beginning of the wait, not the end of it.
 *
 * ══ THE TRAP THAT SHAPES THIS WHOLE FILE: HTTP 200 MEANS NOTHING ══
 *
 * BOTH endpoints answer **200 OK with a failure in the body**.
 *
 *   - Upload   → `{"uploadState": "FAILURE", "itemError": [...]}`
 *   - Publish  → `{"status": ["NOT_AUTHORIZED"], "statusDetail": [...]}`
 *
 * So `res.ok` is not a success check here, it is a transport check. A script
 * that trusts the status code reports a green publish for a package the Store
 * rejected, and the first anyone learns of it is a user asking why the
 * extension never updated. Every response below is judged on its BODY.
 * `assertUploadOk` and `assertPublishOk` exist to make that impossible to
 * forget when someone adds a third call.
 *
 * ══ WHAT THE API CANNOT DO ══
 *
 * The description, the screenshots and the privacy justifications are NOT
 * settable through this API. Only the package. That is fine — they change
 * rarely — but it does mean automation would not have caught the rejection
 * above, and that a permission added to `manifest.json` still needs a manual
 * trip to the dashboard to write its justification.
 *
 * ══ YOU CANNOT UPLOAD WHILE A VERSION IS IN REVIEW ══
 *
 * The draft is locked. The Store reports it as `uploadState: FAILURE` with an
 * `itemError` saying so, which this script surfaces verbatim rather than
 * paraphrasing — the Store's own wording is the thing worth reading.
 *
 * Usage:
 *   node scripts/cws-submit.mjs --check
 *       Prove the credentials work: refresh the token, GET the item. Writes
 *       nothing. This is what the keepalive cron runs.
 *
 *   node scripts/cws-submit.mjs --zip <path> --no-publish
 *       Upload a new draft package and stop. Nothing enters review.
 *
 *   node scripts/cws-submit.mjs --zip <path> --target trustedTesters
 *       Upload and publish to trusted testers — no public review queue.
 *
 *   node scripts/cws-submit.mjs --zip <path> --deploy-percentage 10
 *       Upload and publish publicly to 10% of users. Staged rollout.
 *
 * Environment:
 *   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN   (required)
 *   CWS_ITEM_ID                                           (optional override)
 */

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/chromewebstore/v1.1";
const UPLOAD_API = "https://www.googleapis.com/upload/chromewebstore/v1.1";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    fail(`--${name} needs a value`);
  }
  return v;
}
const has = (name) => process.argv.includes(`--${name}`);

/**
 * THROWS rather than calling `process.exit`, and that is what makes the two
 * body-assertions below testable at all.
 *
 * An `exit(1)` inside an assertion cannot be asserted on — a test that provokes
 * it kills the test runner instead of failing the case, so the usual outcome is
 * that nobody writes the test and the guard ships unexercised. This project has
 * shipped two guards that went green against broken input; these two are the
 * ones that decide whether a rejected upload is reported as a success, so they
 * get a test that watches them throw. The single exit lives at the bottom.
 */
function fail(message) {
  throw new Error(message);
}

function env(name) {
  const v = process.env[name]?.trim();
  if (!v) fail(`Missing required environment variable: ${name}`);
  return v;
}

// ---------------------------------------------------------------------------
// The item id — DERIVED, then cross-checked
// ---------------------------------------------------------------------------

/**
 * The extension id, computed from `manifest.key` rather than typed.
 *
 * `sha256(DER)` truncated to 16 bytes, each nibble mapped `0-f` → `a-p`. This
 * is the same derivation `packages/extension/src/auth/redirect.test.ts` runs,
 * and deriving it here is a safety property, not a flourish: if the key in the
 * manifest were ever wrong, the id computed from it is wrong too, and the API
 * answers 404 on an item nobody owns — instead of this script cheerfully
 * publishing a package to whichever item id someone hand-typed.
 *
 * A one-character transcription error in that key has already happened once on
 * this project. It still decoded as valid base64 and still produced a 294-byte
 * DER; only the derived id disagreed.
 */
export function deriveItemId() {
  const manifest = JSON.parse(
    readFileSync(resolve(ROOT, "packages/extension/manifest.json"), "utf8"),
  );
  if (typeof manifest.key !== "string" || manifest.key === "") {
    fail("packages/extension/manifest.json has no `key`, so no id can be derived.");
  }
  const der = Buffer.from(manifest.key, "base64");
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  const derived = [...hex]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("");

  // And pin it against the constant the EXTENSION uses, so the publish target
  // and the OAuth redirect can never drift apart. They are the same identity
  // expressed twice; a mismatch means one of them is about a different item.
  const src = readFileSync(
    resolve(ROOT, "packages/extension/src/auth/redirect.ts"),
    "utf8",
  );
  const pinned = /ATLARIX_EXTENSION_ID\s*=\s*"([a-p]{32})"/.exec(src)?.[1];
  if (!pinned) {
    fail("Could not read ATLARIX_EXTENSION_ID from src/auth/redirect.ts.");
  }
  if (pinned !== derived) {
    fail(
      `Item id mismatch: manifest.key derives ${derived}, but ` +
        `redirect.ts pins ${pinned}. One of them is about a different item — ` +
        `refusing to publish until they agree.`,
    );
  }
  return derived;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Exchange the refresh token for an access token.
 *
 * TWO EXPIRIES LIVE BEHIND THIS CALL, and both present identically — a 400 with
 * `invalid_grant`, on a pipeline whose diff explains nothing:
 *
 *   1. An External+Testing consent screen issues refresh tokens that die after
 *      SEVEN DAYS. `atlarix-cws` is **Internal** under the atlarix.dev Workspace
 *      org, so this one does not apply. Do not change that setting.
 *   2. A refresh token Google has not seen used for SIX MONTHS is revoked. This
 *      one DOES still apply, and it is what `.github/workflows/cws-keepalive.yml`
 *      exists to prevent — it runs `--check` monthly so the token is never idle
 *      long enough to be collected.
 *
 * Recovery for either: re-run `node scripts/cws-auth.mjs` and reset the secrets.
 */
async function accessToken() {
  const res = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("CWS_CLIENT_ID"),
      client_secret: env("CWS_CLIENT_SECRET"),
      refresh_token: env("CWS_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const hint =
      body.error === "invalid_grant"
        ? " — the refresh token is dead. Six months unused, or it was revoked. " +
          "Re-run `node scripts/cws-auth.mjs` and reset CWS_REFRESH_TOKEN."
        : "";
    fail(`Token refresh failed (${res.status}): ${JSON.stringify(body)}${hint}`);
  }
  return body.access_token;
}

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  "x-goog-api-version": "2",
});

// ---------------------------------------------------------------------------
// The two calls, each judged on its BODY
// ---------------------------------------------------------------------------

/** Read the item. Used by `--check`, and to name the version being replaced. */
async function getItem(token, itemId) {
  const res = await fetch(`${API}/items/${itemId}?projection=DRAFT`, {
    headers: authHeaders(token),
  });
  const text = await res.text();
  if (!res.ok) {
    fail(`GET item ${itemId} → ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

/**
 * `uploadState` is the verdict. The HTTP status is not.
 *
 * `IN_PROGRESS` is not success either — it means the Store accepted the bytes
 * and has not finished with them, so treating it as done would publish against
 * a package that may yet be rejected.
 */
export function assertUploadOk(body) {
  const state = body?.uploadState;
  if (state === "SUCCESS") return;
  const errors = (body?.itemError ?? [])
    .map((e) => `  ${e.error_code ?? "?"}: ${e.error_detail ?? JSON.stringify(e)}`)
    .join("\n");
  fail(
    `Upload did not succeed — uploadState: ${state ?? "(absent)"}\n` +
      (errors || `  ${JSON.stringify(body)}`),
  );
}

/** Same rule for publish: `status` is an ARRAY, and "OK" must be in it. */
export function assertPublishOk(body) {
  const status = Array.isArray(body?.status) ? body.status : [];
  if (status.includes("OK")) return;
  const detail = (body?.statusDetail ?? []).map((d) => `  ${d}`).join("\n");
  fail(
    `Publish did not succeed — status: ${status.length ? status.join(", ") : "(absent)"}\n` +
      (detail || `  ${JSON.stringify(body)}`),
  );
}

async function uploadPackage(token, itemId, zipPath) {
  const bytes = readFileSync(zipPath);
  console.log(
    `Uploading ${zipPath} (${(bytes.length / 1e6).toFixed(2)} MB) to item ${itemId}...`,
  );
  const res = await fetch(
    `${UPLOAD_API}/items/${itemId}?uploadType=media`,
    {
      method: "PUT",
      headers: { ...authHeaders(token), "content-type": "application/zip" },
      body: bytes,
    },
  );
  const text = await res.text();
  if (!res.ok) fail(`Upload transport failed (${res.status}): ${text}`);
  const body = JSON.parse(text);
  assertUploadOk(body);
  console.log("Upload accepted (uploadState: SUCCESS).");
  return body;
}

/**
 * Publish.
 *
 * `publishTarget` is a QUERY parameter; `deployPercentage` goes in the BODY.
 * They are not interchangeable, and a `deployPercentage` sent as a query
 * parameter is silently ignored — a staged rollout that quietly went to
 * everyone, which is the exact failure a staged rollout exists to avoid.
 *
 * A partial rollout only makes sense against the default (public) target;
 * trusted testers are already a fixed, small audience.
 */
async function publish(token, itemId, { target, deployPercentage }) {
  const url = new URL(`${API}/items/${itemId}/publish`);
  url.searchParams.set("publishTarget", target);

  const payload = {};
  if (deployPercentage !== undefined) {
    payload.deployPercentage = deployPercentage;
  }

  console.log(
    `Publishing to ${target}` +
      (deployPercentage !== undefined ? ` at ${deployPercentage}%` : "") +
      "...",
  );
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(token), "content-type": "application/json" },
    // A zero-length body on this endpoint has been observed to 400; an explicit
    // `{}` is always valid and costs nothing.
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) fail(`Publish transport failed (${res.status}): ${text}`);
  const body = JSON.parse(text);
  assertPublishOk(body);
  return body;
}

// ---------------------------------------------------------------------------

async function main() {
  const itemId = process.env.CWS_ITEM_ID?.trim() || deriveItemId();
  const token = await accessToken();

  if (has("check")) {
    const item = await getItem(token, itemId);
    console.log(`Credentials OK. Item ${item.id} reachable (kind: ${item.kind}).`);
    // The keepalive's whole purpose is that this request HAPPENED. Say so, so a
    // reader of the log can tell a real check from a cached no-op.
    console.log(`Refresh token exercised at ${new Date().toISOString()}.`);
    return;
  }

  const zipPath = arg("zip") ?? process.env.CWS_ZIP_PATH;
  if (!zipPath) fail("--zip <path> is required (or set CWS_ZIP_PATH).");
  const resolved = resolve(zipPath);
  try {
    statSync(resolved);
  } catch {
    fail(`No such file: ${resolved}`);
  }

  const target = arg("target", "default");
  if (target !== "default" && target !== "trustedTesters") {
    fail(`--target must be "default" or "trustedTesters" (got "${target}").`);
  }

  let deployPercentage;
  const pctRaw = arg("deploy-percentage");
  if (pctRaw !== undefined) {
    const pct = Number(pctRaw);
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
      fail(`--deploy-percentage must be an integer 1-100 (got "${pctRaw}").`);
    }
    if (target !== "default") {
      fail(
        "--deploy-percentage only applies to the default (public) target; " +
          "trusted testers are already a fixed audience.",
      );
    }
    deployPercentage = pct;
  }

  await uploadPackage(token, itemId, resolved);

  if (has("no-publish")) {
    console.log(
      "Draft updated; --no-publish given, so nothing entered review. " +
        "Publish later from the dashboard or re-run without --no-publish.",
    );
    return;
  }

  await publish(token, itemId, { target, deployPercentage });

  // Deliberately not "published". It is queued for a human.
  console.log(
    `Submitted for review (target: ${target}` +
      (deployPercentage !== undefined ? `, ${deployPercentage}%` : "") +
      "). This enters a REVIEW QUEUE — nothing reaches users until it clears.",
  );
  console.log(
    `Track: https://chrome.google.com/webstore/devconsole/.../` + itemId,
  );
}

// Only when RUN, never when imported. The guard tests import this module for
// `assertUploadOk` / `assertPublishOk`, and a bare `main()` at module scope
// would fire a real Store request the moment the suite loaded the file.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[cws-submit] ${err?.message ?? err}`);
    process.exit(1);
  });
}
