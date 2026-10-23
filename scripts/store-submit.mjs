#!/usr/bin/env node
/**
 * Submit an MSIX package to the Microsoft Store via the Submission API v1.
 *
 * Called by msix.yml on release tags (workflow_call). Manual runs
 * (workflow_dispatch) skip this step — a test build should never submit.
 *
 * Flow:
 *  1. Authenticate via Azure AD client credentials
 *  2. If a submission is pending: REUSE a draft (PendingCommit, or Canceled:
 *     one whose certification was cancelled in Partner Center), replace one
 *     that failed, and WAIT for one Microsoft is processing or certifying. If
 *     it is still there after the wait, this release skips the Store
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
import { basename, dirname, join, resolve } from "node:path";
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

// Statuses of a pending submission this release replaces: one that never started
// or failed. A submission Microsoft is still processing or certifying is LEFT
// ALONE, and this release skips the Store (re-run the Store step once it has
// moved on). 2026-10-18 tried the opposite (newest release wins, 82a24426), and
// the Store published nothing from 14.51.0 on: the restricted-capability review
// takes days, and every release restarted it (15.9.0, 15.9.1, 15.9.2, 15.10.0
// twice). Waited for: PreProcessing, Certification, Release, CommitStarted,
// PendingPublication, Publishing, and any status this list doesn't know.
const REPLACEABLE = new Set([
  "CommitFailed",
  "PreProcessingFailed",
  "CertificationFailed",
  "ReleaseFailed",
  "PublishFailed",
]);

/**
 * A draft is REUSED rather than replaced: a new submission clones the published
 * one, so anything set by hand on the draft would be lost. That includes a
 * submission whose certification was cancelled in Partner Center: the API
 * reports it as "Canceled", not "PendingCommit", and 15.11.0 deleted one with
 * the support info set on it (2026-10-24).
 * @returns {"wait" | "replace" | "reuse"}
 */
export function pendingSubmissionAction(status) {
  if (status === "PendingCommit" || status === "Canceled") return "reuse";
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

/**
 * Notes for the Store's testers: why the two restricted capabilities, and how to
 * try the app. Every submission went in with none, and a manual review of a
 * restricted capability with nothing to go on is slow (status report 2026-10-18).
 */
export function certificationNotes() {
  const file = join(dirname(fileURLToPath(import.meta.url)), "../build/msix/certification-notes.txt");
  return readFileSync(file, "utf8").trim();
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
 * Clear the one pending-submission slot for a new submission. Returns true when
 * it is free, a draft's id when that draft should be reused, and false when it
 * is still taken after waiting (this release then skips the Store).
 */
export async function clearPending(call, appId, { wait = sleep, waitMs = WAIT_MS, pollMs = POLL_MS } = {}) {
  const deadline = Date.now() + waitMs;
  for (let tried = 0; ; tried++) {
    const app = await call("GET", `applications/${appId}`);
    const old = app.pendingApplicationSubmission?.id;
    if (!old) return true;
    const pending = await call("GET", `applications/${appId}/submissions/${old}`);
    const status = pending?.status;
    const action = pendingSubmissionAction(status);
    if (action === "reuse") {
      console.log(`Reusing draft submission ${old}.`);
      return old;
    }
    if (action === "replace") {
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
  const slot = await clearPending(call, APP_ID);
  if (slot === false) return;

  // A new submission clones the published one, so all listing metadata,
  // screenshots, age rating, and pricing carry forward. A reused draft keeps
  // whatever was set on it by hand as well.
  let sub;
  if (typeof slot === "string") {
    sub = await api(token, "GET", `applications/${APP_ID}/submissions/${slot}`);
  } else {
    console.log("Creating submission...");
    sub = await api(token, "POST", `applications/${APP_ID}/submissions`);
    console.log(`Submission ${sub.id} created.`);
  }

  // Replace packages: mark every existing one for deletion, add the new upload.
  for (const pkg of sub.applicationPackages || []) {
    pkg.fileStatus = "PendingDelete";
  }
  sub.applicationPackages.push({
    fileName: filename,
    fileStatus: "PendingUpload",
  });
  sub.notesForCertification = certificationNotes();

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
