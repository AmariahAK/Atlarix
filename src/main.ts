import "./preload-env";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, powerMonitor, shell, type MenuItemConstructorOptions } from "electron";
import * as path from "node:path";
import dotenv from "dotenv";
// @ts-ignore
import started from "electron-squirrel-startup";
import { autoUpdater } from "electron-updater";
import log from "electron-log";
import {
  getSettingsFilePath,
  readSettings,
  writeSettings,
} from "./main/settings";
import { handleAtlarixProReturn } from "./main/pro";
import { IS_TEST_BUILD } from "./ipc/utils/test_utils";
import {
  isNewer,
  shouldRunNotifyOnlyCheck,
  canElectronUpdaterRun,
  type UpdateStatus,
} from "./main/update-helpers";
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
import { capture as analyticsCapture, shutdown as analyticsShutdown } from "./main/lib/analytics";
import { SENTRY_DSN } from "./main/sentry-config";
import * as Sentry from "@sentry/electron/main";
import { sentryBeforeSendDropExpected } from "./lib/sentry-before-send";
import { SENTRY_IGNORE_ERROR_PATTERNS } from "./lib/sentry-ignore-patterns";
import fs from "fs";
import { execSync } from "node:child_process";
import os from "node:os";
import { restoreAuthSessionOnStartup } from "./lib/auth/supabase-client";
import { SubscriptionManager } from "./lib/SubscriptionManager";
import { resolveSystemPath } from "./lib/resolve-path";
import { warmOpenRouterModelCache } from "./lib/routing/tier-context-limits";
import { warmCoreModelOverrides } from "./lib/routing/core-model-overrides";
import { seedEphemeralCounterFromSessions } from "./ipc/handlers/workspace_session_handlers";
import { isNoUsableModelOutputError } from "./ipc/utils/no_usable_model_output";
import { isStreamStopAbort } from "./lib/stream/stream-stop-sentinels";
import {
  openWorkspaceFromCliPath,
  parseDirectoryArgFromArgv,
} from "./main/open_workspace_from_cli";
import { registerWorkspaceWindowIpc } from "./main/workspace_window_ipc";
import { registerIpcHandlers } from "./ipc/ipc_host";
import { killAllPtys } from "./lib/pty/pty-session-manager";
import { __setDevCoreKeyProvider } from "./ipc/shared/compass_constants";
import { getDevCoreApiKey, getDevCoreModelId } from "./ipc/utils/dev_core_env";

// Silence EPIPE: when stdout/stderr is closed (e.g. parent shell terminated),
// `console.log` raises EPIPE asynchronously. electron-log's default catcher
// would then log the error AND show a dialog — and the log write itself hits
// the same dead pipe, recursing. Returning false skips both for EPIPE only;
// every other uncaught error still hits the normal log+dialog path.
log.errorHandler.startCatching({
  onError: ({ error }) => {
    if ((error as NodeJS.ErrnoException)?.code === "EPIPE") return false;
    return undefined;
  },
});
log.eventLogger.startLogging();
log.scope.labelPadding = false;

const logger = log.scope("main");

process.on("unhandledRejection", (reason: unknown) => {
  if (isNoUsableModelOutputError(reason)) {
    logger.warn(
      "[main] Swallowed unhandled AI empty-output error (handled upstream or benign flush):",
      reason,
    );
    return;
  }
  // v13.3 (ai@6): intentional stream-stop aborts (ask_user end-turn, loop
  // guard, …) reject detached SDK promises with the abort reason after the
  // turn has already finalized — benign by construction.
  if (isStreamStopAbort(reason)) {
    logger.warn(
      "[main] Swallowed post-finalization stream-stop abort rejection:",
      reason,
    );
    return;
  }
  logger.error("[main] Unhandled rejection:", reason);
});

