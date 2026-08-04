import "./preload-env";
import { app, autoUpdater as squirrelUpdater, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, powerMonitor, session, shell, type MenuItemConstructorOptions } from "electron";
import { updateElectronApp } from "update-electron-app";
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
  reEncryptPlaintextSecretsIfPossible,
} from "./main/settings";
import { handleAtlarixProReturn } from "./main/pro";
import { IS_TEST_BUILD } from "./ipc/utils/test_utils";
import {
  isNewer,
  shouldRunNotifyOnlyCheck,
  canElectronUpdaterRun,
  chooseUpdaterKind,
  type UpdateStatus,
} from "./main/update-helpers";
import { BackupManager } from "./backup_manager";
import { getDatabasePath, initializeDatabase, beginDatabaseClosing } from "./db/index";
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
import { startModelsDevRefresh } from "./lib/models_dev";
import {
  capture as analyticsCapture,
  shutdown as analyticsShutdown,
  trackActiveDay,
} from "./main/lib/analytics";
import { SENTRY_DSN } from "./main/sentry-config";
import * as Sentry from "@sentry/electron/main";
import { sentryBeforeSendDropExpected } from "./lib/sentry-before-send";
import { SENTRY_IGNORE_ERROR_PATTERNS } from "./lib/sentry-ignore-patterns";
import fs from "fs";
import { execSync } from "node:child_process";
import os from "node:os";
import { restoreAuthSessionOnStartup } from "./lib/auth/supabase-client";
import { markStartupAuthResolved } from "./lib/auth/startup-auth-state";
import { SubscriptionManager } from "./lib/SubscriptionManager";
import {
  closeActiveBrowserTabIfVisible,
  resolveBrowserScope,
} from "./ipc/utils/browser_view_manager";
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
import { cleanupOrphanedUserData } from "./main/startup/cleanup-orphaned-userdata";
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
    // A15/M-8: full tracing only in dev; sample down in packaged builds.
    tracesSampleRate: app.isPackaged ? 0.1 : 1.0,
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

/**
 * Packaged self-test (`--self-test`): exercise the real ship paths (node-pty
 * spawn, proxy-worker resolution from the asar, ripgrep) and exit BEFORE
 * any app lifecycle — no single-instance lock (which would collide with a
 * running copy and hang), no window, no GPU/DB. The probes need none of it.
 */
const IS_SELF_TEST =
  process.argv.includes("--self-test") || process.env.ATLARIX_SELF_TEST === "1";
if (IS_SELF_TEST) {
  void (async () => {
    try {
      const { runSelfTest } = await import("./main/self-test");
      const { code } = await runSelfTest();
      process.exit(code);
    } catch (e) {
      logger.error("self-test harness crashed:", e);
      process.exit(1);
    }
  })();
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

/**
 * A13/M-6: apply a Content-Security-Policy to the app's own file:// document.
 * The core protection is `script-src 'self'` — an injected inline script from an
 * XSS in rendered model/tool/web content cannot execute, which is what makes the
 * IPC bridge reachable (H-2). Packaged-only: the dev server needs
 * 'unsafe-inline'/'unsafe-eval' + ws: for HMR, and dev isn't a shipped surface.
 * Scoped to main/sub frames loaded from file:// so it constrains only the app
 * document (the in-app browser uses a separate `persist:atlarix-browser` session
 * and is unaffected). `style-src`/`connect-src` stay permissive enough not to
 * break the UI (Radix/framer inline styles, Supabase/Sentry/provider calls) —
 * TUNE against a packaged smoke-test before relying on it.
 */
function installContentSecurityPolicy(): void {
  if (!app.isPackaged) return;
  const csp = [
    "default-src 'self'",
    // 'wasm-unsafe-eval' lets on-device Whisper (onnxruntime-web) compile its
    // WASM backend; without it WebAssembly.instantiate is blocked in packaged
    // builds. It does NOT permit arbitrary JS eval (that's 'unsafe-eval').
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    // Allow OAuth provider avatars (GitHub / Google / Discord) — user profile pictures.
    "img-src 'self' data: blob: https://avatars.githubusercontent.com https://*.googleusercontent.com https://cdn.discordapp.com",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self' https: wss:",
    "frame-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const isAppDocument =
      (details.resourceType === "mainFrame" || details.resourceType === "subFrame") &&
      /^file:\/\//i.test(details.url);
    if (!isAppDocument) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      if (/^content-security-policy$/i.test(key)) delete headers[key];
    }
    headers["Content-Security-Policy"] = [csp];
    callback({ responseHeaders: headers });
  });
}

