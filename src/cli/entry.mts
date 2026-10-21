/**
 * `atlarix` — the compiled CLI's entry.
 *
 *   atlarix                 interactive, in the current folder, on the desktop
 *                           app's data (the same chats, settings and keys)
 *   atlarix -c, --continue  …picking up the newest session in this folder
 *   atlarix --resume        …choosing which earlier session to open
 *   atlarix run …           batch (benchmarks, the cloud agent): the unchanged
 *   atlarix --prompt …      headless runner, in its own throwaway data folder
 *   atlarix acp             an editor's agent (Zed, JetBrains) over the Agent
 *                           Client Protocol on stdio: src/cli/acp/server.ts
 *   atlarix keys [add|remove <provider>]
 *                           your own API keys, each checked; a key is typed
 *                           here, hidden, never in a chat: src/cli/keys-command.ts
 *
 * Nothing that reads the data location may be imported before the mode is
 * chosen: the electron stub, the database and the settings reader all decide
 * where user data lives when they load. Hence the dynamic imports.
 *
 * Testing against a local model without an account or credits:
 *   atlarix --provider-url http://127.0.0.1:18787/v1 --model fake-model
 * uses a scratch data folder (~/.atlarix/dev-data), never the desktop's. An
 * endpoint on the Anthropic format: add `--provider-format anthropic`. The key
 * is `--api-key`, or ATLARIX_DEV_API_KEY (kept out of the process list).
 */
import "./acp/stdio-guard";
import "./tty-early";
import "./build-env";
import "../headless/log-setup";
import "../headless/bundled-assets";
import os from "node:os";
import path from "node:path";
import { formatFatal } from "./errors";

declare const __ATLARIX_HEADLESS_VERSION__: string;
const VERSION =
  typeof __ATLARIX_HEADLESS_VERSION__ === "undefined" ? "dev" : __ATLARIX_HEADLESS_VERSION__;
// The electron stub's app.getVersion() reads this (analytics' app_version).
process.env.ATLARIX_VERSION ??= VERSION;

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

function isBatch(): boolean {
  return (
    argv[0] === "run" ||
    argv.includes("--prompt") ||
    argv.includes("--prompt-file") ||
    argv.includes("--version") ||
    argv.includes("-v")
  );
}

/**
 * `atlarix --help`, `-h`, `help`: what it can do. They went to the batch
 * runner, which only said "--prompt or --prompt-file is required" (QA), and
 * `atlarix help` said it needed a terminal. `atlarix run --help` is still the
 * runner's own.
 */
function wantsHelp(): boolean {
  return argv[0] !== "run" && (argv[0] === "help" || argv.includes("--help") || argv.includes("-h"));
}

const HELP = `atlarix ${VERSION}: the Atlarix agent in your terminal

Usage
  atlarix                      Start in this folder
  atlarix -c, --continue       Pick up this folder's latest chat
  atlarix --resume [id]        Open a past chat (a list without an id)
  atlarix run --prompt "…"     One turn without the UI, for scripts and CI (run --help)

Commands
  atlarix login [--device]     Sign in (--device: with a code, on a machine without a browser)
  atlarix logout               Sign out of the CLI
  atlarix keys                 Your provider keys: list, add <provider>, remove <provider>
  atlarix acp                  Run as an agent for an editor (Agent Client Protocol)
  atlarix --version            The version

Inside, type / for commands, @ for files, and shift+tab to change mode.
Docs: https://atlarix.dev/docs
`;