// Without this handler an uncaught error (a native-addon throw, or a JS error
// raised outside any promise) reaches the native runtime and triggers
// std::terminate() → a hard abort that crashes the window and loses the user's
// work (seen as fatal minidumps in Sentry). Catch it, report it, and keep the
// app alive — mirrors the unhandledRejection policy above. Sentry still applies
// the v12.7 ignoreErrors/beforeSend filters, so benign families stay dropped.
process.on("uncaughtException", (error: unknown) => {
  if (isNoUsableModelOutputError(error)) {
    logger.warn(
      "[main] Swallowed uncaught AI empty-output error (handled upstream or benign):",
      error,
    );
    return;
  }
  if (isStreamStopAbort(error)) {
    logger.warn(
      "[main] Swallowed post-finalization stream-stop abort:",
      error,
    );
    return;
  }
  logger.error("[main] Uncaught exception:", error);
  if (SENTRY_DSN) {
    try {
      Sentry.captureException(error, { level: "fatal" });
    } catch {
      /* never let the reporter itself crash the process */
    }
  }
  // Intentionally do NOT process.exit() — converting the hard abort into a
  // reported, survivable error keeps the session going.
});
// .env loaded in ./preload-env (must run before other modules read process.env)
dotenv.config();
resolveSystemPath();

// Sentry: init in main process before app.whenReady(); DSN from env or fallback for packaged app
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    release: app.getVersion(),
    tracesSampleRate: 1.0,
    ignoreErrors: SENTRY_IGNORE_ERROR_PATTERNS,
    beforeSend: sentryBeforeSendDropExpected,
  });
}

// Mitigate GPU SharedImageManager::ProduceSkia errors (Chromium/Electron). This
// only manifests on Linux/Windows GPU stacks; macOS doesn't hit it, so keep the
// GPU sandbox enabled there (it's a real hardening layer). `ATLARIX_DISABLE_GPU_SANDBOX`
// forces it off everywhere for users who still see the bug on macOS.
if (process.platform !== "darwin" || process.env.ATLARIX_DISABLE_GPU_SANDBOX === "1") {
  app.commandLine.appendSwitch("disable-gpu-sandbox");
}
app.commandLine.appendSwitch("disable-software-rasterizer");
// Raise V8 old-space ceiling before Chromium hits partition_alloc hard OOM on heavy renderer work
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096");

// Swallow EPIPE on stdout/stderr — happens when the app's parent shell closes
// the pipe before electron-log finishes flushing during shutdown. Anything
// other than EPIPE still throws so we don't hide real I/O errors.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EPIPE") throw err;
});
process.stderr.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EPIPE") throw err;
});

// Register IPC handlers before app is ready
registerIpcHandlers();
registerWorkspaceWindowIpc();

// DEV-ONLY: let an unpackaged/dev build read Atlarix Core creds from the local
// shell env so the Core auto-fallback is exercisable without a CI-signed build.
// No-op in a packaged release (app.isPackaged === true → providers return undefined).
__setDevCoreKeyProvider({
  apiKey: getDevCoreApiKey,
  modelId: getDevCoreModelId,
});

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  logger.warn(
    "electron-squirrel-startup: installer flow; exiting without starting the app.",
  );
  app.quit();
}

/** v11: system git only (dugite removed). A bundled git in resources (E2E /
 * ATLARIX_BUNDLE_GIT=1 builds) is still honored via LOCAL_GIT_DIRECTORY. */
function configureGitEnvironment(): void {
  try {
    execSync("git --version", { stdio: "ignore" });
    logger.info("[git] Using system git from PATH");
    return;
  } catch {
    const bundled = app.isPackaged
      ? path.join(process.resourcesPath, "git")
      : null;
    if (bundled && fs.existsSync(bundled)) {
      process.env.LOCAL_GIT_DIRECTORY = bundled;
      logger.info("[git] Using bundled git from resources");
    } else {
      logger.warn(
        "[git] No system git found — git features disabled. Install Git (macOS: `xcode-select --install`) to enable them.",
      );
    }
  }
}

configureGitEnvironment();

