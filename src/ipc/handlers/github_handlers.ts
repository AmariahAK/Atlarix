import { ipcMain, BrowserWindow, IpcMainInvokeEvent } from "electron";
import fetch from "node-fetch"; // Use node-fetch for making HTTP requests in main process
import { writeSettings, readSettings } from "../../main/settings";
import { gitSetRemoteUrl, gitPush, gitClone } from "../utils/git_utils";
import * as schema from "../../db/schema";
import fs from "node:fs";
import os from "node:os";
import { promises as fsPromises } from "node:fs";
import { getAtlarixAppPath } from "../../paths/paths";
import { db } from "../../db";
import { apps } from "../../db/schema";
import type {
  CloneRepoParams,
  CloneRepoReturnType,
  GithubCloneProgress,
} from "@/ipc/ipc_types";
import { eq } from "drizzle-orm";
import { GithubUser } from "../../lib/schemas";
import log from "electron-log";
import { IS_TEST_BUILD } from "../utils/test_utils";
import path from "node:path"; // ← ADD THIS
import {
  getGithubDeviceFlowClientId,
  isLegacyDyadGithubDeviceClient,
  looksLikeInvalidGithubOAuthClientId,
} from "@/config/github-oauth";

const logger = log.scope("github_handlers");

if (isLegacyDyadGithubDeviceClient()) {
  logger.warn(
    "[GitHub] Using legacy Dyad OAuth client — GitHub will show “Authorize Dyad”. " +
      "Set OAUTH_CLIENT_ID to an OAuth app named Atlarix (Device Flow enabled).",
  );
}

// --- GitHub Device Flow Constants ---
function resolveGithubClientId(): string {
  return getGithubDeviceFlowClientId();
}

// Use test server URLs when in test mode

const TEST_SERVER_BASE = "http://localhost:3500";

const GITHUB_DEVICE_CODE_URL = IS_TEST_BUILD
  ? `${TEST_SERVER_BASE}/github/login/device/code`
  : "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = IS_TEST_BUILD
  ? `${TEST_SERVER_BASE}/github/login/oauth/access_token`
  : "https://github.com/login/oauth/access_token";
const GITHUB_API_BASE = IS_TEST_BUILD
  ? `${TEST_SERVER_BASE}/github/api`
  : "https://api.github.com";
const GITHUB_GIT_BASE = IS_TEST_BUILD
  ? `${TEST_SERVER_BASE}/github/git`
  : "https://github.com";

const GITHUB_SCOPES = "repo,user,workflow"; // Define the scopes needed

// --- State Management (Simple in-memory, consider alternatives for robustness) ---
interface DeviceFlowState {
  deviceCode: string;
  interval: number;
  timeoutId: NodeJS.Timeout | null;
  isPolling: boolean;
  window: BrowserWindow | null; // Reference to the window that initiated the flow
}

// Simple map to track ongoing flows (key could be appId or a unique flow ID if needed)
// For simplicity, let's assume only one flow can happen at a time for now.
let currentFlowState: DeviceFlowState | null = null;

// --- Helper Functions ---

/**
 * Fetches the GitHub username of the currently authenticated user (using the stored access token).
 * @returns {Promise<string|null>} The GitHub username, or null if not authenticated or on error.
 */
export async function getGithubUser(): Promise<GithubUser | null> {
  const settings = readSettings();
  const email = settings.githubUser?.email;
  if (email) return { email };
  try {
    const accessToken = settings.githubAccessToken?.value;
    if (!accessToken) return null;
    const res = await fetch(`${GITHUB_API_BASE}/user/emails`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const emails = await res.json();
    const email = emails.find((e: any) => e.primary)?.email;
    if (!email) return null;

    writeSettings({
      githubUser: {
        email,
      },
    });
    return { email };
  } catch (err) {
    logger.error("[GitHub Handler] Failed to get GitHub username:", err);
    return null;
  }
}

type GithubFlowChannel =
  | "github:flow-update"
  | "github:flow-success"
  | "github:flow-error";

function sendGithubFlowEvent(
  channel: GithubFlowChannel,
  data: Record<string, unknown>,
): boolean {
  const win = currentFlowState?.window;
  if (!win || win.isDestroyed()) return false;
  const wc = win.webContents;
  if (wc.isDestroyed()) return false;
  try {
    wc.send(channel, data);
    return true;
  } catch (err) {
    logger.debug(
      "[GitHub Handler] Flow event not delivered (renderer destroyed):",
      err,
    );
    return false;
  }
}

function isDestroyedRendererError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("Object has been destroyed") ||
      error.message.includes("Render frame was disposed"))
  );
}