/**
 * Grant microphone access for on-device voice dictation. Electron denies `media`
 * by default unless a handler grants it; the app's content is local/trusted
 * (file://), so we grant media and preserve the permissive default for the rest.
 */
function configureMediaPermissions(): void {
  session.defaultSession.setPermissionRequestHandler(
    (_wc, permission, callback) => {
      callback(true);
    },
  );
}

export async function onReady() {
  logger.info("main onReady started", { packaged: app.isPackaged });
  installContentSecurityPolicy();
  configureMediaPermissions();
  try {
    const backupManager = new BackupManager({
      settingsFile: getSettingsFilePath(),
      dbFile: getDatabasePath(),
    });
    await backupManager.initialize();
  } catch (e) {
    logger.error("Error initializing backup manager", e);
  }

  // NOTE: auth/subscription init deliberately does NOT run here — see the
  // deferred block after createWindow(). Keep it that way.

  // If user deferred an update on last session, install it silently once this
  // session's download completes. We only RECORD the intent here — the actual
  // check/download is driven solely by initAutoUpdater() below (which sets the
  // feed URL first). Kicking off a second checkForUpdates() here (before the feed
  // is configured) raced the real flow and could leave it stuck mid-download.
  const deferFlagPath = path.join(app.getPath("userData"), "atlarix-pending-update.json");
  if (fs.existsSync(deferFlagPath)) {
    try { fs.unlinkSync(deferFlagPath); } catch { /* ignore */ }
    installDeferredUpdateOnDownload = true;
    log.info("[AutoUpdater] Deferred update flag found — will install once downloaded");
  }

  createWindow();

  /**
   * INVARIANT: window creation must NEVER await a network call.
   *
   * These two used to run BEFORE createWindow(). Both hit Supabase, neither was
   * timeboxed, and the surrounding try/catch caught nothing that mattered — a
   * hang is not an exception. Cleanly offline was survivable (DNS fails fast),
   * but on a black-hole network (captive portal, hotel wifi, VPN) each request
   * hung to the OS TCP timeout (~75s on macOS) and the session refresh retries
   * three times. That is minutes with NO WINDOW AT ALL, which users correctly
   * reported as "the app doesn't open".
   *
   * Deferred, so startup costs the same online and offline. Mirrors
   * `warmCoreModelOverrides`. The renderer mounts signed-out and is corrected by
   * `broadcastSessionState()` over the existing `plan-changed` channel once the
   * session actually resolves.
   *
   * The two calls stay sequential relative to EACH OTHER —
   * `SubscriptionManager.initialize()` documents that it runs after the session
   * restore. Only their relationship to createWindow() changed.
   */
  void (async () => {
    try {
      await restoreAuthSessionOnStartup({
        // Resolve and broadcast the account the moment the STORED session is read,
        // instead of after the token refresh. The refresh can spend seconds on
        // network backoff, and it only rotates a token — it never decides whether
        // the user is signed in, so making the UI wait for it was pure delay.
        onStoredSession: async () => {
          await SubscriptionManager.initialize();
          SubscriptionManager.broadcastSessionState();
        },
      });
      // Covers the paths the callback can't: no stored session at all, and the
      // post-refresh state. `initialize()` is memoized on `initPromise`, so when the
      // callback already ran this is a no-op — and the re-broadcast is what corrects
      // the UI if the refresh changed the plan.
      await SubscriptionManager.initialize();
      SubscriptionManager.broadcastSessionState();
    } catch (e) {
      logger.warn("Deferred auth init (non-fatal):", e);
    } finally {
      // Settled either way. Until this point the renderer cannot distinguish
      // "signed out" from "not known yet", so it holds a neutral account slot
      // instead of showing Sign in and then flipping to the account a few
      // seconds later. `finally`, because a failed restore is still an answer —
      // leaving the UI in limbo forever would be worse than showing signed out.
      markStartupAuthResolved();
      SubscriptionManager.broadcastSessionState();
    }
  })();

  // One-time removal of userData dirs orphaned by feature teardowns: the
  // pre-14.9.0 retrieval indexes (~1.4 GB) and the v14.16.0 browser session
  // recordings. Fire-and-forget — never blocks startup.
  void cleanupOrphanedUserData().catch((err) => {
    logger.warn("orphaned-userdata cleanup failed (non-fatal):", err);
  });

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
  // If it's stale but root-owned (unwritable), surface a one-click reinstall in
  // the renderer instead of silently leaving the broken TTY launcher in place.
  void import("./ipc/handlers/cli_handlers").then((m) => {
    const { needsManualUpdate } = m.refreshCliLauncherIfStale();
    if (
      needsManualUpdate &&
      mainWindow &&
      !mainWindow.webContents.isDestroyed()
    ) {
      mainWindow.webContents.send("cli:launcher-stale", {});
    }
  });

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

  // Recover interrupted automation runs, then arm every enabled automation
  // (cron schedules + deterministic pollers). Lazy import: keeps the runner
  // out of the boot-critical path.
  void import("./lib/automations/runner")
    .then((m) => m.startAutomationRunner())
    .catch((e) => logger.warn("Automation runner failed to start:", e));

  // Register workspace cleanup handlers
  registerCleanupHandlers();
  logger.info("Workspace cleanup handlers registered");

  // Start models.dev refresh (dynamic model catalog, OpenCode-style)
  startModelsDevRefresh();
  logger.info("Models.dev refresh started");

  await onFirstRunMaybe(settings);
  // Activation-funnel entry point (top of funnel). This used to fire alongside
  // a near-identical `app_launched`, so every launch was counted twice — one
  // event, one launch. `arch` folded in from the removed duplicate.
  analyticsCapture("app_opened", {
    version: app.getVersion(),
    platform: process.platform,
    arch: os.arch(),
  });
  // Retention signal: at most one per calendar day, so "did they come back"
  // stops depending on which other events happen to be instrumented.
  trackActiveDay();

  logger.info("Auto-update enabled=", settings.enableAutoUpdate);
  // Status IPC is registered regardless of the toggle so the Settings panel and
  // a manual "Check now" always work, even with auto-update off.
  registerUpdateStatusIpc();
  if (settings.enableAutoUpdate) {
    // Windows ships Squirrel installers → built-in autoUpdater via
    // update-electron-app; mac/Linux → electron-updater.
    const kind = chooseUpdaterKind({
      platform: process.platform,
      isPackaged: app.isPackaged,
      isAppImage: Boolean(process.env.APPIMAGE),
      isInApplicationsFolder:
        process.platform !== "darwin" || safeIsInApplicationsFolder(),
    });
    if (kind === "squirrel") {
      initWindowsAutoUpdater();
    } else {
      initAutoUpdater();
    }
  }

  // Notify-only GitHub check is a BRIDGE for installs no silent updater can drive
  // (deb/rpm, mac-not-in-/Applications, feed failure). When a real updater is
  // active it would only double-fire a confusing banner, so we suppress it there.
  setTimeout(() => {
    if (
      shouldRunNotifyOnlyCheck({
        isPackaged: app.isPackaged,
        electronUpdaterActive: activeUpdaterKind !== "none",
      })
    ) {
      void checkForUpdatesNotify();
    }
  }, 5000);
}