app.on("child-process-gone", (_event, details) => {
  logger.error("[crash] child-process-gone", details);
  if (SENTRY_DSN) {
    Sentry.captureMessage(`child-process-gone:${details.type}`, {
      level: details.type === "GPU" ? "fatal" : "error",
      tags: {
        processType: details.type,
        reason: details.reason,
        exitCode: String(details.exitCode),
      },
    });
  }
});

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
  logger.info("main onReady started", { packaged: app.isPackaged });
  try {
    const backupManager = new BackupManager({
      settingsFile: getSettingsFilePath(),
      dbFile: getDatabasePath(),
    });
    await backupManager.initialize();
  } catch (e) {
    logger.error("Error initializing backup manager", e);
  }

  try {
    await restoreAuthSessionOnStartup();
    await SubscriptionManager.initialize();
  } catch (e) {
    logger.warn("Auth session restore or subscription init (non-fatal):", e);
  }

  // If user deferred an update on last session, install it silently on this cold start.
  const deferFlagPath = path.join(app.getPath("userData"), "atlarix-pending-update.json");
  if (fs.existsSync(deferFlagPath)) {
    try { fs.unlinkSync(deferFlagPath); } catch { /* ignore */ }
    log.info("[AutoUpdater] Deferred update flag found — checking for update on cold start");
    autoUpdater.once("update-downloaded", () => {
      autoUpdater.quitAndInstall();
    });
    autoUpdater.checkForUpdates().catch((err) => {
      log.warn("[AutoUpdater] Cold-start deferred check failed:", err?.message ?? err);
    });
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

  // Seed the ephemeral transport counter below all persisted session ids BEFORE
  // any session/transport can be allocated, so a new session can never reuse a
  // prior session's chatId (which leaked pending ask_user questions across
  // sessions). Best-effort; never blocks startup fatally.
  await seedEphemeralCounterFromSessions();
  sendDbReadyToWindow();

  // Self-heal a previously-installed launcher that predates the TTY-detach fix.
  void import("./ipc/handlers/cli_handlers").then((m) =>
    m.refreshCliLauncherIfStale(),
  );

  const cliDir = parseDirectoryArgFromArgv(process.argv, process.cwd());
  if (cliDir) {
    void openWorkspaceFromCliPath(cliDir);
  }

  app.on("browser-window-focus", () => {
    void import("./ipc/utils/workspace_path_status_broadcast").then((m) =>
      m.broadcastWorkspacePathStatusesIfChanged(),
    );
  });

  // Power events. `prevent-app-suspension` (held while a stream runs, see
  // power-blocker.ts) keeps us alive when the *display* sleeps; a full system
  // suspend (e.g. lid close) can still pause/kill us — so flush in-flight
  // partial assistant output before the OS suspends so work isn't lost.
  powerMonitor.on("suspend", () => {
    logger.info("[power] system suspend — flushing in-flight partial streams");
    void (async () => {
      try {
        const { flushPartialStreamsForShutdown } = await import(
          "./ipc/handlers/chat_stream_handlers"
        );
        await flushPartialStreamsForShutdown();
      } catch (e) {
        logger.warn("[power] partial flush on suspend failed:", e);
      }
    })();
  });
  powerMonitor.on("resume", () => {
    logger.info("[power] system resume");
  });

  // Pass 7.3: OpenTelemetry init removed (heavy main-bundle dep, startup crash on packaged builds).

  // Runtime Core model overrides (hosted core-models.json). Sync-preloads the
  // disk cache so the warm below + the first stream see last-known-good ids, then
  // refreshes from the network in the background. Must run before the cache warm.
  warmCoreModelOverrides();

  // Warm the OpenRouter model catalog so per-model context limits resolve via
  // `resolveModelContextLimit` without a cold first turn.
  void warmOpenRouterModelCache().catch(() => {
    /* best-effort */
  });

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
  // Activation-funnel entry point (top of funnel).
  analyticsCapture("app_opened", {
    version: app.getVersion(),
    platform: process.platform,
  });

  logger.info("Auto-update enabled=", settings.enableAutoUpdate);
  // Status IPC is registered regardless of the toggle so the Settings panel and
  // a manual "Check now" always work, even with auto-update off.
  registerUpdateStatusIpc();
  if (settings.enableAutoUpdate) {
    initAutoUpdater();
  }

  // Notify-only GitHub check is a BRIDGE for installs electron-updater can't
  // silently update (deb/rpm, mac-not-in-/Applications, feed failure). When the
  // real updater is active it would only double-fire a confusing banner, so we
  // suppress it there.
  setTimeout(() => {
    if (
      shouldRunNotifyOnlyCheck({
        isPackaged: app.isPackaged,
        electronUpdaterActive,
      })
    ) {
      void checkForUpdatesNotify();
    }
  }, 5000);
}

const ATLARIX_RELEASES_API =
  "https://api.github.com/repos/AmariahAK/atlarix-releases/releases/latest";

const UPDATE_RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h — long-running sessions

/** True once electron-updater is wired and able to drive a silent update. */
let electronUpdaterActive = false;
let updateRecheckTimer: ReturnType<typeof setInterval> | null = null;

