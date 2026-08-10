#!/usr/bin/env node
/**
 * Submit an MSIX package to the Microsoft Store via the Submission API v1.
 *
 * Called by msix.yml on release tags (workflow_call). Manual runs
 * (workflow_dispatch) skip this step — a test build should never submit.
 *
 * Flow:
 *  1. Authenticate via Azure AD client credentials
 *  2. Delete any pending (uncommitted) submission
 *  3. Create a new submission (clones the published one — all listing info,
 *     screenshots, age rating, etc. carry forward automatically)
 *  4. Mark old packages PendingDelete, add the new .msixupload as PendingUpload
 *  5. Upload a ZIP containing the package to the returned SAS URL
 *  6. Commit → triggers Microsoft certification
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
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

const TENANT_ID = env("AZURE_AD_TENANT_ID");
const CLIENT_ID = env("AZURE_AD_CLIENT_ID");
const CLIENT_SECRET = env("AZURE_AD_CLIENT_SECRET");
const APP_ID = env("STORE_APP_ID");
const UPLOAD_PATH = env("MSIXUPLOAD_PATH");

const API = "https://manage.devcenter.microsoft.com/v1.0/my";

function env(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

async function getToken() {
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
    throw new Error(`Token request failed: ${data.error_description || JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function api(token, method, path, body) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}/${path}`, opts);
  if (method === "DELETE" && res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  statSync(UPLOAD_PATH);
  const filename = basename(UPLOAD_PATH);
  console.log(`Package: ${filename} (${(statSync(UPLOAD_PATH).size / 1e6).toFixed(1)} MB)`);

  console.log("Authenticating...");
  const token = await getToken();

  // A product can have at most one pending submission. If a previous CI run
  // created one but certification failed (or was never committed), delete it.
  console.log("Checking for pending submissions...");
  const app = await api(token, "GET", `applications/${APP_ID}`);
  if (app.pendingApplicationSubmission) {
    const old = app.pendingApplicationSubmission.id;
    console.log(`Deleting pending submission ${old}...`);
    await api(token, "DELETE", `applications/${APP_ID}/submissions/${old}`);
  }

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

  console.log(`Uploading to Azure Blob (${(statSync(zipPath).size / 1e6).toFixed(1)} MB)...`);
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
    throw new Error(`Upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
  }
  console.log("Upload complete.");

  // Commit — triggers certification. Status moves to CommitStarted, then
  // through PreProcessing → Certification → Publishing → Published.
  console.log("Committing submission...");
  const commit = await api(
    token,
    "POST",
    `applications/${APP_ID}/submissions/${sub.id}/commit`,
  );
  console.log("Committed. Certification status:", commit?.status || "started");
  console.log(
    `Track: https://partner.microsoft.com/en-us/dashboard/products/${APP_ID}/submissions/${sub.id}`,
  );
}

main().catch((err) => {
  console.error("Store submission failed:", err.message || err);
  process.exit(1);
});
