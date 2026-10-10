/**
 * `atlarix acp`: Atlarix as an Agent Client Protocol agent. An editor (Zed, a
 * JetBrains IDE, any ACP client) starts this process and speaks JSON-RPC over
 * stdin/stdout. The editor draws the chat, the diffs and the Allow/Deny; the
 * CLI's own session does the work (agent.ts).
 *
 *   Zed (~/.config/zed/settings.json):
 *     "agent_servers": { "Atlarix": { "type": "custom", "command": "atlarix", "args": ["acp"] } }
 *   JetBrains (~/.jetbrains/acp.json):
 *     "agent_servers": { "Atlarix": { "command": "/path/to/atlarix", "args": ["acp"] } }
 *
 * Same data as the TUI: the desktop app's chats, settings, keys and sign-in.
 */
import * as acp from "@agentclientprotocol/sdk";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { acpStdout } from "./stdio-guard";
import { AcpAgent } from "./agent";

export interface AcpRunOptions {
  version: string;
  /** `--provider-url`: a local OpenAI-compatible model, no account (tests). */
  devUrl?: string;
  devModel?: string;
  apiKey?: string;
  /** The user's Chrome through the extension (entry.mts startCliBridge). */
  startBridge?: () => void;
  /** One line on the Chrome connection, as the TUI's /chrome shows it. */
  chromeStatus?: () => string;
}

/** stdout as a web stream, through the writer the stdio guard kept back. */
function stdoutStream(): WritableStream<Uint8Array> {
  const write = acpStdout();
  if (!write) throw new Error("ACP mode must be started as `atlarix acp` (the stdio guard is not active).");
  return new WritableStream<Uint8Array>({
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        write(chunk, (err) => (err ? reject(err) : resolve()));
      }),
  });
}

/** stdin as a web stream. Node's `Readable.toWeb` is not relied on under Bun. */
function stdinStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      process.stdin.on("end", () => controller.close());
      process.stdin.on("error", (e) => controller.error(e));
    },
  });
}

export function initializeResponse(version: string): InitializeResponse {
  return {
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name: "atlarix", title: "Atlarix", version },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      mcpCapabilities: { http: false, sse: false },
      sessionCapabilities: { list: {} },
    },
    authMethods: [
      {
        id: "atlarix-browser",
        name: "Sign in with Atlarix",
        description: "Opens atlarix.dev in your browser to sign in.",
      },
      {
        id: "atlarix-login",
        type: "terminal",
        name: "Sign in from a terminal",
        description: "Runs `atlarix login` (use `atlarix login --device` where no browser can open).",
        args: ["login"],
        _meta: { "terminal-auth": { command: "atlarix", args: ["login"], label: "Atlarix login" } },
      },
    ],
  };
}

/** The ACP method table for `agent`; the stdio server and the tests connect it. */
export function buildAgentApp(
  agent: AcpAgent,
  version: string,
  extras: { chromeStatus?: () => string } = {},
): ReturnType<typeof acp.agent> {
  return acp
    .agent({ name: "atlarix" })
    .onConnect((connection) => agent.attach(connection.client))
    .onRequest("initialize", (ctx) => {
      agent.setClientCapabilities(ctx.params.clientCapabilities);
      return initializeResponse(version);
    })
    .onRequest("authenticate", async (ctx) => {
      if (ctx.params.methodId !== "atlarix-browser") {
        throw acp.RequestError.invalidParams(undefined, `unknown sign-in method ${ctx.params.methodId}`);
      }
      const { signInCli } = await import("../auth/account");
      await signInCli((url) => process.stderr.write(`Atlarix sign-in: ${url}\n`));
      return {};
    })
    .onRequest("session/new", (ctx) => agent.newSession(ctx.params.cwd))
    .onRequest("session/load", (ctx) => agent.loadSession(ctx.params.cwd, ctx.params.sessionId))
    .onRequest("session/list", (ctx) => agent.listSessions(ctx.params.cwd ?? undefined))
    .onRequest("session/prompt", (ctx) => agent.prompt(ctx.params.sessionId, ctx.params.prompt, ctx.params._meta))
    .onNotification("session/cancel", (ctx) => agent.cancel(ctx.params.sessionId))
    .onRequest("session/set_config_option", async (ctx) => ({
      configOptions: await agent.setConfigOption(ctx.params.sessionId, ctx.params.configId, ctx.params.value),
    }))
    .onRequest("session/set_mode", (ctx) => {
      agent.setSessionMode(ctx.params.sessionId, ctx.params.modeId);
      return {};
    })
    // Atlarix's own editor extension: what the status bar shows.
    .onRequest("_atlarix/status", (p) => p as Record<string, unknown>, () => ({
      chrome: extras.chromeStatus?.() ?? "unavailable",
    }));
}

export async function runAcp(opts: AcpRunOptions): Promise<void> {
  const { default: log } = await import("electron-log");
  log.transports.console.level = false;
  // How other Atlarix sessions see these: "Fix login bug (editor)".
  process.env.ATLARIX_PEER_SURFACE = "editor";
  const { installProcessGuards } = await import("../shutdown");
  installProcessGuards();

  const { AgentSession, seedDevProvider, listFolderSessions } = await import("../agent/session");
  const devModel = opts.devUrl
    ? await seedDevProvider({ baseUrl: opts.devUrl, model: opts.devModel ?? "fake-model", apiKey: opts.apiKey })
    : undefined;
  const models = await import("../agent/models");
  const cliState = opts.devUrl ? null : models.readCliState();
  if (cliState?.deepThinking != null) {
    const { setRuntimeSettingsOverride } = await import("../../main/settings");
    setRuntimeSettingsOverride({ deepThinking: cliState.deepThinking });
  }

  const agent = new AcpAgent({
    createSession: async (cwd) => {
      const s = new AgentSession({
        workspaceDir: cwd,
        model: devModel ?? (opts.devUrl ? undefined : models.readCliState().model),
        surface: "editor",
        idlePeerMessages: "hold",
      });
      await s.start();
      return s;
    },
    models: async () =>
      devModel
        ? { options: [{ ...devModel, label: devModel.name }], current: devModel }
        : { options: await models.loadModelOptions(), current: models.readCliState().model },
    rememberModel: (ref) => {
      if (!opts.devUrl) models.writeCliState(models.rememberChoice(models.readCliState(), ref));
    },
    listSessions: (cwd) => listFolderSessions(cwd),
  });

  if (!opts.devUrl) opts.startBridge?.();

  const connection = buildAgentApp(agent, opts.version, { chromeStatus: opts.chromeStatus }).connect(acp.ndJsonStream(stdoutStream(), stdinStream()));

  await connection.closed;
  await agent.closeAll();
}
