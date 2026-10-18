#!/usr/bin/env node
/**
 * Submit an MSIX package to the Microsoft Store via the Submission API v1.
 *
 * Called by msix.yml on release tags (workflow_call). Manual runs
 * (workflow_dispatch) skip this step — a test build should never submit.
 *
 * Flow:
 *  1. Authenticate via Azure AD client credentials
 *  2. If a submission is pending, replace it — including one still in
 *     certification (owner, 2026-10-18: waiting meant a new release never
 *     reached the Store in time). Only one Microsoft is in the middle of
 *     committing or publishing is waited for, since Microsoft refuses to delete
 *     those (409); if it is still there after the wait, this release skips the Store
 *  3. Create a new submission (clones the published one — all listing info,
 *     screenshots, age rating, etc. carry forward automatically). A deleted
 *     submission can never be reused, so it is always a new one
 *  4. Mark old packages PendingDelete, add the new .msixupload as PendingUpload
 *  5. Upload a ZIP containing the package to the returned SAS URL
 *  6. Commit → triggers Microsoft certification, then wait for the commit to
 *     leave CommitStarted so CI says whether it actually went through
 *
 * API calls retry a 429, and a 5xx except on a POST (Retry-After, else backoff), 5 tries.
 *
 * `--status`: read-only. Prints the pending and last published submissions,
 * their status details and certification notes, then exits. Needs no package.
 *
 * Required environment variables:
 *   AZURE_AD_TENANT_ID
 *   AZURE_AD_CLIENT_ID
 *   AZURE_AD_CLIENT_SECRET
 *   STORE_APP_ID           — Partner Center product ID (e.g. 9P3RR11DVZPW)
 *   MSIXUPLOAD_PATH        — absolute path to the .msixupload file
 */

import { execSync } from "node:child_process";
import { readFileSync, statSync, mkdtempSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const API = "https://manage.devcenter.microsoft.com/v1.0/my";

function env(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

// Statuses of a pending submission this release replaces. That includes one in
// certification: the owner chose the newest release over letting a certification
// finish (2026-10-18), which reverses 339ccb91 on purpose — back-to-back releases
// can keep restarting certification, and the newest one is still what Store users
// should get. Not here, so waited for: CommitStarted, PendingPublication and
// Publishing (Microsoft answers 409 to a delete mid-operation, and a publishing
// one reaches users within hours anyway), and any status this list doesn't know.
const REPLACEABLE = new Set([
  "PendingCommit",
  "CommitFailed",
  "PreProcessing",
  "PreProcessingFailed",
  "Certification",
  "CertificationFailed",
  "Release",
  "ReleaseFailed",
  "PublishFailed",
  "Canceled",
]);

/** @returns {"wait" | "replace"} */
export function pendingSubmissionAction(status) {
  return REPLACEABLE.has(status) ? "replace" : "wait";
}

/**
 * Whether a failed call is worth another try: rate limited, or Microsoft's side.
 * A POST (create, commit) retries only a 429, which means it was not processed:
 * a 5xx may have created the submission anyway, and a second create would collide.
 */
export function isRetryable(method, status) {
  return status === 429 || (method !== "POST" && status >= 500);
}

/** Milliseconds before try `attempt` (1-based): Retry-After when given, else 2s, 4s, 8s… capped at 60s. */
export function retryDelayMs(attempt, retryAfter) {
  const seconds = retryAfter == null || retryAfter === "" ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 120) * 1000;
  return Math.min(2 ** attempt * 1000, 60_000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_TRIES = 5;
const WAIT_MS = 10 * 60_000;
const POLL_MS = 30_000;

async function getToken(TENANT_ID, CLIENT_ID, CLIENT_SECRET) {
  const res = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: "https://manage.devcenter.microsoft.com/.default",
      }),
    },
  );
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(
      `Token request failed: ${data.error_description || JSON.stringify(data)}`,
    );
  }
  return data.access_token;
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** One Submission API call, retried on 429/5xx. Exported for tests (`fetchImpl`). */
export async function api(token, method, path, body, { fetchImpl = fetch, wait = sleep } = {}) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  for (let attempt = 1; ; attempt++) {
    const res = await fetchImpl(`${API}/${path}`, opts);
    if (method === "DELETE" && res.status === 204) return null;
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    if (isRetryable(method, res.status) && attempt < MAX_TRIES) {
      const ms = retryDelayMs(attempt, res.headers.get("retry-after"));
      console.log(`${method} ${path} → ${res.status}; trying again in ${Math.round(ms / 1000)}s`);
      await wait(ms);
      continue;
    }
    throw new ApiError(`${method} ${path} → ${res.status}: ${text}`, res.status);
  }
}