async function pollForAccessToken() {
  if (!currentFlowState || !currentFlowState.isPolling) {
    logger.debug("[GitHub Handler] Polling stopped or no active flow.");
    return;
  }

  const { deviceCode, interval } = currentFlowState;

  logger.debug("[GitHub Handler] Polling for token with device code");
  if (
    !sendGithubFlowEvent("github:flow-update", {
      message: "Polling GitHub for authorization...",
    })
  ) {
    stopPolling();
    return;
  }

  try {
    const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: resolveGithubClientId(),
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const data = await response.json();

    if (response.ok && data.access_token) {
      logger.log("Successfully obtained GitHub Access Token.");
      sendGithubFlowEvent("github:flow-success", {
        message: "Successfully connected!",
      });
      writeSettings({
        githubAccessToken: {
          value: data.access_token,
        },
      });

      stopPolling();
      return;
    } else if (data.error) {
      switch (data.error) {
        case "authorization_pending":
          logger.debug("Authorization pending...");
          sendGithubFlowEvent("github:flow-update", {
            message: "Waiting for user authorization...",
          });
          // Schedule next poll
          currentFlowState.timeoutId = setTimeout(
            () => void pollForAccessToken(),
            interval * 1000,
          );
          break;
        case "slow_down":
          const newInterval = interval + 5;
          logger.debug(`Slow down requested. New interval: ${newInterval}s`);
          currentFlowState.interval = newInterval; // Update interval
          sendGithubFlowEvent("github:flow-update", {
            message: `GitHub asked to slow down. Retrying in ${newInterval}s...`,
          });
          currentFlowState.timeoutId = setTimeout(
            () => void pollForAccessToken(),
            newInterval * 1000,
          );
          break;
        case "expired_token":
          logger.error("Device code expired.");
          sendGithubFlowEvent("github:flow-error", {
            error: "Verification code expired. Please try again.",
          });
          stopPolling();
          break;
        case "access_denied":
          logger.debug("Access denied by user (cancelled on GitHub).");
          sendGithubFlowEvent("github:flow-error", {
            error: "Authorization cancelled.",
          });
          stopPolling();
          break;
        default:
          logger.error(
            `Unknown GitHub error: ${data.error_description || data.error}`,
          );
          sendGithubFlowEvent("github:flow-error", {
            error: `GitHub authorization error: ${data.error_description || data.error
              }`,
          });
          stopPolling();
          break;
      }
    } else {
      throw new Error(`Unknown response structure: ${JSON.stringify(data)}`);
    }
  } catch (error) {
    if (isDestroyedRendererError(error)) {
      stopPolling();
      return;
    }
    logger.error("Error polling for GitHub access token:", error);
    sendGithubFlowEvent("github:flow-error", {
      error: `Network or unexpected error during polling: ${error instanceof Error ? error.message : String(error)
        }`,
    });
    stopPolling();
  }
}

function stopPolling() {
  if (currentFlowState) {
    if (currentFlowState.timeoutId) {
      clearTimeout(currentFlowState.timeoutId);
      currentFlowState.timeoutId = null;
    }
    currentFlowState.isPolling = false;
    logger.debug("[GitHub Handler] Polling stopped.");
  }
}

function cancelGithubDeviceFlow(notifyRenderer = true) {
  stopPolling();
  if (notifyRenderer) {
    sendGithubFlowEvent("github:flow-error", {
      error: "GitHub connection cancelled.",
    });
  }
  currentFlowState = null;
  logger.debug("[GitHub Handler] Device flow cancelled.");
}

// --- IPC Handlers ---