async function interactive(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "The interactive CLI needs a terminal. For scripts and CI use `atlarix run --prompt …`.",
    );
  }
  // The terminal belongs to the UI now: log lines go to the log file only
  // (~/Library/Application Support/Atlarix/logs/atlarix-cli.log and friends),
  // never to a screen the renderer is drawing.
  const { default: log } = await import("electron-log");
  log.transports.console.level = false;
  const devUrl = flag("--provider-url");
  await prepareCliData(devUrl);

  // Signed in first, like every Atlarix surface (the dev endpoint needs none):
  // a welcome screen with the two ways in, as Claude Code and Codex open, not a
  // text line that opened a browser by itself (owner, 2026-10-17).
  if (!devUrl) {
    const { currentEmail } = await import("./auth/account");
    if (!(await currentEmail())) {
      const { shouldUseDeviceCode } = await import("./auth/device-sign-in");
      const { runLogin } = await import("./tui/run");
      await runLogin({
        version: VERSION,
        preferCode: argv.includes("--device") || (!argv.includes("--browser") && shouldUseDeviceCode()),
        signIn: (method, show) => signInWith(method, show),
      });
    }
  }

  const { AgentSession, seedDevProvider } = await import("./agent/session");
  const model = devUrl
    ? await seedDevProvider({
        baseUrl: devUrl,
        model: flag("--model") ?? "fake-model",
        apiKey: flag("--api-key") ?? process.env.ATLARIX_DEV_API_KEY,
        apiFormat: flag("--provider-format") === "anthropic" ? "anthropic" : "openai",
      })
    : undefined;
  // The CLI's own model choice and deep-thinking switch (~/.atlarix/cli-state.json),
  // never the desktop's: see src/cli/agent/models.ts.
  const modelsMod = await import("./agent/models");
  const cliState = devUrl ? null : modelsMod.readCliState();
  const { setRuntimeSettingsOverride } = await import("../main/settings");
  // The terminal's own level, always, even unset: the app's (user-settings.json)
  // leaked into requests while the CLI showed its own (QA: header showed the
  // default, the request carried the app's "low").
  if (cliState) setRuntimeSettingsOverride({ deepThinking: cliState.deepThinking ?? false, effort: cliState.effort ?? "" });

  const session = new AgentSession({ workspaceDir: process.cwd(), model: model ?? cliState?.model });
  await session.start();
  // On the way out: how to come back to this chat (once it has one).
  const { onShutdownNote } = await import("./shutdown");
  onShutdownNote(() => (session.sessionId ? `Resume this chat: atlarix --resume ${session.sessionId}  (or atlarix -c in this folder)` : null));
  // `atlarix --resume <session id>`: open that session (the app's "Continue in
  // terminal" runs this). Bare `--resume` still opens the picker.
  const resumeAt = argv.indexOf("--resume");
  const resumeId = resumeAt >= 0 ? argv[resumeAt + 1] : undefined;
  const resumeById = resumeId != null && !resumeId.startsWith("-");
  if (resumeById) await session.resume(resumeId);
  if (argv.includes("-c") || argv.includes("--continue")) {
    // Nothing is written to the user's own screen before the TUI: it stayed
    // there after quitting (owner, 2026-10-05). A new session says so itself.
    await session.resumeLatest();
  }
  if (!devUrl) {
    // Automations run in whichever Atlarix is open (runner.ts leases each run,
    // so with the app open too, every run still happens once).
    const { startAutomationRunner } = await import("../lib/automations/runner");
    startAutomationRunner();
    // The provider and model catalog refreshes here as in the app (hourly; a
    // fresh disk cache skips the fetch).
    const { startModelsDevRefresh } = await import("../lib/models_dev");
    startModelsDevRefresh();
    // And the MCP marketplace catalog (/mcp browse), the same way.
    const { startMcpRegistryRefresh } = await import("../lib/mcp/registry-catalog");
    startMcpRegistryRefresh();
    // The user's Chrome, through the Atlarix extension: hosted here, or shared
    // with the desktop app when it already hosts it (bridge-lifecycle.ts).
    void startCliBridge();
  }

  // The remembered label, not the model list: building every provider's list
  // here held the first frame back ~2s. The TUI loads the list right after it
  // draws and corrects the label if it changed.
  const modelLabel = model
    ? `${model.name} (${/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/i.test(devUrl ?? "") ? "local" : "dev"})`
    : (cliState && modelsMod.savedModelLabel(cliState)) ?? (await selectedModelLabel());
  // Dev mode's choices live in memory, never in ~/.atlarix/cli-state.json (the
  // user's own): the scratch folder's models, /model, /effort and ctrl+t all
  // work, so a provider added there can be tried end to end without an account.
  let devState: import("./agent/models").CliState = { model, recent: [], favorites: [] };

  const { runTui } = await import("./tui/run");
  // Retention's daily signal, from the terminal too (once a day, shared with the app).
  void import("../main/lib/analytics").then((m) => m.trackActiveDay()).catch(() => {});
  await runTui({
    session,
    version: VERSION,
    modelLabel,
    openResume: argv.includes("--resume") && !resumeById,
    launch: argv.includes("--resume") ? "resume" : argv.includes("-c") || argv.includes("--continue") ? "continue" : "new",
    signIn: signInInTui,
    chromeStatus,
    autoUpdate: devUrl ? undefined : (notify) => void import("./update").then((m) => m.startAutoUpdate(VERSION, notify)),
    models: devUrl
      ? {
          // Atlarix Auto needs an account, which dev mode has none of.
          load: async () => (await modelsMod.loadModelOptions()).filter((o) => o.provider !== "compass"),
          state: () => devState,
          save: (st) => {
            devState = st;
          },
          choose: (ref) => session.setModel(ref),
          setEffort: (patch) => setRuntimeSettingsOverride(patch),
          selected: async () => model,
        }
      : {
          load: modelsMod.loadModelOptions,
          state: () => modelsMod.readCliState(),
          save: (st) => modelsMod.writeCliState(st),
          choose: (ref) => session.setModel(ref),
          setEffort: (patch) => setRuntimeSettingsOverride(patch),
          // The model this terminal runs on when none was chosen here: the app's.
          selected: () => import("../main/settings").then((m) => m.readSettings().selectedModel),
        },
  });
  process.exit(0);
}