/**
 * Clear the one pending-submission slot for a new submission. Returns false
 * when it is still taken after waiting (this release then skips the Store).
 */
export async function clearPending(call, appId, { wait = sleep, waitMs = WAIT_MS, pollMs = POLL_MS } = {}) {
  const deadline = Date.now() + waitMs;
  for (let tried = 0; ; tried++) {
    const app = await call("GET", `applications/${appId}`);
    const old = app.pendingApplicationSubmission?.id;
    if (!old) return true;
    const pending = await call("GET", `applications/${appId}/submissions/${old}`);
    const status = pending?.status;
    if (pendingSubmissionAction(status) === "replace") {
      console.log(`Deleting pending submission ${old} (${status})...`);
      try {
        await call("DELETE", `applications/${appId}/submissions/${old}`);
        return true;
      } catch (e) {
        // 409: Microsoft moved it on (or won't delete it in this state). Look again.
        if (e?.status !== 409) throw e;
        console.log(`Submission ${old} can't be deleted while ${status}; looking again.`);
      }
    } else {
      console.log(`Submission ${old} is ${status ?? "in an unknown state"}; waiting for Microsoft to finish it.`);
    }
    if (Date.now() >= deadline || tried >= Math.ceil(waitMs / pollMs)) {
      console.log(
        `::warning::Microsoft Store: submission ${old} is still ${status ?? "pending"} after waiting, so this release is not submitted. Re-run the Store step once it has moved on.`,
      );
      console.log(`Track: https://partner.microsoft.com/en-us/dashboard/products/${appId}/submissions/${old}`);
      return false;
    }
    await wait(pollMs);
  }
}

/** After commit: wait for CommitStarted to resolve. Returns the final status. */
export async function awaitCommit(call, appId, id, { wait = sleep, waitMs = WAIT_MS, pollMs = POLL_MS } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const st = await call("GET", `applications/${appId}/submissions/${id}/status`);
    if (st?.status !== "CommitStarted") return st;
    if (Date.now() >= deadline) return st;
    await wait(pollMs);
  }
}

/** --status: what the Store has, read-only. */
async function status(token, appId) {
  const call = (method, path) => api(token, method, path);
  const app = await call("GET", `applications/${appId}`);
  const show = async (label, ref) => {
    if (!ref?.id) return console.log(`${label}: none`);
    const sub = await call("GET", `applications/${appId}/submissions/${ref.id}`);
    const pkgs = (sub.applicationPackages ?? []).map((p) => `${p.fileName} (${p.version ?? "?"}, ${p.fileStatus})`);
    console.log(`${label}: ${ref.id} — ${sub.status}`);
    console.log(`  packages: ${pkgs.join(", ") || "-"}`);
    console.log(`  notes for certification: ${sub.notesForCertification ? `${sub.notesForCertification.length} chars` : "EMPTY"}`);
    console.log(`  status details: ${JSON.stringify(sub.statusDetails ?? {})}`);
    console.log(`  target publish: ${sub.targetPublishMode ?? "?"} ${sub.targetPublishDate ?? ""}`);
  };
  console.log(`App ${appId}: ${app.primaryName ?? ""}`);
  await show("Pending", app.pendingApplicationSubmission);
  await show("Last published", app.lastPublishedApplicationSubmission);
}