function handleStartGithubFlow(
  event: IpcMainInvokeEvent,
  args: { appId: number | null },
) {
  logger.debug(`Received github:start-flow for appId: ${args.appId}`);

  const githubClientId = resolveGithubClientId();
  if (looksLikeInvalidGithubOAuthClientId(githubClientId)) {
    const hint =
      "OAUTH_CLIENT_ID in .env must be the OAuth App **Client ID** (public, often starts with Ov23li…), " +
      "not the client secret or a GitHub App key. Enable Device Flow on the OAuth app.";
    logger.error(`[GitHub] Invalid client id shape: ${githubClientId.slice(0, 8)}…`);
    sendGithubFlowEvent("github:flow-error", { error: hint });
    return;
  }

  // If a flow is already in progress, cancel it before starting a new one
  if (currentFlowState?.isPolling) {
    logger.warn("Replacing in-progress GitHub device flow.");
    cancelGithubDeviceFlow(false);
  }

  // Store the window that initiated the request
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) {
    logger.error("Could not get BrowserWindow instance.");
    return;
  }

  currentFlowState = {
    deviceCode: "",
    interval: 5, // Default interval
    timeoutId: null,
    isPolling: false,
    window: window,
  };

  sendGithubFlowEvent("github:flow-update", {
    message: "Requesting device code from GitHub...",
  });

  fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: githubClientId,
      scope: GITHUB_SCOPES,
    }),
  })
    .then((res) => {
      if (!res.ok) {
        return res.json().then((errData) => {
          const detail = errData.error_description || errData.error || res.statusText;
          if (res.status === 404) {
            throw new Error(
              `GitHub does not recognize this OAuth client ID (404). Use the Client ID from ` +
                `Settings → Developer settings → OAuth Apps → Atlarix (Device Flow enabled). ` +
                `Do not paste the client secret into OAUTH_CLIENT_ID.`,
            );
          }
          throw new Error(`GitHub API Error: ${detail}`);
        });
      }
      return res.json();
    })
    .then((data) => {
      logger.info("Received device code response");
      if (!currentFlowState) return; // Flow might have been cancelled

      currentFlowState.deviceCode = data.device_code;
      currentFlowState.interval = data.interval || 5;
      currentFlowState.isPolling = true;

      // Send user code and verification URI to renderer
      sendGithubFlowEvent("github:flow-update", {
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        message: "Please authorize in your browser.",
      });

      // Start polling after the initial interval
      currentFlowState.timeoutId = setTimeout(
        () => void pollForAccessToken(),
        currentFlowState.interval * 1000,
      );
    })
    .catch((error) => {
      logger.error("Error initiating GitHub device flow:", error);
      sendGithubFlowEvent("github:flow-error", {
        error: `Failed to start GitHub connection: ${error.message}`,
      });
      cancelGithubDeviceFlow(false);
    });
}

function handleCancelGithubFlow() {
  cancelGithubDeviceFlow(true);
}

// --- GitHub List Repos Handler ---
async function handleListGithubRepos(): Promise<
  { name: string; full_name: string; private: boolean }[]
> {
  try {
    // Get access token from settings
    const settings = readSettings();
    const accessToken = settings.githubAccessToken?.value;
    if (!accessToken) {
      throw new Error("Not authenticated with GitHub.");
    }

    // Fetch user's repositories
    const response = await fetch(
      `${GITHUB_API_BASE}/user/repos?per_page=100&sort=updated`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        `GitHub API error: ${errorData.message || response.statusText}`,
      );
    }

    const repos = await response.json();
    return repos.map((repo: any) => ({
      name: repo.name,
      full_name: repo.full_name,
      private: repo.private,
    }));
  } catch (err: any) {
    logger.error("[GitHub Handler] Failed to list repos:", err);
    throw new Error(err.message || "Failed to list GitHub repositories.");
  }
}