/**
 * Where this run's data lives, and the keys to read it: the desktop app's data
 * (chats, settings, keys, sign-in) or, with `--provider-url`, a scratch folder
 * for testing against a local model. Shared by the TUI and `atlarix acp`.
 */
async function prepareCliData(devUrl: string | undefined): Promise<void> {
  if (devUrl) {
    if (!process.env.ATLARIX_USER_DATA_DIR) {
      process.env.ATLARIX_USER_DATA_DIR = path.join(os.homedir(), ".atlarix", "dev-data");
      // A local model, not a scratch profile: the person's rules and memory apply.
      process.env.ATLARIX_HOME_DIR ??= path.join(os.homedir(), ".atlarix");
    }
    process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
    process.env.ATLARIX_CLIENT_PROGRAM = "Atlarix CLI";
    process.env.ATLARIX_SURFACE ??= "cli";
  } else {
    const { enterDesktopDataMode } = await import("./desktop-data");
    const dir = enterDesktopDataMode();
    // The desktop's secrets are encrypted with the OS key; use the same key for
    // every store (the electron stub's safeStorage, and settings' own lookup).
    const { desktopSafeStorage } = await import("../runtime/oscrypt");
    const storage = desktopSafeStorage("Atlarix", dir);
    const electron = (await import("electron")) as unknown as {
      setSafeStorageImpl?: (impl: typeof storage) => void;
    };
    electron.setSafeStorageImpl?.(storage);
    const { useSafeStorageProvider } = await import("../main/settings");
    useSafeStorageProvider(storage);
    // Atlarix Auto and the Core lineup come from the hosted core-models.json, as
    // in the desktop (main.ts): the last good copy now, a fresh one in the
    // background. Without it /model had no Auto row and Core fell back to the
    // build's env models.
    const { warmCoreModelOverrides } = await import("../lib/routing/core-model-overrides");
    warmCoreModelOverrides();
  }
}

/** The desktop's selected model, named the way the app names it. Auto never names the model behind it. */
async function selectedModelLabel(): Promise<string> {
  const { readSettings } = await import("../main/settings");
  const { isCoreAutoTier } = await import("../ipc/shared/compass_constants");
  const sel = readSettings().selectedModel;
  if (sel.provider === "compass") return isCoreAutoTier(sel.name) ? "Atlarix Auto" : `Atlarix Core · ${sel.name}`;
  return sel.name;
}

