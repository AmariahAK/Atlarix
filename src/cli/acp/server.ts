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
      if (ctx.params.methodId === "atlarix-login") {
        // The editor ran `atlarix login` in its own terminal: the sign-in is
        // already on disk, shared with this process. Only say whether it took.
        const { realServices } = await import("../agent/services");
        if (await realServices.account.email().catch(() => null)) return {};
        throw acp.RequestError.authRequired(undefined, "Not signed in yet: finish `atlarix login`, then try again.");
      }
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
    .onRequest("_atlarix/status", (p) => p as Record<string, unknown>, async () => {
      const { recapEnabled } = await import("@/lib/recap/recap");
      return { chrome: extras.chromeStatus?.() ?? "unavailable", recap: await recapEnabled() };
    })
    .onRequest("_atlarix/recap", (p) => p as { sessionId: string }, (ctx) => agent.recap(ctx.params.sessionId))
    .onRequest("_atlarix/handoff", (p) => p as { sessionId: string }, async (ctx) => {
      try {
        await agent.handoff(ctx.params.sessionId);
      } catch (e) {
        throw acp.RequestError.internalError(undefined, (e as Error).message);
      }
      return {};
    })
    // ── Account, billing, keys and MCP for Atlarix's own extension: the CLI's
    // own services (/status, /billing, /connect, /mcp, /logout), nothing new.
    .onRequest("_atlarix/account", (p) => p as { sessionId?: string }, async (ctx) => {
      const { realServices } = await import("../agent/services");
      const a = realServices.account;
      const email = await a.email().catch(() => null);
      const [kind, balanceCents] = email
        ? await Promise.all([a.kind?.().catch(() => null) ?? null, a.balanceCents().catch(() => null)])
        : ["signed-out", null];
      const usage = ctx.params.sessionId ? agent.sessionInfo(ctx.params.sessionId) : null;
      return { email, kind, balanceCents, usage, manageUrl: "https://www.atlarix.dev/account", pricingUrl: "https://www.atlarix.dev/pricing" };
    })
    .onRequest("_atlarix/checkout", (p) => p as { kind: "pro" | "credit"; amountCents?: number }, async (ctx) => {
      const { realServices } = await import("../agent/services");
      if (!(await realServices.account.email())) throw acp.RequestError.authRequired(undefined, "Sign in to Atlarix first.");
      const url = await realServices.account.checkout(ctx.params.kind, ctx.params.amountCents);
      if (!url) throw acp.RequestError.invalidParams(undefined, ctx.params.kind === "credit" ? "Credit starts at $10." : "Checkout isn't available right now.");
      return { url };
    })
    .onRequest("_atlarix/sign_out", (p) => p as Record<string, unknown>, async () => {
      const { realServices } = await import("../agent/services");
      await realServices.account.signOut();
      return {};
    })
    .onRequest("_atlarix/providers", (p) => p as Record<string, unknown>, async () => {
      const { realServices } = await import("../agent/services");
      return { providers: await realServices.providers.list() };
    })
    // A null key removes it. Either way every open chat gets the new model list.
    .onRequest("_atlarix/provider_key", (p) => p as { providerId: string; key: string | null }, async (ctx) => {
      const { realServices } = await import("../agent/services");
      const { providerId, key } = ctx.params;
      if (!providerId) throw acp.RequestError.invalidParams(undefined, "Which provider?");
      if (key === null) {
        await realServices.providers.removeKey(providerId);
        await agent.modelsChanged(providerId);
        return {};
      }
      if (!key?.trim()) throw acp.RequestError.invalidParams(undefined, "A provider and a key are needed.");
      await realServices.providers.saveKey(providerId, key.trim());
      await agent.modelsChanged();
      return {};
    })
    .onRequest("_atlarix/provider_test", (p) => p as { providerId: string }, async (ctx) => {
      const { realServices } = await import("../agent/services");
      return realServices.providers.test(ctx.params.providerId);
    })
    .onRequest("_atlarix/provider_custom", (p) => p as { name: string; baseUrl: string; key: string; models?: string[] }, async (ctx) => {
      const { realServices, NoModelsListedError } = await import("../agent/services");
      const { name, baseUrl, key, models } = ctx.params;
      if (!name?.trim() || !baseUrl?.trim() || !key?.trim()) throw acp.RequestError.invalidParams(undefined, "A name, a base URL and a key are needed.");
      try {
        const r = await realServices.providers.addCustom({ name, baseUrl, key, models });
        await agent.modelsChanged();
        return r;
      } catch (e) {
        // `needsModel` tells the extension to ask for a model id and try again.
        if (e instanceof NoModelsListedError) throw acp.RequestError.invalidParams({ needsModel: true }, e.message);
        throw acp.RequestError.invalidParams(undefined, (e as Error).message);
      }
    })
    // Go back to one of your messages (the TUI's /undo): list, what it would undo, and resend.
    .onRequest(
      "_atlarix/undo",
      (p) => p as { sessionId: string; action: "list" | "preview" | "resend"; messageId?: number; text?: string; restore?: boolean },
      async (ctx) => {
        const { sessionId, action, messageId, text, restore } = ctx.params;
        if (action === "list") return { messages: agent.undoList(sessionId) };
        if (messageId == null) throw acp.RequestError.invalidParams(undefined, "Which message?");
        if (action === "preview") return agent.undoPreview(sessionId, Number(messageId));
        if (action === "resend") return agent.undoResend(sessionId, Number(messageId), String(text ?? ""), restore === true);
        throw acp.RequestError.invalidParams(undefined, `unknown action ${action}`);
      },
    )
    .onRequest("_atlarix/session", (p) => p as { sessionId: string; action: "rename" | "delete"; title?: string }, async (ctx) => {
      const { sessionId, action, title } = ctx.params;
      try {
        if (action === "rename") await agent.changeSession(sessionId, { rename: String(title ?? "") });
        else if (action === "delete") await agent.changeSession(sessionId, { delete: true });
        else throw new Error(`unknown action ${action}`);
      } catch (e) {
        throw acp.RequestError.invalidParams(undefined, (e as Error).message);
      }
      return {};
    })
    .onRequest("_atlarix/mcp", (p) => p as { sessionId: string; action: string; id?: number; enabled?: boolean; name?: string; command?: string; url?: string }, async (ctx) => {
      const { realServices } = await import("../agent/services");
      const mcp = realServices.mcp;
      const { appId } = agent.sessionInfo(ctx.params.sessionId);
      const id = Number(ctx.params.id);
      switch (ctx.params.action) {
        case "list":
          return { servers: await mcp.list(appId) };
        case "set":
          await mcp.setEnabled(id, ctx.params.enabled === true);
          return { servers: await mcp.list(appId) };
        case "add":
          await mcp.add(appId, { name: String(ctx.params.name ?? ""), command: ctx.params.command, url: ctx.params.url });
          return { servers: await mcp.list(appId) };
        case "remove":
          await mcp.remove(id);
          return { servers: await mcp.list(appId) };
        case "test":
          return { result: await mcp.test(id) };
        default:
          throw acp.RequestError.invalidParams(undefined, `unknown action ${ctx.params.action}`);
      }
    })
    .onRequest("_atlarix/recap_setting", (p) => p as { on: boolean }, async (ctx) => {
      const { setRecapEnabled } = await import("@/lib/recap/recap");
      await setRecapEnabled(ctx.params.on === true);
      return {};
    });
}