// --- GitHub Get Repo Branches Handler ---
async function handleGetRepoBranches(
  event: IpcMainInvokeEvent,
  { owner, repo }: { owner: string; repo: string },
): Promise<{ name: string; commit: { sha: string } }[]> {
  try {
    // Get access token from settings
    const settings = readSettings();
    const accessToken = settings.githubAccessToken?.value;
    if (!accessToken) {
      throw new Error("Not authenticated with GitHub.");
    }

    // Fetch repository branches
    const response = await fetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/branches`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        `GitHub API error: ${errorData.message || response.statusText}`,
      );
    }

    const branches = await response.json();
    return branches.map((branch: any) => ({
      name: branch.name,
      commit: { sha: branch.commit.sha },
    }));
  } catch (err: any) {
    logger.error("[GitHub Handler] Failed to get repo branches:", err);
    throw new Error(err.message || "Failed to get repository branches.");
  }
}

// --- GitHub Repo Availability Handler ---
async function handleIsRepoAvailable(
  event: IpcMainInvokeEvent,
  { org, repo }: { org: string; repo: string },
): Promise<{ available: boolean; error?: string }> {
  try {
    // Get access token from settings
    const settings = readSettings();
    const accessToken = settings.githubAccessToken?.value;
    if (!accessToken) {
      return { available: false, error: "Not authenticated with GitHub." };
    }
    // If org is empty, use the authenticated user
    const owner =
      org ||
      (await fetch(`${GITHUB_API_BASE}/user`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
        .then((r) => r.json())
        .then((u) => u.login));
    // Check if repo exists
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 404) {
      return { available: true };
    } else if (res.ok) {
      return { available: false, error: "Repository already exists." };
    } else {
      const data = await res.json();
      return { available: false, error: data.message || "Unknown error" };
    }
  } catch (err: any) {
    return { available: false, error: err.message || "Unknown error" };
  }
}

// --- GitHub Create Repo Handler ---
async function handleCreateRepo(
  event: IpcMainInvokeEvent,
  {
    org,
    repo,
    appId,
    branch,
  }: { org: string; repo: string; appId: number; branch?: string },
): Promise<void> {
  // Get access token from settings
  const settings = readSettings();
  const accessToken = settings.githubAccessToken?.value;
  if (!accessToken) {
    throw new Error("Not authenticated with GitHub.");
  }
  // If org is empty, create for the authenticated user
  let owner = org;
  if (!owner) {
    const userRes = await fetch(`${GITHUB_API_BASE}/user`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const user = await userRes.json();
    owner = user.login;
  }
  // Create repo
  const createUrl = org
    ? `${GITHUB_API_BASE}/orgs/${owner}/repos`
    : `${GITHUB_API_BASE}/user/repos`;
  const res = await fetch(createUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      name: repo,
      private: true,
    }),
  });
  if (!res.ok) {
    let errorMessage = `Failed to create repository (${res.status} ${res.statusText})`;
    try {
      const data = await res.json();
      logger.error("GitHub API error when creating repo:", {
        status: res.status,
        statusText: res.statusText,
        response: data,
      });

      // Handle specific GitHub API error cases
      if (data.message) {
        errorMessage = data.message;
      }

      // Handle validation errors with more details
      if (data.errors && Array.isArray(data.errors)) {
        const errorDetails = data.errors
          .map((err: any) => {
            if (typeof err === "string") return err;
            if (err.message) return err.message;
            if (err.code) return `${err.field || "field"}: ${err.code}`;
            return JSON.stringify(err);
          })
          .join(", ");
        errorMessage = `${data.message || "Repository creation failed"}: ${errorDetails}`;
      }
    } catch (jsonError) {
      // If response is not JSON, fall back to status text
      logger.error("Failed to parse GitHub API error response:", {
        status: res.status,
        statusText: res.statusText,
        jsonError:
          jsonError instanceof Error ? jsonError.message : String(jsonError),
      });
      errorMessage = `GitHub API error: ${res.status} ${res.statusText}`;
    }

    throw new Error(errorMessage);
  }
  // Store org, repo, and branch in the app's DB row (apps table)
  await updateAppGithubRepo({ appId, org: owner, repo, branch });
}

// --- GitHub Connect to Existing Repo Handler ---
async function handleConnectToExistingRepo(
  event: IpcMainInvokeEvent,
  {
    owner,
    repo,
    branch,
    appId,
  }: { owner: string; repo: string; branch: string; appId: number },
): Promise<void> {
  try {
    // Get access token from settings
    const settings = readSettings();
    const accessToken = settings.githubAccessToken?.value;
    if (!accessToken) {
      throw new Error("Not authenticated with GitHub.");
    }

    // Verify the repository exists and user has access
    const repoResponse = await fetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (!repoResponse.ok) {
      const errorData = await repoResponse.json();
      throw new Error(
        `Repository not found or access denied: ${errorData.message}`,
      );
    }

    // Store org, repo, and branch in the app's DB row
    await updateAppGithubRepo({ appId, org: owner, repo, branch });
  } catch (err: any) {
    logger.error("[GitHub Handler] Failed to connect to existing repo:", err);
    throw new Error(err.message || "Failed to connect to existing repository.");
  }
}

// --- GitHub Push Handler ---
async function handlePushToGithub(
  event: IpcMainInvokeEvent,
  { appId, force }: { appId: number; force?: boolean },
) {
  try {
    // Get access token from settings
    const settings = readSettings();
    const accessToken = settings.githubAccessToken?.value;
    if (!accessToken) {
      return { success: false, error: "Not authenticated with GitHub." };
    }
    // Get app info from DB
    const app = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
    if (!app || !app.githubOrg || !app.githubRepo) {
      return { success: false, error: "App is not linked to a GitHub repo." };
    }
    const appPath = getAtlarixAppPath(app.path);
    const branch = app.githubBranch || "main";

    // Set up remote URL with token
    const remoteUrl = IS_TEST_BUILD
      ? `${GITHUB_GIT_BASE}/${app.githubOrg}/${app.githubRepo}.git`
      : `https://${accessToken}:x-oauth-basic@github.com/${app.githubOrg}/${app.githubRepo}.git`;
    // Set or update remote URL using git config
    await gitSetRemoteUrl({
      path: appPath,
      remoteUrl,
    });

    // Push to GitHub
    await gitPush({
      path: appPath,
      branch,
      accessToken,
      force,
    });
    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || "Failed to push to GitHub.",
    };
  }
}