async function startCliBridge(): Promise<void> {
  try {
    const { unpackEmbeddedBinary } = await import("../runtime/embedded-bin");
    const relay = await unpackEmbeddedBinary(
      process.platform === "win32" ? "atlarix-bridge.exe" : "atlarix-bridge",
      process.env.ATLARIX_EMBEDDED_RELAY,
    ).catch(() => null);
    bridgeModule = await import("../main/bridge-lifecycle");
    const { startBridge } = bridgeModule;
    // "if-missing": the desktop app's native-host install (its own relay) is
    // the one to keep; the CLI installs only where there is none.
    await startBridge({ relayPath: relay, installHost: "if-missing" });
  } catch {
    /* the browser is optional: everything else works without it */
  }
}

/** Set once the bridge starts (never imported before the data location is chosen). */
let bridgeModule: typeof import("../main/bridge-lifecycle") | null = null;

/** What /status says about Chrome. */
function chromeStatus(): string {
  const b = bridgeModule?.bridge();
  if (!b) return "unavailable (no browser bridge in this build)";
  if (!b.connected) return "not connected · open the Atlarix side panel in Chrome";
  const hello = b.activeHello;
  const what = `${hello?.browser ?? "Chrome"} · extension ${hello?.extensionVersion ?? "?"}`;
  return bridgeModule?.bridgeRole() === "peer" ? `${what} (shared with the Atlarix app)` : what;
}

type ShowLines = (lines: Array<{ text: string; tone?: "accent" | "muted" | "warn" | "error" | "text"; bold?: boolean }>) => void;

/** `/login` inside the TUI: the same two ways in, shown as lines in a dialog. */
async function signInInTui(show: ShowLines): Promise<string> {
  const { shouldUseDeviceCode } = await import("./auth/device-sign-in");
  return signInWith(shouldUseDeviceCode() ? "code" : "browser", show);
}

/** Sign in through the browser on this machine, or with a code on any device. */
async function signInWith(method: "browser" | "code", show: ShowLines): Promise<string> {
  const { signInWithDeviceCode } = await import("./auth/device-sign-in");
  const { acceptSession, signInCli } = await import("./auth/account");
  if (method === "code") {
    return signInWithDeviceCode({
      acceptSession,
      show: ({ userCode, verificationUri, expiresInS }) =>
        show([
          { text: "On any device, open:" },
          { text: `  ${verificationUri}`, tone: "accent" },
          { text: "sign in, and enter this code:" },
          { text: `  ${userCode}`, tone: "accent", bold: true },
          { text: `It works for ${Math.round(expiresInS / 60)} minutes. Waiting… (esc to cancel)`, tone: "muted" },
        ]),
    });
  }
  return signInCli((url) =>
    show([
      { text: "Finish signing in in your browser." },
      { text: "If it didn't open, visit:", tone: "muted" },
      { text: `  ${url}`, tone: "accent" },
      { text: "Waiting… (esc to cancel)", tone: "muted" },
    ]),
  );
}

/**
 * `atlarix login`, and the first run, in plain terminal output: through the
 * browser on this machine, or with a code (`--device`, and by default over SSH
 * or with no display, where there is no browser to open).
 */
async function loginInTerminal(): Promise<void> {
  const { shouldUseDeviceCode, signInWithDeviceCode } = await import("./auth/device-sign-in");
  const { acceptSession, signInCli } = await import("./auth/account");
  const device = argv.includes("--device") || (!argv.includes("--browser") && shouldUseDeviceCode());
  if (device) {
    process.stdout.write("\n◆ atlarix\n\nSign in to start.\n");
    const email = await signInWithDeviceCode({
      acceptSession,
      show: ({ userCode, verificationUri, expiresInS }) => {
        process.stdout.write(
          `\nOn any device, open:\n  ${verificationUri}\n\nsign in, and enter this code:\n\n    \x1b[1;38;2;16;185;129m${userCode}\x1b[0m\n\n` +
            `It works for ${Math.round(expiresInS / 60)} minutes. Waiting (ctrl+c to cancel)…\n`,
        );
      },
    });
    process.stdout.write(`\n✓ Signed in as ${email}\n\n`);
    return;
  }
  process.stdout.write("\n◆ atlarix\n\nSign in to start. Opening your browser…\n");
  const email = await signInCli((url) => {
    process.stdout.write(
      `If it didn't open, visit:\n  ${url}\n\nNo browser on this machine? Run \`atlarix login --device\` instead.\n\nWaiting for you to finish (ctrl+c to cancel)…\n`,
    );
  });
  process.stdout.write(`\n✓ Signed in as ${email}\n\n`);
}

