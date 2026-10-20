/** @jsxImportSource @opentui/react */
/**
 * Start the terminal UI, and make sure the terminal is given back intact on
 * EVERY exit path — quit, ctrl+c, a crash — before anything is printed. A
 * crashed TUI that leaves the alternate screen, raw mode or a hidden cursor
 * behind breaks the user's shell.
 */
import fs from "node:fs";
import path from "node:path";
import { atlarixHomeDir } from "@/paths/atlarix-home";
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { AgentSession } from "../agent/session";
import { formatFatal } from "../errors";
import { installProcessGuards, onShutdownRestore, shutdownCli } from "../shutdown";
import { realServices } from "../agent/services";
import { App, type ModelSource } from "./App";
import { LoginScreen, type SignInMethod } from "./Login";
import { color } from "./theme";
import type { Line } from "./dialogs";

export interface RunTuiOptions {
  session: AgentSession;
  modelLabel: string;
  version: string;
  models?: ModelSource;
  /** `atlarix --resume`: start on the session picker. */
  openResume?: boolean;
  signIn?: (show: (lines: Line[]) => void) => Promise<string>;
  chromeStatus?: () => string;
  /** Starts the background self-update; events become a toast and a notice. */
  autoUpdate?: (notify: (e: import("../update").UpdateEvent) => void) => void;
}

let active: CliRenderer | null = null;

/**
 * Give the terminal back. Safe to call more than once. Besides the renderer's
 * own teardown, it writes the reset sequences and leaves raw mode itself, so the
 * shell comes back even when the renderer is mid-frame or already half gone.
 */
/**
 * While the screen is up, nothing may write under it: Node's own warnings
 * ("(node:…) DeprecationWarning …") and the AI SDK's go straight to stderr and
 * landed on top of the prompt box, where they stayed. They go to
 * ~/.atlarix/logs/cli.log instead, and stderr is handed back before anything
 * is reported on the way out.
 */
let restoreStderr: (() => void) | null = null;

function quietStderr(): void {
  if (restoreStderr) return;
  const original = process.stderr.write.bind(process.stderr);
  const dir = path.join(atlarixHomeDir(), "logs");
  let log: fs.WriteStream | null = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    log = fs.createWriteStream(path.join(dir, "cli.log"), { flags: "a" });
  } catch {
    log = null;
  }
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    try {
      log?.write(chunk);
    } catch {
      /* the log is best effort */
    }
    const done = rest.find((r) => typeof r === "function") as (() => void) | undefined;
    done?.();
    return true;
  }) as typeof process.stderr.write;
  restoreStderr = () => {
    process.stderr.write = original;
    log?.end();
    restoreStderr = null;
  };
}

export function restoreTerminal(): void {
  restoreStderr?.();
  const r = active;
  active = null;
  try {
    r?.destroy();
  } catch {
    /* already torn down */
  }
  if (!r) return;
  try {
    // Leave the alternate screen, show the cursor, stop mouse reporting,
    // bracketed paste and the kitty keyboard protocol, reset colours.
    // The pulsing tab title (tab-title.ts) goes too: an empty title gives the tab back to the terminal.
    process.stdout.write("\x1b]0;\x07\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[<u\x1b[0m");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {
    /* stdout already closed */
  }
}

/** The renderer that owns the terminal (set by runTui; tests set their own). */
export function setActiveRenderer(r: CliRenderer | null): void {
  active = r;
}

/** Give the terminal back FIRST, then say what happened, so the message lands on a working shell. */
export function reportFatal(err: unknown, write: (s: string) => void = (s) => void process.stderr.write(s)): void {
  restoreTerminal();
  write(formatFatal(err) + "\n");
}

export function fatal(err: unknown): never {
  reportFatal(err);
  process.exit(1);
}

/** The renderer, set up the same way for the welcome and the chat. */
async function startRenderer(): Promise<CliRenderer> {
  installProcessGuards();
  onShutdownRestore(restoreTerminal);
  // Into the alternate screen BEFORE the renderer starts (see runTui).
  if (process.stdout.isTTY) process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
  try {
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: [],
      openConsoleOnError: false,
      useMouse: true,
      backgroundColor: color.bg,
    });
    active = renderer;
    quietStderr();
    return renderer;
  } catch (err) {
    if (process.stdout.isTTY) process.stdout.write("\x1b[?1049l");
    throw err;
  }
}

/**
 * The welcome screen for someone signed out (Login.tsx). Resolves with their
 * email once they are in, and gives the terminal back so the chat can start;
 * ctrl+c or esc quits.
 */
export async function runLogin(opts: {
  version: string;
  preferCode: boolean;
  signIn: (method: SignInMethod, show: (lines: Line[]) => void) => Promise<string>;
}): Promise<string> {
  const renderer = await startRenderer();
  const root = createRoot(renderer);
  const email = await new Promise<string>((resolve) => {
    root.render(
      <LoginScreen
        version={opts.version}
        preferCode={opts.preferCode}
        signIn={opts.signIn}
        onSignedIn={resolve}
        onQuit={() => void shutdownCli(0)}
      />,
    );
  });
  root.unmount();
  restoreTerminal();
  return email;
}

export async function runTui(opts: RunTuiOptions): Promise<void> {
  installProcessGuards();
  onShutdownRestore(restoreTerminal);
  // Into the alternate screen BEFORE the renderer starts. Its native setup sends
  // terminal capability queries (kitty graphics, XTGETTCAP, DECRQM) on whatever
  // screen is current, and Terminal.app, which parses none of them, printed them
  // as text on the user's own screen (owner, 2026-10-04:
  // `+q4d73pppppp…Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA`). There they land on a
  // screen the first frame clears; the renderer's own switch is then a no-op.
  if (process.stdout.isTTY) process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
  let renderer: CliRenderer;
  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      // Signals are ours (src/cli/shutdown.ts): the renderer's own handling
      // restored the screen and then left the process running.
      exitSignals: [],
      // Our own handler reports errors (after restoring the terminal); opentui's
      // console overlay would bury them inside a screen that is about to close.
      openConsoleOnError: false,
      useMouse: true,
      backgroundColor: color.bg,
    });
  } catch (err) {
    // No renderer means restoreTerminal has nothing to tear down: leave the
    // alternate screen entered above ourselves, or the shell comes back blank.
    if (process.stdout.isTTY) process.stdout.write("\x1b[?1049l");
    throw err;
  }
  active = renderer;
  quietStderr();
  await new Promise<void>(() => {
    const quit = () => void shutdownCli(0);
    createRoot(renderer).render(
      <App
        session={opts.session}
        modelLabel={opts.modelLabel}
        version={opts.version}
        onQuit={quit}
        models={opts.models}
        signIn={opts.signIn}
        chromeStatus={opts.chromeStatus}
        autoUpdate={opts.autoUpdate}
        services={realServices}
        startWith={opts.openResume ? "/resume" : undefined}
      />,
    );
  });
}