async function main() {
  const TENANT_ID = env("AZURE_AD_TENANT_ID");
  const CLIENT_ID = env("AZURE_AD_CLIENT_ID");
  const CLIENT_SECRET = env("AZURE_AD_CLIENT_SECRET");
  const APP_ID = env("STORE_APP_ID");
  if (process.argv.includes("--status")) {
    return status(await getToken(TENANT_ID, CLIENT_ID, CLIENT_SECRET), APP_ID);
  }
  const UPLOAD_PATH = env("MSIXUPLOAD_PATH");

  statSync(UPLOAD_PATH);
  const filename = basename(UPLOAD_PATH);
  console.log(
    `Package: ${filename} (${(statSync(UPLOAD_PATH).size / 1e6).toFixed(1)} MB)`,
  );

  console.log("Authenticating...");
  const token = await getToken(TENANT_ID, CLIENT_ID, CLIENT_SECRET);

  const call = (method, path, body) => api(token, method, path, body);

  // A product can have at most one pending submission.
  console.log("Checking for pending submissions...");
  if (!(await clearPending(call, APP_ID))) return;

  // Create a new submission — Partner Center clones the published one, so all
  // listing metadata, screenshots, age rating, and pricing carry forward.
  console.log("Creating submission...");
  const sub = await api(token, "POST", `applications/${APP_ID}/submissions`);
  console.log(`Submission ${sub.id} created.`);

  // Replace packages: mark every existing one for deletion, add the new upload.
  for (const pkg of sub.applicationPackages || []) {
    pkg.fileStatus = "PendingDelete";
  }
  sub.applicationPackages.push({
    fileName: filename,
    fileStatus: "PendingUpload",
  });

  console.log("Updating submission packages...");
  await api(token, "PUT", `applications/${APP_ID}/submissions/${sub.id}`, sub);

  // The SAS URL expects a ZIP containing the package files.
  console.log("Zipping package for upload...");
  const tmp = mkdtempSync(join(tmpdir(), "store-submit-"));
  const zipPath = join(tmp, "upload.zip");

  if (process.platform === "win32") {
    execSync(
      `Compress-Archive -Path "${UPLOAD_PATH}" -DestinationPath "${zipPath}" -Force`,
      { shell: "powershell.exe", stdio: "inherit" },
    );
  } else {
    execSync(`zip -j "${zipPath}" "${UPLOAD_PATH}"`, { stdio: "inherit" });
  }

  console.log(
    `Uploading to Azure Blob (${(statSync(zipPath).size / 1e6).toFixed(1)} MB)...`,
  );
  const zipBuffer = readFileSync(zipPath);
  const uploadRes = await fetch(sub.fileUploadUrl, {
    method: "PUT",
    headers: {
      "x-ms-blob-type": "BlockBlob",
      "Content-Length": String(zipBuffer.length),
    },
    body: zipBuffer,
  });
  if (!uploadRes.ok) {
    throw new Error(
      `Upload failed: ${uploadRes.status} ${await uploadRes.text()}`,
    );
  }
  console.log("Upload complete.");

  // Commit — triggers certification. Status moves to CommitStarted, then
  // through PreProcessing → Certification → Publishing → Published.
  console.log("Committing submission...");
  await api(token, "POST", `applications/${APP_ID}/submissions/${sub.id}/commit`);
  const settled = await awaitCommit(call, APP_ID, sub.id);
  if (settled?.status === "CommitFailed") {
    throw new Error(`Commit failed: ${JSON.stringify(settled.statusDetails?.errors ?? settled.statusDetails ?? {})}`);
  }
  console.log("Committed. Status:", settled?.status ?? "unknown");
  console.log(
    `Track: https://partner.microsoft.com/en-us/dashboard/products/${APP_ID}/submissions/${sub.id}`,
  );
}

// Only when RUN, never when imported: the test imports pendingSubmissionAction.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error("Store submission failed:", err.message || err);
    process.exit(1);
  });
}