async function main(): Promise<void> {
  if (wantsHelp()) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  // A one-shot command prints its answer, not the log (that goes to the file).
  if (argv[0] === "keys" || argv[0] === "login" || argv[0] === "logout") {
    const { default: log } = await import("electron-log");
    log.transports.console.level = false;
  }
  if (argv[0] === "acp") {
    // Before the batch/interactive split: an editor runs this over pipes, and
    // the interactive path refuses anything that isn't a terminal.
    // Reported as the editor it serves, while ATLARIX_SURFACE stays `cli`
    // (core_proxy.ts atlarixSurface).
    process.env.ATLARIX_REPORT_SURFACE = process.env.ATLARIX_ACP_CLIENT === "vscode" ? "vscode" : "acp";
    const devUrl = flag("--provider-url");
    await prepareCliData(devUrl);
    const { runAcp } = await import("./acp/server");
    await runAcp({
      version: VERSION,
      devUrl,
      devModel: flag("--model"),
      apiKey: flag("--api-key") ?? process.env.ATLARIX_DEV_API_KEY,
      devFormat: flag("--provider-format") === "anthropic" ? "anthropic" : "openai",
      startBridge: () => void startCliBridge(),
      chromeStatus,
    });
    // The editor closed the connection: the CLI's exit sweep, and what analytics
    // and crash reports still have queued (a short editor session sent nothing
    // before: QA X1), bounded together well inside VS Code's 5 s kill backstop.
    const { sweepTempOnQuit } = await import("../main/temp-hygiene");
    const { flushAndClose } = await import("../main/lib/analytics");
    const { flushClientUsage } = await import("../lib/analytics/usage-rollup");
    const Sentry = await import("@sentry/electron/main");
    await Promise.race([
      Promise.all([
        sweepTempOnQuit().catch(() => {}),
        flushAndClose().catch(() => {}),
        flushClientUsage().catch(() => {}),
        Sentry.flush(1000),
      ]),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    process.exit(0);
  }
  if (argv[0] === "keys") {
    await prepareCliData(undefined);
    // Custom providers live in the database: listing or removing one needs it
    // open ("Database not initialized" otherwise).
    const { initializeDatabase } = await import("../db");
    initializeDatabase();
    const { runKeysCommand, readHidden } = await import("./keys-command");
    const { realServices } = await import("./agent/services");
    const code = await runKeysCommand(argv.slice(1), realServices, {
      out: (s) => process.stdout.write(s),
      readKey: (prompt) => readHidden(prompt),
    }).catch((e: Error) => {
      process.stderr.write(`${e.message}\n`);
      return 1;
    });
    process.exit(code);
  }
  if (argv[0] === "login" || argv[0] === "logout") {
    const { enterDesktopDataMode } = await import("./desktop-data");
    const dir = enterDesktopDataMode();
    const { desktopSafeStorage } = await import("../runtime/oscrypt");
    const electron = (await import("electron")) as unknown as {
      setSafeStorageImpl?: (impl: ReturnType<typeof desktopSafeStorage>) => void;
    };
    electron.setSafeStorageImpl?.(desktopSafeStorage("Atlarix", dir));
    if (argv[0] === "logout") {
      const { signOutCli } = await import("./auth/account");
      await signOutCli();
      process.stdout.write("Signed out of the Atlarix CLI. The desktop app and extension stay signed in.\n");
    } else {
      // Already signed in: say who, rather than opening another sign-in (QA).
      const { currentEmail } = await import("./auth/account");
      const who = argv.includes("--force") ? null : await currentEmail().catch(() => null);
      if (who) process.stdout.write(`Signed in as ${who}. To switch accounts: atlarix logout, then atlarix login.\n`);
      else await loginInTerminal();
    }
    process.exit(0);
  }
  if (isBatch()) {
    // The headless entry drops a leading `run` itself.
    await import("../headless/atlarix-headless.mts");
    return;
  }
  await interactive();
}

main().catch((err) => {
  process.stderr.write(formatFatal(err) + "\n");
  process.exit(1);
});
