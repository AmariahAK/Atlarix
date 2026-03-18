import { app, BrowserWindow, dialog, Menu } from "electron";
import * as path from "node:path";
import { registerIpcHandlers } from "./ipc/ipc_host";
import dotenv from "dotenv";
// @ts-ignore
import started from "electron-squirrel-startup";
import { updateElectronApp, UpdateSourceType } from "update-electron-app";
import log from "electron-log";
import {
  getSettingsFilePath,
  readSettings,
  writeSettings,
} from "./main/settings";
import { handleAtlarixProReturn } from "./main/pro";
import { IS_TEST_BUILD } from "./ipc/utils/test_utils";
import { BackupManager } from "./backup_manager";
import { getDatabasePath, initializeDatabase } from "./db/index";
import { UserSettings } from "./lib/schemas";
import {
  AddMcpServerConfigSchema,
  AddMcpServerPayload,
  AddPromptDataSchema,
  AddPromptPayload,
} from "./ipc/deep_link_data";
import {
  startPerformanceMonitoring,
  stopPerformanceMonitoring,
} from "./utils/performance_monitor";
import { scheduleCleanupJobs } from "./db/cleanup_jobs";
import { registerCleanupHandlers } from "./db/workspace_cleanup";
import { clearAllSessionMemories } from "./lib/session-memory";
import { startModelsDevRefresh } from "./lib/models_dev";
import { initTelemetry } from "./lib/telemetry/tracer";
import { capture as analyticsCapture, shutdown as analyticsShutdown } from "./main/lib/analytics";
import { SENTRY_DSN } from "./main/sentry-config";
import * as Sentry from "@sentry/electron/main";
import fs from "fs";
import os from "node:os";

log.errorHandler.startCatching();
log.eventLogger.startLogging();
log.scope.labelPadding = false;

const logger = log.scope("main");

// Load environment variables from .env file
dotenv.config();

// Sentry: init in main process before app.whenReady(); DSN from env or fallback for packaged app
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    release: app.getVersion(),
    tracesSampleRate: 1.0,
  });
}

// Mitigate GPU SharedImageManager::ProduceSkia errors (Chromium/Electron on some systems)
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.commandLine.appendSwitch("disable-software-rasterizer");

// Register IPC handlers before app is ready
registerIpcHandlers();

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Decide the git directory depending on environment
function resolveLocalGitDirectory() {
  if (!app.isPackaged) {
    // Dev: app.getAppPath() is the project root
    return path.join(app.getAppPath(), "node_modules/dugite/git");
  }

  // Packaged app: git is bundled via extraResource
  return path.join(process.resourcesPath, "git");
}

const gitDir = resolveLocalGitDirectory();
if (fs.existsSync(gitDir)) {
  process.env.LOCAL_GIT_DIRECTORY = gitDir;
}

// https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app#main-process-mainjs
// Register atlarix:// protocol for OAuth and deep links
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("atlarix", process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient("atlarix");
}

