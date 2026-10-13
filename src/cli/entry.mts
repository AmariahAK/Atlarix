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
 * uses a scratch data folder (~/.atlarix/dev-data), never the desktop's.
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
    argv.includes("-v") ||
    argv.includes("--help") ||
    argv.includes("-h")
  );
}

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

  // Signed in first, like every Atlarix surface (the dev endpoint needs none).
  if (!devUrl) {
    const { currentEmail } = await import("./auth/account");
    if (!(await currentEmail())) {
      // Cooked mode for the plain-text sign-in, so ctrl+c cancels it.
      process.stdin.setRawMode(false);
      await loginInTerminal();
      process.stdin.setRawMode(true);
    }
  }

  const { AgentSession, seedDevProvider } = await import("./agent/session");
  const model = devUrl
    ? await seedDevProvider({ baseUrl: devUrl, model: flag("--model") ?? "fake-model", apiKey: flag("--api-key") })
    : undefined;
  // The CLI's own model choice and deep-thinking switch (~/.atlarix/cli-state.json),
  // never the desktop's: see src/cli/agent/models.ts.
  const modelsMod = await import("./agent/models");
  const cliState = devUrl ? null : modelsMod.readCliState();
  const { setRuntimeSettingsOverride } = await import("../main/settings");
  if (cliState?.deepThinking != null) setRuntimeSettingsOverride({ deepThinking: cliState.deepThinking });

  const session = new AgentSession({ workspaceDir: process.cwd(), model: model ?? cliState?.model });
  await session.start();
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
    // The user's Chrome, through the Atlarix extension: hosted here, or shared
    // with the desktop app when it already hosts it (bridge-lifecycle.ts).
    void startCliBridge();
  }

  let modelLabel = model ? `${model.name} (local)` : await selectedModelLabel();
  if (cliState?.model) {
    const options = await modelsMod.loadModelOptions().catch(() => []);
    const hit = options.find((o) => o.provider === cliState.model!.provider && o.name === cliState.model!.name);
    modelLabel = hit ? modelsMod.headerModelLabel(hit) : cliState.model.name;
  }

  const { runTui } = await import("./tui/run");
  await runTui({
    session,
    version: VERSION,
    modelLabel,
    openResume: argv.includes("--resume") && !resumeById,
    signIn: signInInTui,
    chromeStatus,
    autoUpdate: devUrl ? undefined : (notify) => void import("./update").then((m) => m.startAutoUpdate(VERSION, notify)),
    models: devUrl
      ? undefined
      : {
          load: modelsMod.loadModelOptions,
          state: () => modelsMod.readCliState(),
          save: (st) => modelsMod.writeCliState(st),
          choose: (ref) => session.setModel(ref),
          setDeepThinking: (on) => setRuntimeSettingsOverride({ deepThinking: on }),
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
    process.env.ATLARIX_USER_DATA_DIR ??= path.join(os.homedir(), ".atlarix", "dev-data");
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

/** `/login` inside the TUI: the same two ways in, shown as lines in a dialog. */
async function signInInTui(show: (lines: Array<{ text: string; tone?: "accent" | "muted" | "warn" | "error" | "text"; bold?: boolean }>) => void): Promise<string> {
  const { shouldUseDeviceCode, signInWithDeviceCode } = await import("./auth/device-sign-in");
  const { acceptSession, signInCli } = await import("./auth/account");
  if (shouldUseDeviceCode()) {
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
  if (argv[0] === "acp") {
    // Before the batch/interactive split: an editor runs this over pipes, and
    // the interactive path refuses anything that isn't a terminal.
    const devUrl = flag("--provider-url");
    await prepareCliData(devUrl);
    const { runAcp } = await import("./acp/server");
    await runAcp({
      version: VERSION,
      devUrl,
      devModel: flag("--model"),
      apiKey: flag("--api-key"),
      startBridge: () => void startCliBridge(),
      chromeStatus,
    });
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
      await loginInTerminal();
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