const updateStatus: UpdateStatus = {
  currentVersion: "",
  lastCheckAt: null,
  lastResult: "idle",
};

/** Merge into the in-memory status and push it to the renderer (Settings panel). */
function setUpdateStatus(partial: Partial<UpdateStatus>): void {
  Object.assign(updateStatus, partial);
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("update:status", { ...updateStatus });
  }
}

/** IPC: live status + a manual "Check for updates now". Always registered. */
function registerUpdateStatusIpc(): void {
  updateStatus.currentVersion = app.getVersion();
  ipcMain.handle("update:get-status", () => ({ ...updateStatus }));
  ipcMain.handle("update:check-now", async () => {
    setUpdateStatus({ lastResult: "checking", detail: undefined });
    try {
      if (electronUpdaterActive) {
        await autoUpdater.checkForUpdates();
      } else {
        await checkForUpdatesNotify();
        // checkForUpdatesNotify sets 'available' or stays put; reflect a check ran.
        if (updateStatus.lastResult === "checking") {
          setUpdateStatus({ lastResult: "up-to-date", lastCheckAt: Date.now() });
        }
      }
    } catch (err) {
      setUpdateStatus({
        lastResult: "error",
        detail: err instanceof Error ? err.message : String(err),
        lastCheckAt: Date.now(),
      });
    }
    return { ...updateStatus };
  });
}

/**
 * Notify-only update check (all platforms). Complements electron-updater silent install.
 */