export async function onReady() {
  try {
    const backupManager = new BackupManager({
      settingsFile: getSettingsFilePath(),
      dbFile: getDatabasePath(),
    });
    await backupManager.initialize();
  } catch (e) {
    logger.error("Error initializing backup manager", e);
  }

  createWindow();

  try {
    initializeDatabase();
  } catch (e) {
    logger.error("Database initialization failed:", e);
    const msg = e instanceof Error ? e.message : String(e);
    dialog.showErrorBox(
      "Database Error",
      `Atlarix could not initialize its database. Please restart the app.\n\n${msg}`,
    );
    app.quit();
    return;
  }
  sendDbReadyToWindow();

  try {
    initTelemetry();
  } catch (e) {
    logger.warn("Telemetry init failed (non-fatal):", e);
  }
  const settings = readSettings();

  // Check if app was force-closed
  if (settings.isRunning) {
    logger.warn("App was force-closed on previous run");

    // Store performance data to send after window is created
    if (settings.lastKnownPerformance) {
      logger.warn("Last known performance:", settings.lastKnownPerformance);
      pendingForceCloseData = settings.lastKnownPerformance;
    }
  }

  // Set isRunning to true at startup
  writeSettings({ isRunning: true });

  // Start performance monitoring
  startPerformanceMonitoring();

  // Schedule cleanup jobs (30-day auto-deletion + AI summarization)
  scheduleCleanupJobs();
  logger.info("Cleanup jobs scheduled");

  // Register workspace cleanup handlers
  registerCleanupHandlers();
  logger.info("Workspace cleanup handlers registered");

  // Start models.dev refresh (dynamic model catalog, OpenCode-style)
  startModelsDevRefresh();
  logger.info("Models.dev refresh started");

  await onFirstRunMaybe(settings);
  analyticsCapture("app_launched", {
    version: app.getVersion(),
    platform: process.platform,
    arch: os.arch(),
  });

  logger.info("Auto-update enabled=", settings.enableAutoUpdate);
  if (settings.enableAutoUpdate) {
    // Technically we could just pass the releaseChannel directly to the host,
    // but this is more explicit and falls back to stable if there's an unknown
    // release channel.
    const postfix = settings.releaseChannel === "beta" ? "beta" : "stable";
    // TODO: Phase 4.5 - Set up auto-update via GitHub releases
    // For now, check GitHub API for latest release
    const host = `https://api.github.com/repos/AmariahAK/atlarix-releases/releases/latest`;
    logger.info("Auto-update release channel=", postfix);
    updateElectronApp({
      logger,
      updateSource: {
        type: UpdateSourceType.ElectronPublicUpdateService,
        repo: "AmariahAK/atlarix-releases",
        host,
      },
    }); // additional configuration options available
  }
}

export async function onFirstRunMaybe(settings: UserSettings) {
  if (!settings.hasRunBefore) {
    await promptMoveToApplicationsFolder();
    writeSettings({
      hasRunBefore: true,
    });
  }
  if (IS_TEST_BUILD) {
    writeSettings({
      isTestMode: true,
    });
  }
}

/**
 * Ask the user if the app should be moved to the
 * applications folder.
 */
async function promptMoveToApplicationsFolder(): Promise<void> {
  // Why not in e2e tests?
  // There's no way to stub this dialog in time, so we just skip it
  // in e2e testing mode.
  if (IS_TEST_BUILD) return;
  if (process.platform !== "darwin") return;
  if (app.isInApplicationsFolder()) return;
  logger.log("Prompting user to move to applications folder");

  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Move to Applications Folder", "Do Not Move"],
    defaultId: 0,
    message: "Move to Applications Folder? (required for auto-update)",
  });

  if (response === 0) {
    logger.log("User chose to move to applications folder");
    app.moveToApplicationsFolder();
  } else {
    logger.log("User chose not to move to applications folder");
  }
}

declare global {
  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
}

let mainWindow: BrowserWindow | null = null;
let pendingForceCloseData: any = null;

function sendDbReadyToWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("db-ready");
  }
}

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: process.env.NODE_ENV === "development" ? 1280 : 960,
    minWidth: 800,
    height: 700,
    minHeight: 500,
    titleBarStyle: "hidden",
    titleBarOverlay: false,
    trafficLightPosition: {
      x: 10,
      y: 8,
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      // transparent: true,
    },
    // backgroundColor: "#00000001",
    // frame: false,
  });
  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, "../renderer/main_window/index.html"),
    );
  }
  if (process.env.NODE_ENV === "development") {
    // Open the DevTools.
    mainWindow.webContents.openDevTools();
  }

  // Send force-close event if it was detected; also send db-ready when window loads (in case DB was ready before load)
  mainWindow.webContents.once("did-finish-load", () => {
    sendDbReadyToWindow();
    if (pendingForceCloseData) {
      mainWindow?.webContents.send("force-close-detected", {
        performanceData: pendingForceCloseData,
      });
      pendingForceCloseData = null;
    }
  });

  // Enable native context menu on right-click
  mainWindow.webContents.on("context-menu", (event, params) => {
    // Prevent any default behavior and show our own menu
    event.preventDefault();

    const template: Electron.MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      template.push(
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "delete" },
      );
      if (params.misspelledWord) {
        const suggestions: Electron.MenuItemConstructorOptions[] =
          params.dictionarySuggestions.slice(0, 5).map((suggestion) => ({
            label: suggestion,
            click: () => {
              try {
                mainWindow?.webContents.replaceMisspelling(suggestion);
              } catch (error) {
                logger.error("Failed to replace misspelling:", error);
              }
            },
          }));
        template.push(
          { type: "separator" },
          {
            type: "submenu",
            label: `Correct "${params.misspelledWord}"`,
            submenu: suggestions,
          },
        );
      }
      template.push({ type: "separator" }, { role: "selectAll" });
    } else {
      if (params.selectionText && params.selectionText.length > 0) {
        template.push({ role: "copy" });
      }
      template.push({ role: "selectAll" });
    }

    if (process.env.NODE_ENV === "development") {
      template.push(
        { type: "separator" },
        {
          label: "Inspect Element",
          click: () =>
            mainWindow?.webContents.inspectElement(params.x, params.y),
        },
      );
    }

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow! });
  });
};

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine, _workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // the commandLine is array of strings in which last element is deep link url
    handleDeepLinkReturn(commandLine.pop()!);
  });
  app.whenReady().then(onReady);
}