async function handleDisconnectGithubRepo(
  event: IpcMainInvokeEvent,
  { appId }: { appId: number },
): Promise<void> {
  logger.log(`Disconnecting GitHub repo for appId: ${appId}`);

  // Get the app from the database
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, appId),
  });

  if (!app) {
    throw new Error("App not found");
  }

  // Update app in database to remove GitHub repo, org, and branch
  await db
    .update(apps)
    .set({
      githubRepo: null,
      githubOrg: null,
      githubBranch: null,
    })
    .where(eq(apps.id, appId));
}
// --- GitHub Clone Repo from URL Handler ---
let activeCloneAbort: AbortController | null = null;

function sendCloneProgress(
  event: IpcMainInvokeEvent,
  progress: GithubCloneProgress,
): void {
  if (!event.sender.isDestroyed()) {
    event.sender.send("github:clone:progress", progress);
  }
}

function handleCancelGithubClone(): void {
  activeCloneAbort?.abort();
  activeCloneAbort = null;
}

async function removePartialCloneDir(dirPath: string): Promise<void> {
  try {
    await fsPromises.rm(dirPath, { recursive: true, force: true });
  } catch (e) {
    logger.warn(`[GitHub Handler] Could not remove partial clone at ${dirPath}:`, e);
  }
}