async function checkForUpdatesNotify(): Promise<void> {
  if (IS_TEST_BUILD) return;
  try {
    const currentVersion = app.getVersion();
    const res = await fetch(ATLARIX_RELEASES_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Atlarix" },
    });
    if (!res.ok) {
      log.warn(`[UpdateNotify] GitHub API ${res.status}`);
      return;
    }
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    const latestVersion = (data.tag_name ?? "").replace(/^v/, "");
    if (!latestVersion || !isNewer(latestVersion, currentVersion)) {
      log.info(
        `[UpdateNotify] up to date (current=${currentVersion}, latest=${latestVersion || "n/a"})`,
      );
      setUpdateStatus({ lastResult: "up-to-date", lastCheckAt: Date.now() });
      return;
    }
    const releaseUrl =
      data.html_url ?? "https://github.com/AmariahAK/atlarix-releases/releases/latest";
    log.info(`[UpdateNotify] Update available: ${latestVersion} (current ${currentVersion})`);
    setUpdateStatus({
      lastResult: "available",
      availableVersion: latestVersion,
      lastCheckAt: Date.now(),
      detail: updateStatus.detail, // preserve an /Applications/unsupported hint if set
    });
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("update:available", {
        currentVersion,
        latestVersion,
        releaseUrl,
      });
    }
  } catch (err) {
    log.warn("[UpdateNotify] check failed:", (err as Error)?.message ?? err);
    setUpdateStatus({
      lastResult: "error",
      detail: (err as Error)?.message ?? String(err),
      lastCheckAt: Date.now(),
    });
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
 * Silent background auto-updater using electron-updater.
 * Checks GitHub releases at AmariahAK/atlarix-releases for latest.yml.
 * Shows a restart dialog when an update has downloaded.
 */
function initAutoUpdater(): void {
  // Route electron-updater logs through electron-log so update history is traceable.
  autoUpdater.logger = log;

  // Can electron-updater actually drive a silent update for THIS install? On
  // macOS it must live in /Applications; deb/rpm and dev builds can't.
  const isAppImage = Boolean(process.env.APPIMAGE);
  const capability = canElectronUpdaterRun({
    platform: process.platform,
    isPackaged: app.isPackaged,
    isAppImage,
    isInApplicationsFolder:
      process.platform !== "darwin" || safeIsInApplicationsFolder(),
  });
  if (!capability.ok) {
    // Surface WHY rather than silently no-op'ing, then let the notify-only
    // bridge (gated separately) point the user at a manual download.
    if (capability.reason) {
      setUpdateStatus({ lastResult: capability.reason, detail: capability.detail });
    }
    log.info(`[AutoUpdater] electron-updater inactive: ${capability.detail ?? "n/a"}`);
    // deb/rpm: still offer a native notification with the release page.
    if (process.platform === "linux" && app.isPackaged && !isAppImage) {
      void checkLinuxPackageUpdate();
    }
    return;
  }

  // Point at the separate releases repo (not the source repo).
  // Wrap in try/catch to gracefully handle missing app-update.yml in packaged builds.
  try {
    autoUpdater.setFeedURL({
      provider: "github",
      owner: "AmariahAK",
      repo: "atlarix-releases",
      releaseType: "release",
    });
  } catch (err: unknown) {
    log.warn("[AutoUpdater] setFeedURL failed:", err instanceof Error ? err.message : String(err));
    setUpdateStatus({
      lastResult: "error",
      detail: err instanceof Error ? err.message : String(err),
    });
    // Skip update check gracefully - never throw to user
    return;
  }

  electronUpdaterActive = true;

  // Allow pre-releases to be downloaded if they are published (matches existing releaseChannel behavior).
  autoUpdater.allowPrerelease = false;
  autoUpdater.autoDownload = true;

  autoUpdater.on("checking-for-update", () => {
    log.info("[AutoUpdater] Checking for update…");
    setUpdateStatus({ lastResult: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    log.info("[AutoUpdater] Update available:", info.version);
    setUpdateStatus({
      lastResult: "downloading",
      availableVersion: info.version,
      lastCheckAt: Date.now(),
    });
    // Send a subtle in-app notice to the renderer so the user knows a download is happening.
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("update:downloading", { version: info.version });
    }
  });

  autoUpdater.on("update-not-available", (info) => {
    log.info("[AutoUpdater] Up to date:", info.version);
    setUpdateStatus({ lastResult: "up-to-date", lastCheckAt: Date.now() });
  });

  autoUpdater.on("download-progress", (progress) => {
    log.info(`[AutoUpdater] Download progress: ${Math.round(progress.percent)}%`);
    setUpdateStatus({ lastResult: "downloading" });
  });

  autoUpdater.on("update-downloaded", (info) => {
    log.info("[AutoUpdater] Update downloaded:", info.version);
    setUpdateStatus({
      lastResult: "downloaded",
      availableVersion: info.version,
      lastCheckAt: Date.now(),
    });
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("update:downloaded", { version: info.version });
    }
  });

  autoUpdater.on("error", (err) => {
    log.error("[AutoUpdater] Error:", err?.message ?? err);
    // Record it so the Settings panel can show WHY — previously swallowed.
    setUpdateStatus({
      lastResult: "error",
      detail: err?.message ?? String(err),
      lastCheckAt: Date.now(),
    });
  });

  // Kick off the check. Errors are caught by the 'error' event handler above.
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    log.warn("[AutoUpdater] checkForUpdatesAndNotify failed:", err?.message ?? err);
  });

  // Periodic re-check so a long-running session still updates (Cursor-style).
  if (!updateRecheckTimer) {
    updateRecheckTimer = setInterval(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        log.warn("[AutoUpdater] periodic re-check failed:", err?.message ?? err);
      });
    }, UPDATE_RECHECK_INTERVAL_MS);
  }

  // IPC: renderer requests immediate install
  ipcMain.handle("update:install-now", () => {
    autoUpdater.quitAndInstall();
  });

  // IPC: renderer defers install to next cold start
  ipcMain.handle("update:defer", () => {
    const flagPath = path.join(app.getPath("userData"), "atlarix-pending-update.json");
    fs.writeFileSync(flagPath, JSON.stringify({ deferred: true, timestamp: Date.now() }));
    log.info("[AutoUpdater] Update deferred to next launch");
  });
}