const ATLARIX_RELEASES_API =
  "https://api.github.com/repos/AmariahAK/atlarix-releases/releases/latest";

const UPDATE_RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h — long-running sessions

/** Which silent updater is driving this install: electron-updater (mac/Linux),
 * squirrel (Windows via update-electron-app), or none (notify-only handles it). */
let activeUpdaterKind: "electron-updater" | "squirrel" | "none" = "none";
let updateRecheckTimer: ReturnType<typeof setInterval> | null = null;
/** Set on cold start when the user deferred an update last session: install as
 * soon as this session finishes downloading it, instead of showing the banner. */
let installDeferredUpdateOnDownload = false;

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
      if (activeUpdaterKind === "squirrel") {
        squirrelUpdater.checkForUpdates();
      } else if (activeUpdaterKind === "electron-updater") {
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

  // Install / defer are registered here (not inside a platform-specific init) so
  // they work whichever updater is active. quitAndInstall targets the right one.
  ipcMain.handle("update:install-now", () => {
    if (activeUpdaterKind === "squirrel") {
      squirrelUpdater.quitAndInstall();
    } else {
      autoUpdater.quitAndInstall();
    }
  });

  ipcMain.handle("update:defer", () => {
    const flagPath = path.join(app.getPath("userData"), "atlarix-pending-update.json");
    fs.writeFileSync(flagPath, JSON.stringify({ deferred: true, timestamp: Date.now() }));
    log.info("[AutoUpdater] Update deferred to next launch");
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

  activeUpdaterKind = "electron-updater";

  // Allow pre-releases to be downloaded if they are published (matches existing releaseChannel behavior).
  autoUpdater.allowPrerelease = false;
  // Drive the download ourselves (see update-available) instead of auto-download:
  // with autoDownload the internal download promise is detached, so a failure
  // (e.g. the ENOENT app-update.yml bug) escaped as an UNHANDLED rejection and
  // never reached the 'error' handler — the banner stuck on "Downloading…". A
  // manual downloadUpdate() gives us a promise we can .catch() and surface.
  autoUpdater.autoDownload = false;
  // No .blockmap files are published (electron-forge's MakerZIP doesn't emit
  // them), so differential download has nothing to diff against. Leaving it on
  // makes electron-updater attempt a differential pass that can stall before
  // falling back; disable it so it always does a clean full download.
  autoUpdater.disableDifferentialDownload = true;

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
    // Start the download ourselves so its promise is caught. Any failure here
    // (missing app-update.yml, network, signature) becomes a visible 'error'
    // state instead of leaving the banner stuck on "Downloading…" forever.
    autoUpdater.downloadUpdate().catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      log.error("[AutoUpdater] downloadUpdate failed:", detail);
      setUpdateStatus({ lastResult: "error", detail, lastCheckAt: Date.now() });
    });
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
    // The user deferred this update last session — honor that by installing on
    // this cold start instead of prompting again.
    if (installDeferredUpdateOnDownload) {
      installDeferredUpdateOnDownload = false;
      log.info("[AutoUpdater] Installing deferred update now (quitAndInstall)");
      autoUpdater.quitAndInstall();
      return;
    }
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

  // Kick off the check. The download is started from the update-available handler
  // (autoDownload is off), so use plain checkForUpdates rather than
  // checkForUpdatesAndNotify. Errors surface via the 'error' handler above.
  autoUpdater.checkForUpdates().catch((err) => {
    log.warn("[AutoUpdater] checkForUpdates failed:", err?.message ?? err);
  });

  // Periodic re-check so a long-running session still updates (Cursor-style).
  if (!updateRecheckTimer) {
    updateRecheckTimer = setInterval(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        log.warn("[AutoUpdater] periodic re-check failed:", err?.message ?? err);
      });
    }, UPDATE_RECHECK_INTERVAL_MS);
  }
}