// Handle the protocol. On macOS, deep links come through open-url event
app.on("open-url", (event, url) => {
  event.preventDefault(); // Prevent trying to open a new instance

  // Focus existing window
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }

  handleDeepLinkReturn(url);
});

function handleDeepLinkReturn(url: string) {
  // DEBUG: Log what URL we actually receive
  log.log("=== DEEP LINK RECEIVED ===");
  log.log("Full URL:", url);
  log.log("URL length:", url.length);
  log.log("Has hash (#):", url.includes('#'));
  log.log("Has query (?):", url.includes('?'));
  log.log("========================");

  // example url: "atlarix://auth/callback?code=abc&state=xyz"
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    log.info("Invalid deep link URL", url);
    return;
  }

  // Intentionally do NOT log the full URL which may contain sensitive tokens.
  log.log(
    "Handling deep link: protocol",
    parsed.protocol,
    "hostname",
    parsed.hostname,
  );
  if (parsed.protocol !== "atlarix:") {
    dialog.showErrorBox(
      "Invalid Protocol",
      `Expected atlarix://, got ${parsed.protocol}. Full URL: ${url}`,
    );
    return;
  }

  // Auth0 Token Vault callback: atlarix://auth0/callback?code=...
  if (parsed.hostname === "auth0" && (parsed.pathname === "/callback" || parsed.pathname === "/callback/")) {
    const code = parsed.searchParams.get("code");
    if (code) {
      import("./lib/auth/TokenVaultService").then(async ({ storeAuth0Tokens }) => {
        const domain = process.env.AUTH0_DOMAIN ?? "";
        const clientId = process.env.AUTH0_CLIENT_ID ?? "";
        const clientSecret = process.env.AUTH0_CLIENT_SECRET ?? "";
        const base = domain.startsWith("http") ? domain : `https://${domain}`;
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: "atlarix://auth0/callback",
        });
        const res = await fetch(`${base}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
        const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
        if (data.access_token && data.refresh_token) {
          storeAuth0Tokens(data.refresh_token, data.access_token, data.expires_in ?? 86400);
          log.log("Auth0 Token Vault: tokens stored");
          if (mainWindow && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send("token-vault:connected", {});
          }
        } else {
          log.warn("Auth0 callback: missing tokens", data);
        }
      }).catch((err) => log.error("Auth0 callback error:", err));
    }
    return;
  }

  // Handle OAuth callback: atlarix://auth/callback#access_token=...&refresh_token=...
  // Supabase OAuth returns tokens in hash fragment, not query params
  if (parsed.hostname === "auth" || parsed.pathname.startsWith("/auth/callback")) {
    // Supabase sends tokens in hash fragment: #access_token=xxx&refresh_token=yyy
    // We need to pass the full URL to SubscriptionManager for parsing
    log.log("Handling Supabase OAuth callback");
    log.log("OAuth callback URL has hash:", url.includes('#'));

    // Import dynamically to avoid circular dependencies
    import('./lib/SubscriptionManager').then(async ({ SubscriptionManager }) => {
      log.log("SubscriptionManager imported, calling handleOAuthCallback");
      const result = await SubscriptionManager.handleOAuthCallback(url);
      log.log("handleOAuthCallback result:", { success: result.success, hasUser: !!result.user, hasError: !!result.error });

      if (result.error) {
        log.error("OAuth callback error:", result.error.message);
        dialog.showErrorBox("OAuth Error", result.error.message);
        return;
      }

      // Send success to renderer
      if (mainWindow) {
        log.log("Sending oauth-callback-success to renderer, user:", result.user?.email);
        mainWindow.webContents.send("oauth-callback-success", {
          user: result.user,
        });
      } else {
        log.error("MainWindow is null, cannot send oauth-callback-success!");
      }

      log.log("OAuth callback handled successfully");
    }).catch(err => {
      log.error("Failed to handle OAuth callback:", err);
      dialog.showErrorBox("OAuth Error", "Failed to process authentication");
    });
    return;
  }

  // TODO: Phase 4.5 - Removed Neon/Supabase OAuth (deleted integrations)
  // If you need these later, rebuild oauth.atlarix.dev service

  // atlarix://pro-return?key=123
  if (parsed.hostname === "pro-return") {
    const apiKey = parsed.searchParams.get("key");
    if (!apiKey) {
      dialog.showErrorBox("Invalid URL", "Expected key");
      return;
    }
    handleAtlarixProReturn({
      apiKey,
    });
    // Send message to renderer to trigger re-render
    mainWindow?.webContents.send("deep-link-received", {
      type: parsed.hostname,
    });
    return;
  }
  // dyad://add-mcp-server?name=Chrome%20DevTools&config=eyJjb21tYW5kIjpudWxsLCJ0eXBlIjoic3RkaW8ifQ%3D%3D
  if (parsed.hostname === "add-mcp-server") {
    const name = parsed.searchParams.get("name");
    const config = parsed.searchParams.get("config");
    if (!name || !config) {
      dialog.showErrorBox("Invalid URL", "Expected name and config");
      return;
    }

    try {
      const decodedConfigJson = atob(config);
      const decodedConfig = JSON.parse(decodedConfigJson);
      const parsedConfig = AddMcpServerConfigSchema.parse(decodedConfig);

      mainWindow?.webContents.send("deep-link-received", {
        type: parsed.hostname,
        payload: {
          name,
          config: parsedConfig,
        } as AddMcpServerPayload,
      });
    } catch (error) {
      logger.error("Failed to parse add-mcp-server deep link:", error);
      dialog.showErrorBox(
        "Invalid MCP Server Configuration",
        "The deep link contains malformed configuration data. Please check the URL and try again.",
      );
    }
    return;
  }
  // dyad://add-prompt?data=<base64-encoded-json>
  if (parsed.hostname === "add-prompt") {
    const data = parsed.searchParams.get("data");
    if (!data) {
      dialog.showErrorBox("Invalid URL", "Expected data parameter");
      return;
    }

    try {
      const decodedJson = atob(data);
      const decoded = JSON.parse(decodedJson);
      const parsedData = AddPromptDataSchema.parse(decoded);

      mainWindow?.webContents.send("deep-link-received", {
        type: parsed.hostname,
        payload: parsedData as AddPromptPayload,
      });
    } catch (error) {
      logger.error("Failed to parse add-prompt deep link:", error);
      dialog.showErrorBox(
        "Invalid Prompt Data",
        "The deep link contains malformed data. Please check the URL and try again.",
      );
    }
    return;
  }
  dialog.showErrorBox("Invalid deep link URL", url);
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Only set isRunning to false when the app is properly quit by the user
app.on("will-quit", () => {
  logger.info("App is quitting, setting isRunning to false");
  analyticsShutdown();

  // Stop performance monitoring and capture final metrics
  stopPerformanceMonitoring();

  // Clear all session memories
  clearAllSessionMemories();

  writeSettings({ isRunning: false });
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  // Only create window when app is ready (activate can fire before ready on macOS).
  if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