async function checkLinuxPackageUpdate(): Promise<void> {
  try {
    const currentVersion = app.getVersion();
    const res = await fetch("https://api.github.com/repos/AmariahAK/atlarix-releases/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    });

    if (!res.ok) {
      log.warn(`[AutoUpdater:linux-pkg] GitHub API ${res.status}`);
      return;
    }

    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    const latest = (data.tag_name ?? "").replace(/^v/, "");

    if (!latest || !isNewer(latest, currentVersion)) {
      log.info(
        `[AutoUpdater:linux-pkg] up to date (current=${currentVersion}, latest=${latest || "n/a"})`,
      );
      return;
    }

    log.info(`[AutoUpdater:linux-pkg] Update available: ${latest} (current ${currentVersion})`);
    const releaseUrl =
      data.html_url ?? "https://github.com/AmariahAK/atlarix-releases/releases/latest";

    const n = new Notification({
      title: `Atlarix ${latest} is available`,
      body: "Click to download the matching .deb or .rpm.",
      silent: false,
    });
    n.on("click", () => {
      void shell.openExternal(releaseUrl);
    });
    n.show();
  } catch (err) {
    log.warn("[AutoUpdater:linux-pkg] check failed:", (err as Error)?.message ?? err);
  }
}

/** `app.isInApplicationsFolder()` throws off-darwin; guard it. */
function safeIsInApplicationsFolder(): boolean {
  try {
    return app.isInApplicationsFolder();
  } catch {
    return false;
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
let pendingDeepLinkUrl: string | null = extractDeepLinkUrl(process.argv);

function extractDeepLinkUrl(argv: string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith("atlarix://")) {
      return arg;
    }
  }
  return null;
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function queueOrHandleDeepLink(url: string) {
  if (mainWindow?.webContents?.isLoading()) {
    pendingDeepLinkUrl = url;
    return;
  }
  handleDeepLinkReturn(url);
}

function sendDbReadyToWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("db-ready");
  }
}

function setMainApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Community",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("open-community-dialog");
            }
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
      /** Required for Chromium's PDF viewer extension (blob: / file: PDFs in iframes, etc.). */
      plugins: true,
      // transparent: true,
    },
    // backgroundColor: "#00000001",
    // frame: false,
  });

  // Open external links (target="_blank", window.open, in-chat result links) in
  // the user's system browser instead of spawning a blank Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, "../renderer/main_window/index.html"),
    );
  }
  // DevTools can generate noisy Chromium protocol console errors in dev.
  // Only open them when explicitly requested.
  if (process.env.NODE_ENV === "development" && process.env.OPEN_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools();
  }

  // Send force-close event if it was detected; also send db-ready when window loads (in case DB was ready before load)
  mainWindow.webContents.once("did-finish-load", () => {
    sendDbReadyToWindow();
    broadcastFullscreen();
    broadcastSystemTheme();
    if (pendingForceCloseData) {
      mainWindow?.webContents.send("force-close-detected", {
        performanceData: pendingForceCloseData,
      });
      pendingForceCloseData = null;
    }
    if (pendingDeepLinkUrl) {
      const url = pendingDeepLinkUrl;
      pendingDeepLinkUrl = null;
      handleDeepLinkReturn(url);
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
        { type: "separator" as const },
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
          { type: "separator" as const },
          {
            type: "submenu",
            label: `Correct "${params.misspelledWord}"`,
            submenu: suggestions,
          },
        );
      }
      template.push({ type: "separator" as const }, { role: "selectAll" });
    } else {
      if (params.selectionText && params.selectionText.length > 0) {
        template.push({ role: "copy" });
      }
      template.push({ role: "selectAll" });
    }

    if (process.env.NODE_ENV === "development") {
      template.push(
        { type: "separator" as const },
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

  setMainApplicationMenu();

  // Fix: Finding 1 — sync fullscreen to renderer for hit-testing / CSS
  const broadcastFullscreen = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const fs = mainWindow.isFullScreen();
    mainWindow.webContents.send("window:fullscreen-changed", { fullscreen: fs });
    if (process.platform === "darwin" && !fs) {
      try {
        mainWindow.setWindowButtonPosition({ x: 10, y: 8 });
      } catch {
        /* optional */
      }
    }
  };
  mainWindow.on("enter-full-screen", broadcastFullscreen);
  mainWindow.on("leave-full-screen", broadcastFullscreen);

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logger.error("[crash] render-process-gone", details);
    if (SENTRY_DSN) {
      Sentry.captureMessage("render-process-gone", {
        level: "fatal",
        tags: {
          reason: details.reason,
          exitCode: String(details.exitCode),
        },
      });
    }
  });

  mainWindow.on("unresponsive", () => {
    logger.warn("[crash] main window unresponsive");
    if (SENTRY_DSN) {
      Sentry.addBreadcrumb({
        category: "window",
        message: "unresponsive",
        level: "warning",
      });
    }
  });

  mainWindow.on("responsive", () => {
    logger.info("[crash] main window responsive again");
  });
};

function broadcastSystemTheme(): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("theme:system-updated", {
    systemTheme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
  });
}

nativeTheme.on("updated", () => {
  broadcastSystemTheme();
});