/**
 * Windows silent background auto-updater. Windows ships Squirrel.Windows
 * installers (electron-forge MakerSquirrel), which electron-updater cannot drive,
 * so we use Electron's built-in autoUpdater wired to update.electronjs.org via
 * update-electron-app. Events are mapped onto the SAME status/banner surface as
 * the electron-updater path. Note: the built-in updater emits no
 * 'download-progress', so the banner shows "Downloading…" without a percentage.
 */
function initWindowsAutoUpdater(): void {
  activeUpdaterKind = "squirrel";

  squirrelUpdater.on("checking-for-update", () => {
    log.info("[AutoUpdater] Checking for update…");
    setUpdateStatus({ lastResult: "checking" });
  });
  squirrelUpdater.on("update-available", () => {
    log.info("[AutoUpdater] Update available (squirrel)");
    setUpdateStatus({ lastResult: "downloading", lastCheckAt: Date.now() });
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("update:downloading", { version: "" });
    }
  });
  squirrelUpdater.on("update-not-available", () => {
    log.info("[AutoUpdater] Up to date (squirrel)");
    setUpdateStatus({ lastResult: "up-to-date", lastCheckAt: Date.now() });
  });
  // Built-in autoUpdater signature: (event, releaseNotes, releaseName, ...)
  squirrelUpdater.on("update-downloaded", (_e, _notes, releaseName) => {
    const version = typeof releaseName === "string" ? releaseName : "";
    log.info("[AutoUpdater] Update downloaded (squirrel):", version);
    setUpdateStatus({
      lastResult: "downloaded",
      availableVersion: version || undefined,
      lastCheckAt: Date.now(),
    });
    if (installDeferredUpdateOnDownload) {
      installDeferredUpdateOnDownload = false;
      log.info("[AutoUpdater] Installing deferred update now (quitAndInstall)");
      squirrelUpdater.quitAndInstall();
      return;
    }
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("update:downloaded", { version });
    }
  });
  squirrelUpdater.on("error", (err) => {
    log.error("[AutoUpdater] Error (squirrel):", err?.message ?? err);
    setUpdateStatus({
      lastResult: "error",
      detail: err?.message ?? String(err),
      lastCheckAt: Date.now(),
    });
  });

  // update-electron-app sets the built-in autoUpdater feed to update.electronjs.org
  // and checks on an interval. notifyUser:false so OUR banner drives the UX.
  // `repo` is explicit: package.json `repository` is the SOURCE repo, but the
  // installers live in the public atlarix-releases repo.
  try {
    updateElectronApp({
      repo: "AmariahAK/atlarix-releases",
      updateInterval: "1 hour",
      notifyUser: false,
      logger: log,
    });
  } catch (err) {
    log.error(
      "[AutoUpdater] update-electron-app init failed:",
      err instanceof Error ? err.message : String(err),
    );
    setUpdateStatus({
      lastResult: "error",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
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
    {
      // Custom File menu so Cmd/Ctrl+W closes the active BROWSER tab when the
      // browser panel is visible, else the OS-standard Close Window. Owning the
      // accelerator here (vs the default fileMenu role) avoids double-firing.
      label: "File",
      submenu: [
        {
          label: "Close",
          accelerator: "CmdOrCtrl+W",
          click: () => {
            // Cmd+W acts on the FOCUSED window's browser — closing another
            // window's tab because it happened to be first would be baffling.
            const focusedScope = resolveBrowserScope();
            if (
              !(focusedScope && closeActiveBrowserTabIfVisible(focusedScope)) &&
              mainWindow &&
              !mainWindow.isDestroyed()
            ) {
              mainWindow.close();
            }
          },
        },
        ...(isMac
          ? []
          : [{ type: "separator" as const }, { role: "quit" as const }]),
      ],
    },
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

  // Navigation lockdown (A4/H-2): the main frame must NEVER leave the packaged
  // app origin. Without this, a same-frame navigation (window.location, an
  // in-app <a> without target=_blank, a meta-refresh, or a form submit inside
  // rendered AI/tool/web content) could move the top frame to an attacker
  // origin that then inherits the context bridge. Same-origin app navigation and
  // dev-server HMR are allowed; an off-origin http(s) target opens externally.
  const isAppOriginUrl = (target: string): boolean => {
    try {
      const u = new URL(target);
      if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        return u.origin === new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin;
      }
      return u.protocol === "file:";
    } catch {
      return false;
    }
  };
  const guardNavigation = (
    e: Electron.Event,
    url: string,
    openExternally: boolean,
  ) => {
    if (isAppOriginUrl(url)) return;
    e.preventDefault();
    if (openExternally && /^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
  };
  mainWindow.webContents.on("will-navigate", (e, url) => guardNavigation(e, url, true));
  mainWindow.webContents.on("will-redirect", (e, url) => guardNavigation(e, url, false));

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

  // Idle-pause Supabase background activity (realtime keepalive + auth
  // auto-refresh) when the window is backgrounded for a while, so the app stops
  // pinging Supabase while the user isn't using it. Debounced (60s) so a quick
  // alt-tab doesn't churn the connection.
  let supabaseIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let supabaseBgPaused = false;
  const SUPABASE_IDLE_DELAY_MS = 60_000;
  const setAutoRefresh = (on: boolean) => {
    void import("./lib/auth/supabase-client")
      .then(({ getSupabaseClient }) => {
        try {
          const auth = getSupabaseClient().auth;
          if (on) auth.startAutoRefresh();
          else auth.stopAutoRefresh();
        } catch {
          /* not signed in / no creds — nothing to pause */
        }
      })
      .catch(() => {});
  };
  mainWindow.on("blur", () => {
    if (supabaseIdleTimer) clearTimeout(supabaseIdleTimer);
    supabaseIdleTimer = setTimeout(() => {
      supabaseIdleTimer = null;
      if (supabaseBgPaused) return;
      supabaseBgPaused = true;
      SubscriptionManager.pauseRealtime();
      setAutoRefresh(false);
    }, SUPABASE_IDLE_DELAY_MS);
  });
  mainWindow.on("focus", () => {
    if (supabaseIdleTimer) {
      clearTimeout(supabaseIdleTimer);
      supabaseIdleTimer = null;
    }
    if (!supabaseBgPaused) return;
    supabaseBgPaused = false;
    setAutoRefresh(true);
    void SubscriptionManager.resumeRealtime();
  });

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
// Under --self-test the probes run above and process.exit — never acquire the lock
// (it would collide with a running copy) or boot the app.
const singleInstanceData = { argv: process.argv, cwd: process.cwd() };
const gotTheLock = IS_SELF_TEST
  ? false
  : app.isPackaged
    ? app.requestSingleInstanceLock(singleInstanceData)
    : true;

if (!IS_SELF_TEST) {

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
    // A20/L-5: if the OS keystore is back (e.g. keyring now installed), upgrade
    // any secrets written in plaintext-fallback mode to encrypted at rest.
    try {
      reEncryptPlaintextSecretsIfPossible();
    } catch (e) {
      logger.warn("re-encrypt secrets on startup failed:", e);
    }
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
} // end if (!IS_SELF_TEST)

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
    // C5 (security review): a crafted `atlarix://pro-return?key=<attacker>` link
    // must NOT silently write an API key + enable Pro (that would reroute all the
    // user's AI calls through the attacker's gateway). Require an explicit native
    // confirmation before applying anything. Surface the window so it's seen.
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
    const confirm = mainWindow
      ? dialog.showMessageBox(mainWindow, {
          type: "warning",
          buttons: ["Connect Atlarix Pro", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          title: "Connect Atlarix Pro?",
          message: "Connect Atlarix Pro with a new API key from this link?",
          detail:
            "This routes your AI requests through the Atlarix Pro gateway using a key delivered by the link you just opened. Only continue if you just completed an Atlarix Pro checkout. If you didn't expect this, click Cancel.",
        })
      : dialog.showMessageBox({
          type: "warning",
          buttons: ["Connect Atlarix Pro", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          title: "Connect Atlarix Pro?",
          message: "Connect Atlarix Pro with a new API key from this link?",
          detail:
            "This routes your AI requests through the Atlarix Pro gateway using a key delivered by the link you just opened. Only continue if you just completed an Atlarix Pro checkout. If you didn't expect this, click Cancel.",
        });
    confirm
      .then(({ response }) => {
        if (response !== 0) return; // Cancel / dismissed
        handleAtlarixProReturn({ apiKey });
        mainWindow?.webContents.send("deep-link-received", {
          type: parsed.hostname,
        });
      })
      .catch((err) => log.error("pro-return confirmation failed:", err));
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
  // Shutdown has begun: short-circuit any late async db write with a clean
  // DatabaseClosingError instead of the opaque "connection is not open" throw.
  // (The awaited before-quit flush chain runs earlier, while the DB is open.)
  try {
    beginDatabaseClosing();
  } catch {
    /* db module may not be loaded in some early-exit paths */
  }
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
