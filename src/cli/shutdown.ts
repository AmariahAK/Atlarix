/**
 * How the interactive CLI stops, on every path: /quit, ctrl+c twice, SIGTERM,
 * SIGHUP (the terminal closed). The desktop's quit pipeline in miniature
 * (main.ts before-quit): stop the streams, kill running commands — a command
 * that ran past ~15s was moved to the background and would otherwise outlive
 * us — save what the turns produced, close the database, give the terminal back,
 * exit. A hard exit backs it all up: nothing here may leave the process hanging.
 *
 * And what does NOT stop it: an unhandled rejection or exception is logged and
 * survived, as in the desktop app (main.ts). A cancelled turn rejects detached
 * SDK promises with `user_cancel`; treating that as fatal killed the CLI on Esc.
 */
import log from "electron-log";

const logger = log.scope("cli");
const HARD_EXIT_MS = 2000;

let restore: () => void = () => {};
let shuttingDown = false;

let goodbye: () => string | null = () => null;

/** A line printed once the terminal is back: how to return to this chat (QA, as Claude Code and Codex do). */
export function onShutdownNote(fn: () => string | null): void {
  goodbye = fn;
}

/** What gives the terminal back (the TUI registers its renderer's). */
export function onShutdownRestore(fn: () => void): void {
  restore = fn;
}

async function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
}

export async function shutdownCli(code = 0): Promise<never> {
  if (shuttingDown) return new Promise<never>(() => {});
  shuttingDown = true;
  const hard = setTimeout(() => {
    restore();
    process.exit(code);
  }, HARD_EXIT_MS);
  (hard as { unref?: () => void }).unref?.();
  try {
    const streams = await import("@/ipc/handlers/chat_stream_handlers");
    // Save what is still streaming BEFORE aborting: the flush keeps only live
    // turns, and the abort forgets them (as the app's quit does).
    await withTimeout(streams.flushPartialStreamsForShutdown(), 1200);
    streams.abortAllStreams();
    const { killAllBackgroundJobs } = await import("@/lib/agent/background-commands");
    killAllBackgroundJobs();
    const { killAllShellProcesses } = await import("@/ipc/utils/runShellCommand");
    killAllShellProcesses();
    // Hand the browser over: an Atlarix sharing it through us takes it over.
    const { stopBridge } = await import("@/main/bridge-lifecycle");
    await withTimeout(stopBridge(), 300);
    // Analytics (only queued when the user opted in): sent before the exit.
    const { flushAndClose } = await import("@/main/lib/analytics");
    await withTimeout(flushAndClose(), 800);
    const { drainPendingWork } = await import("@/lib/pending-work");
    await withTimeout(drainPendingWork(), 500);
    const { beginDatabaseClosing } = await import("@/db");
    beginDatabaseClosing();
  } catch (e) {
    logger.warn("shutdown step failed (exiting anyway):", e);
  }
  restore();
  try {
    const note = goodbye();
    if (note) process.stdout.write(`${note}\n`);
  } catch {
    /* nothing to say */
  }
  process.exit(code);
}

/** Log-and-survive for stray errors; orderly shutdown for signals. */
let guardsInstalled = false;

/** Once per process: the welcome screen and the chat both start a renderer. */
export function installProcessGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;
  const survive = (kind: string) => async (reason: unknown) => {
    try {
      const { isStreamStopAbort } = await import("@/lib/stream/stream-stop-sentinels");
      const { isNoUsableModelOutputError } = await import("@/ipc/utils/no_usable_model_output");
      if (isStreamStopAbort(reason) || isNoUsableModelOutputError(reason)) return;
    } catch {
      /* fall through to logging */
    }
    logger.error(`[cli] ${kind} (survived):`, reason);
  };
  process.on("unhandledRejection", survive("unhandled rejection"));
  process.on("uncaughtException", survive("uncaught exception"));
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void shutdownCli(0));
  }
}