// Packaged app: single instance only. In dev, skip the lock so a second `npm start`
// or Forge helper process does not exit immediately without onReady (confusing "crash").
const singleInstanceData = { argv: process.argv, cwd: process.cwd() };
const gotTheLock = app.isPackaged
  ? app.requestSingleInstanceLock(singleInstanceData)
  : true;

if (!gotTheLock) {
  logger.warn(
    "Single-instance lock not acquired — another Atlarix copy is already running. Exiting this process.",
  );
  app.quit();
} else {
  if (app.isPackaged) {
    app.on(
      "second-instance",
      (_event, commandLine, workingDirectory, additionalData) => {
        // Someone tried to run a second instance, we should focus our window.
        focusMainWindow();
        const url = extractDeepLinkUrl(commandLine);
        if (url) {
          queueOrHandleDeepLink(url);
        }
        const payload = additionalData as
          | { argv?: string[]; cwd?: string }
          | undefined;
        const argv = payload?.argv?.length ? payload.argv : commandLine;
        const cwd = payload?.cwd ?? workingDirectory;
        const cliDir = parseDirectoryArgFromArgv(argv, cwd);
        if (cliDir) {
          void openWorkspaceFromCliPath(cliDir);
        }
      },
    );
  }
  app.whenReady().then(() => {
    void onReady().catch((err: unknown) => {
      logger.error("onReady failed:", err);
      dialog.showErrorBox(
        "Startup failed",
        err instanceof Error ? err.message : String(err),
      );
      app.quit();
    });
  });
}

// macOS: open folder via dock drop or `open -a Atlarix /path`
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  focusMainWindow();
  try {
    if (fs.statSync(filePath).isDirectory()) {
      void openWorkspaceFromCliPath(filePath);
    }
  } catch {
    /* ignore */
  }
});

// Handle the protocol. On macOS, deep links come through open-url event
app.on("open-url", (event, url) => {
  event.preventDefault(); // Prevent trying to open a new instance

  // Focus existing window
  focusMainWindow();
  queueOrHandleDeepLink(url);
});