async function handleCloneRepoFromUrl(
  event: IpcMainInvokeEvent,
  params: CloneRepoParams,
): Promise<CloneRepoReturnType> {
  const { url, installCommand, startCommand, appName, targetPath } = params;
  activeCloneAbort?.abort();
  const abort = new AbortController();
  activeCloneAbort = abort;

  const sendProgress = (p: GithubCloneProgress) => sendCloneProgress(event, p);

  try {
    sendProgress({ step: "validating", message: "Validating repository…", progress: 5 });

    const settings = readSettings();
    const accessToken = settings.githubAccessToken?.value;
    const urlPattern = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
    const match = url.match(urlPattern);
    if (!match) {
      return {
        error:
          "Invalid GitHub URL. Expected format: https://github.com/owner/repo.git",
      };
    }
    const [, owner, repoName] = match;
    if (accessToken) {
      const repoResponse = await fetch(
        `${GITHUB_API_BASE}/repos/${owner}/${repoName}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github+json",
          },
        },
      );
      if (!repoResponse.ok) {
        return {
          error: "Repository not found or you do not have access to it.",
        };
      }
    }
    const finalAppName = appName && appName.trim() ? appName.trim() : repoName;
    const existingApp = await db.query.apps.findFirst({
      where: eq(apps.name, finalAppName),
    });

    if (existingApp) {
      return { error: `An app named "${finalAppName}" already exists.` };
    }

    if (!targetPath || !path.isAbsolute(targetPath)) {
      return { error: "Choose a save folder before cloning." };
    }
    const fullAppPath = path.resolve(targetPath);

    if (fs.existsSync(fullAppPath)) {
      return { error: `Folder already exists: ${fullAppPath}` };
    }

    if (!settings.enableNativeGit) {
      fs.mkdirSync(path.dirname(fullAppPath), { recursive: true });
    }

    // Use authenticated URL if token exists, otherwise use public HTTPS URL
    const cloneUrl = accessToken
      ? IS_TEST_BUILD
        ? `${GITHUB_GIT_BASE}/${owner}/${repoName}.git`
        : `https://${accessToken}:x-oauth-basic@github.com/${owner}/${repoName}.git`
      : `https://github.com/${owner}/${repoName}.git`;

    sendProgress({ step: "cloning", message: "Cloning repository…", progress: 15 });

    try {
      await gitClone({
        path: fullAppPath,
        url: cloneUrl,
        accessToken,
        singleBranch: false,
        signal: abort.signal,
      });
    } catch (cloneErr: unknown) {
      await removePartialCloneDir(fullAppPath);
      if (
        abort.signal.aborted ||
        (cloneErr instanceof Error && cloneErr.name === "AbortError")
      ) {
        return { error: "Clone cancelled." };
      }
      logger.error("[GitHub Handler] Clone failed:", cloneErr);
      return {
        error:
          "Failed to clone repository. Please check the URL and try again.",
      };
    }

    if (abort.signal.aborted) {
      await removePartialCloneDir(fullAppPath);
      return { error: "Clone cancelled." };
    }

    sendProgress({
      step: "registering",
      message: "Registering workspace…",
      progress: 90,
    });

    const now = new Date();
    const [newApp] = await db
      .insert(schema.apps)
      .values({
        name: finalAppName,
        path: fullAppPath,
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
        githubOrg: owner,
        githubRepo: repoName,
        githubBranch: "main",
        installCommand: installCommand || null,
        startCommand: startCommand || null,
      })
      .returning();
    const [newChat] = await db
      .insert(schema.chats)
      .values({ appId: newApp.id })
      .returning();

    sendProgress({ step: "complete", message: "Complete!", progress: 100 });
    logger.log(`Successfully cloned repo ${owner}/${repoName} to ${fullAppPath}`);
    return {
      app: {
        ...newApp,
        path: fullAppPath,
        files: [],
        supabaseProjectName: null,
        vercelTeamSlug: null,
      },
      chatId: newChat.id,
    };
  } catch (err: unknown) {
    logger.error("[GitHub Handler] Unexpected error in clone flow:", err);
    if (err instanceof Error && err.name === "AbortError") {
      return { error: "Clone cancelled." };
    }
    return {
      error:
        err instanceof Error
          ? err.message
          : "An unexpected error occurred during cloning.",
    };
  } finally {
    if (activeCloneAbort === abort) {
      activeCloneAbort = null;
    }
  }
}

// --- Registration ---
export function registerGithubHandlers() {
  ipcMain.handle("github:start-flow", handleStartGithubFlow);
  ipcMain.handle("github:cancel-flow", handleCancelGithubFlow);
  ipcMain.handle("github:cancel-clone", () => {
    handleCancelGithubClone();
  });
  ipcMain.handle("github:list-repos", handleListGithubRepos);
  ipcMain.handle(
    "github:get-repo-branches",
    (event, args: { owner: string; repo: string }) =>
      handleGetRepoBranches(event, args),
  );
  ipcMain.handle("github:is-repo-available", handleIsRepoAvailable);
  ipcMain.handle("github:create-repo", handleCreateRepo);
  ipcMain.handle(
    "github:connect-existing-repo",
    (
      event,
      args: { owner: string; repo: string; branch: string; appId: number },
    ) => handleConnectToExistingRepo(event, args),
  );
  ipcMain.handle("github:push", handlePushToGithub);
  ipcMain.handle("github:disconnect", (event, args: { appId: number }) =>
    handleDisconnectGithubRepo(event, args),
  );
  ipcMain.handle(
    "github:clone-repo-from-url",
    async (event, args: CloneRepoParams) => {
      return await handleCloneRepoFromUrl(event, args);
    },
  );
}

export async function updateAppGithubRepo({
  appId,
  org,
  repo,
  branch,
}: {
  appId: number;
  org?: string;
  repo: string;
  branch?: string;
}): Promise<void> {
  await db
    .update(schema.apps)
    .set({
      githubOrg: org,
      githubRepo: repo,
      githubBranch: branch || "main",
    })
    .where(eq(schema.apps.id, appId));
}