export async function runAcp(opts: AcpRunOptions): Promise<void> {
  const { default: log } = await import("electron-log");
  log.transports.console.level = false;
  // How other Atlarix sessions see these: "Fix login bug (editor)".
  process.env.ATLARIX_PEER_SURFACE = "editor";
  const { installProcessGuards } = await import("../shutdown");
  installProcessGuards();

  const { AgentSession, seedDevProvider, listFolderSessions, changeFolderSession } = await import("../agent/session");
  const devModel = opts.devUrl
    ? await seedDevProvider({ baseUrl: opts.devUrl, model: opts.devModel ?? "fake-model", apiKey: opts.apiKey })
    : undefined;
  const models = await import("../agent/models");
  const cliState = opts.devUrl ? null : models.readCliState();
  const { setRuntimeSettingsOverride } = await import("../../main/settings");
  if (cliState?.deepThinking != null) setRuntimeSettingsOverride({ deepThinking: cliState.deepThinking });

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
    models: async () => {
      if (devModel) return { options: [{ ...devModel, label: devModel.name }], current: devModel };
      const state = models.readCliState();
      return {
        options: await models.loadModelOptions(),
        current: state.model,
        picks: { favorites: state.favorites, recent: state.recent },
        deepThinking: state.deepThinking ?? false,
      };
    },
    rememberModel: (ref) => {
      if (!opts.devUrl) models.writeCliState(models.rememberChoice(models.readCliState(), ref));
    },
    setDeepThinking: (on) => {
      setRuntimeSettingsOverride({ deepThinking: on });
      if (!opts.devUrl) models.writeCliState({ ...models.readCliState(), deepThinking: on });
    },
    listSessions: (cwd) => listFolderSessions(cwd),
    changeSession: (sessionId, change) => changeFolderSession(sessionId, change),
  });

  if (!opts.devUrl) opts.startBridge?.();

  const connection = buildAgentApp(agent, opts.version, { chromeStatus: opts.chromeStatus }).connect(acp.ndJsonStream(stdoutStream(), stdinStream()));

  await connection.closed;
  await agent.closeAll();
}