function handleDeepLinkReturn(url: string) {
  // Deep-link URLs can carry OAuth secrets in the hash/query
  // (#access_token=…, ?code=…), which persist in electron-log files — never
  // log the full URL. Structural flags only.
  log.log("=== DEEP LINK RECEIVED ===");
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
      `Expected atlarix://, got ${parsed.protocol}.`,
    );
    return;
  }

  // Pass 7: Legacy Auth deep-link branch removed. Workforce credentials are
  // provisioned per MCP via the marketplace install flow (env vars stored
  // directly in `mcp_servers.env_json`), so the `atlarix://auth0/callback`
  // protocol path is no longer used.

  // MCP OAuth deep-link fallback (active path is loopback in mcp-oauth-service):
  // atlarix://mcp/oauth/callback?code=...&state=...
  if (
    parsed.hostname === "mcp" &&
    parsed.pathname.startsWith("/oauth/callback")
  ) {
    import("./ipc/handlers/mcp_oauth_handlers").then(
      async ({ handleMcpOAuthDeepLink }) => {
        await handleMcpOAuthDeepLink(url);
      },
    ).catch((err) => {
      log.error("Failed to handle MCP OAuth callback:", err);
    });
    return;
  }

  // MCP OAuth callback: atlarix://mcp/oauth/callback?code=...&state=...
  if (
    parsed.hostname === "mcp" &&
    parsed.pathname.startsWith("/oauth/callback")
  ) {
    import("./ipc/handlers/mcp_oauth_handlers").then(
      async ({ handleMcpOAuthDeepLink }) => {
        await handleMcpOAuthDeepLink(url);
      },
    ).catch((err) => {
      log.error("Failed to handle MCP OAuth callback:", err);
    });
    return;
  }

  // MCP OAuth callback: atlarix://mcp/oauth/callback?code=...&state=...
  if (
    parsed.hostname === "mcp" &&
    parsed.pathname.startsWith("/oauth/callback")
  ) {
    import("./ipc/handlers/mcp_oauth_handlers").then(
      async ({ handleMcpOAuthDeepLink }) => {
        await handleMcpOAuthDeepLink(url);
      },
    ).catch((err) => {
      log.error("Failed to handle MCP OAuth callback:", err);
    });
    return;
  }

  // Handle OAuth callback: atlarix://auth/callback#access_token=...&refresh_token=...
  // Supabase OAuth returns tokens in hash fragment, not query params
  if (parsed.hostname === "auth" || parsed.pathname.startsWith("/auth/callback")) {
    // Cancel the 60s inbound-timeout fallback — deep link was received successfully.
    import('./lib/auth/supabase-client').then(({ cancelPendingOAuthTimeout }) => {
      cancelPendingOAuthTimeout();
    }).catch(() => { /* non-fatal */ });

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
  // atlarix://add-mcp-server?name=Chrome%20DevTools&config=eyJjb21tYW5kIjpudWxsLCJ0eXBlIjoic3RkaW8ifQ%3D%3D
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
  // atlarix://add-prompt?data=<base64-encoded-json>
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

// v5.0: Flush project memory snapshots on quit (session_end), then abort streams
let quittingAfterProjectMemoryFlush = false;
app.on("before-quit", (e) => {
  const mu = process.memoryUsage();
  if (quittingAfterProjectMemoryFlush) {
    logger.info("[lifecycle] before-quit reentry after flush/session work", {
      rss: mu.rss,
      heapUsed: mu.heapUsed,
    });
    return;
  }
  logger.info("[lifecycle] before-quit initiating flush+abortStreams", {
    rss: mu.rss,
    heapUsed: mu.heapUsed,
    heapTotal: mu.heapTotal,
    external: mu.external,
    arrayBuffers: mu.arrayBuffers,
  });
  e.preventDefault();
  quittingAfterProjectMemoryFlush = true;
  void (async () => {
    try {
    try {
      const { flushSessionEndSnapshots } = await import("./lib/project-memory/service");
      await flushSessionEndSnapshots();
    } catch (err) {
      logger.error("flushSessionEndSnapshots failed:", err);
    }
    // Persist in-flight partial assistant output BEFORE aborting, so an
    // interrupted turn is recoverable (shown with a Continue affordance).
    try {
      const { flushPartialStreamsForShutdown } = await import(
        "./ipc/handlers/chat_stream_handlers"
      );
      await flushPartialStreamsForShutdown();
    } catch (flushErr) {
      logger.warn("flushPartialStreamsForShutdown on quit:", flushErr);
    }
    try {
      const { abortAllStreams } = await import("./ipc/handlers/chat_stream_handlers");
      abortAllStreams();
    } catch (abortErr) {
      logger.warn("abortAllStreams on quit:", abortErr);
    }
    // v12 3.7: drain tracked state-mutating background work (self-correction
    // dispatch, snapshot writes, usage records) before the process dies.
    try {
      const { drainPendingWork } = await import("./lib/pending-work");
      await drainPendingWork();
    } catch (drainErr) {
      logger.warn("drainPendingWork on quit:", drainErr);
    }
    // v14 pt3: kill detached background commands (dev servers, watchers) so they
    // don't orphan after the app exits.
    try {
      const { killAllBackgroundJobs } = await import(
        "./lib/agent/background-commands"
      );
      killAllBackgroundJobs();
    } catch (bgErr) {
      logger.warn("killAllBackgroundJobs on quit:", bgErr);
    }
    try {
      const { shutdownAstGrepPool } = await import(
        "./lib/blueprint/rte/ast-grep/worker-pool"
      );
      await shutdownAstGrepPool();
    } catch (poolErr) {
      logger.warn("shutdownAstGrepPool on quit:", poolErr);
    }
    } catch (shutdownErr) {
      // Belt-and-suspenders: each step is individually guarded above, but if the
      // chain itself throws (e.g. a dynamic import fails), report it instead of
      // letting it become an uncaught fatal during quit.
      logger.error("[lifecycle] before-quit chain failed:", shutdownErr);
      if (SENTRY_DSN) {
        try {
          Sentry.captureException(shutdownErr, {
            level: "fatal",
            tags: { phase: "before-quit" },
          });
        } catch {
          /* noop */
        }
      }
    } finally {
      app.quit();
    }
  })();
});

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
  logger.info("App is quitting, setting isRunning to false", {
    memory: process.memoryUsage(),
  });
  // v10: tear down interactive terminal shells.
  killAllPtys();
  analyticsShutdown();

  // Stop the periodic update re-check.
  if (updateRecheckTimer) {
    clearInterval(updateRecheckTimer);
    updateRecheckTimer = null;
  }

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
