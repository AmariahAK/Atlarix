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
import { computerUseGrantNotice, isComputerUseOn, setComputerUse } from "@/lib/computer/lane";
import { isBrowserProvider, SIGN_IN_CHOICES } from "../auth/sign-in-choices";
import * as acp from "@agentclientprotocol/sdk";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { acpStdout } from "./stdio-guard";
import { AcpAgent } from "./agent";
import type { AutomationDraft } from "../agent/services";

export interface AcpRunOptions {
  version: string;
  /** `--provider-url`: a local model, no account (tests). */
  devUrl?: string;
  devModel?: string;
  apiKey?: string;
  /** `--provider-format anthropic`: that endpoint speaks the Anthropic Messages API. */
  devFormat?: "openai" | "anthropic";
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
      // Editors' own MCP servers (session/new, session/load): stdio always; http
      // (streamable) too. SSE is not spoken.
      mcpCapabilities: { http: true, sse: false },
      sessionCapabilities: { list: {}, fork: {} },
    },
    // The same ways in as the app, the CLI and the VS Code panel
    // (cli/auth/sign-in-choices.ts): each browser one opens atlarix.dev on that
    // provider; the code runs `atlarix login --device` in the editor's terminal.
    authMethods: [
      ...SIGN_IN_CHOICES.filter((c) => c.id !== "code").map((c) => ({
        id: `atlarix-${c.id}`,
        name: c.label,
        description: "Opens atlarix.dev in your browser.",
      })),
      {
        id: "atlarix-login-device",
        type: "terminal",
        name: "Sign in with a code",
        description: "For SSH, or a machine with no browser: runs `atlarix login --device`.",
        args: ["login", "--device"],
        _meta: { "terminal-auth": { command: "atlarix", args: ["login", "--device"], label: "Atlarix sign-in code" } },
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
      // Which editor this is ("zed"), for usage; our VS Code panel already
      // passed its host's name (Cursor, Windsurf…), which says more.
      const editor = (ctx.params as { clientInfo?: { name?: unknown } }).clientInfo?.name;
      if (!process.env.ATLARIX_ACP_EDITOR && typeof editor === "string") {
        process.env.ATLARIX_ACP_EDITOR = editor.slice(0, 40);
      }
      return initializeResponse(version);
    })
    .onRequest("authenticate", async (ctx) => {
      // Terminal methods: the editor ran `atlarix login` (an older listing) or
      // `atlarix login --device` itself, so the sign-in is already on disk.
      if (ctx.params.methodId === "atlarix-login" || ctx.params.methodId === "atlarix-login-device") {
        // The editor ran `atlarix login` in its own terminal: the sign-in is
        // already on disk, shared with this process. Only say whether it took.
        const { realServices } = await import("../agent/services");
        if (await realServices.account.email().catch(() => null)) return {};
        throw acp.RequestError.authRequired(undefined, "Not signed in yet: finish `atlarix login`, then try again.");
      }
      // "atlarix-browser": older VS Code panels; the page then offers every way in.
      const provider = ctx.params.methodId.replace(/^atlarix-/, "");
      if (ctx.params.methodId !== "atlarix-browser" && !isBrowserProvider(provider)) {
        throw acp.RequestError.invalidParams(undefined, `unknown sign-in method ${ctx.params.methodId}`);
      }
      const { signInCli } = await import("../auth/account");
      // An editor asked: the browser's page says to go back to it.
      await signInCli(
        (url) => process.stderr.write(`Atlarix sign-in: ${url}\n`),
        "your editor",
        isBrowserProvider(provider) ? provider : undefined,
      );
      return {};
    })
    .onRequest("session/new", (ctx) => agent.newSession(ctx.params.cwd, ctx.params.mcpServers))
    .onRequest("session/load", (ctx) =>
      agent.loadSession(ctx.params.cwd, ctx.params.sessionId, ctx.params.mcpServers),
    )
    .onRequest("session/list", (ctx) => agent.listSessions(ctx.params.cwd ?? undefined))
    .onRequest("session/fork", (ctx) => agent.forkSession(ctx.params.sessionId, ctx.params.cwd, ctx.params.mcpServers))
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
    // What is running in a session (sub-agents, background commands): list, output, stop.
    .onRequest(
      "_atlarix/tasks",
      (p) => p as { sessionId: string; action: "list" | "output" | "stop"; id?: string },
      (ctx) => {
        const { sessionId, action, id } = ctx.params;
        if (action !== "list" && action !== "output" && action !== "stop") {
          throw acp.RequestError.invalidParams(undefined, `Unknown action: ${String(action)}`);
        }
        return agent.tasks(sessionId, action, id);
      },
    )
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
    // Your activity on this computer (the Account panel): rows ready to draw.
    .onRequest("_atlarix/stats", (p) => p as Record<string, unknown>, async () => {
      const { realServices } = await import("../agent/services");
      const { activityFootnote, activitySections, activityTiles } = await import("@/lib/stats/activity-format");
      const s = await realServices.stats();
      return {
        empty: !s.since,
        tiles: activityTiles(s),
        sections: activitySections(s),
        // Half a year fits the sidebar.
        weeks: s.weeks.slice(-26),
        monthLabels: s.monthLabels.slice(-26),
        footnote: activityFootnote(s),
      };
    })
    // Usage analytics: the app's and the CLI's one setting (telemetryConsent),
    // asked by our VS Code panel. Other editors have no UI of ours to ask in, so
    // they send only after an opt-in made in the app or the CLI.
    .onRequest("_atlarix/analytics_consent", (p) => p as Record<string, unknown>, async () => {
      const { realServices } = await import("../agent/services");
      return { consent: await realServices.analytics.consent() };
    })
    .onRequest("_atlarix/analytics_set", (p) => p as { consent: string }, async (ctx) => {
      const v = ctx.params.consent;
      if (v !== "opted_in" && v !== "opted_out") {
        throw acp.RequestError.invalidParams(undefined, "consent must be opted_in or opted_out");
      }
      const { realServices } = await import("../agent/services");
      await realServices.analytics.setConsent(v);
      return { consent: v };
    })
    // The editor's own telemetry switch, changed while we run (VS Code). Off
    // stops usage analytics and crash reports here, whatever the Atlarix answer.
    .onRequest("_atlarix/host_telemetry", (p) => p as { enabled?: unknown }, async (ctx) => {
      if (ctx.params.enabled === false) process.env.ATLARIX_HOST_TELEMETRY = "off";
      else {
        delete process.env.ATLARIX_HOST_TELEMETRY;
        // Back on: this process's start and today's active day, sent once each.
        await import("@/main/lib/analytics").then((m) => m.trackAnalyticsTurnedOn()).catch(() => {});
      }
      return { enabled: ctx.params.enabled !== false };
    })
    .onRequest("_atlarix/account", (p) => p as { sessionId?: string }, async (ctx) => {
      const { realServices } = await import("../agent/services");
      const a = realServices.account;
      const email = await a.email().catch(() => null);
      const [kind, balanceCents] = email
        ? await Promise.all([a.kind?.().catch(() => null) ?? null, a.balanceCents().catch(() => null)])
        : ["signed-out", null];
      const usage = ctx.params.sessionId ? agent.sessionInfo(ctx.params.sessionId) : null;
      const profile = email ? await a.profile?.().catch(() => null) : null;
      // Free Auto's share left today, as the proxy last reported it (a percentage;
      // known only after an Auto request in this process).
      const { latestAutoStatus } = await import("@/main/auto-status");
      const freeAutoLeft = latestAutoStatus()?.freeRemaining ?? null;
      return {
        email,
        name: profile?.name ?? null,
        avatar: profile?.avatar ?? null,
        provider: profile?.provider ?? null,
        kind,
        balanceCents,
        usage,
        freeAutoLeft,
        manageUrl: "https://www.atlarix.dev/account",
        pricingUrl: "https://www.atlarix.dev/pricing",
      };
    })
    .onRequest("_atlarix/checkout", (p) => p as { kind: "pro" | "credit"; amountCents?: number }, async (ctx) => {
      const { realServices } = await import("../agent/services");
      if (!(await realServices.account.email())) throw acp.RequestError.authRequired(undefined, "Sign in to Atlarix first.");
      const url = await realServices.account.checkout(ctx.params.kind, ctx.params.amountCents);
      if (!url) throw acp.RequestError.invalidParams(undefined, ctx.params.kind === "credit" ? "Credit starts at $10." : "Checkout isn't available right now.");
      return { url };
    })
    // "Sign in with a code" from the VS Code panel: the first request starts the
    // device sign-in and answers with the code to show; the second resolves once
    // it was entered and approved. Two requests, not a notification, so the
    // panel needs nothing new to listen for.
    .onRequest("_atlarix/sign_in_code", (p) => p as Record<string, unknown>, async () => {
      const { deviceSignIn } = await import("../auth/pending-device-sign-in");
      const { acceptSession } = await import("../auth/account");
      // Asked again (the panel's Back, then the code again): the same code while it lasts.
      return deviceSignIn(acceptSession).code;
    })
    .onRequest("_atlarix/sign_in_code_wait", (p) => p as Record<string, unknown>, async () => {
      const { pendingDeviceSignIn } = await import("../auth/pending-device-sign-in");
      const done = pendingDeviceSignIn();
      if (!done) throw acp.RequestError.invalidParams(undefined, "No sign-in with a code is under way.");
      return { email: await done };
    })
    .onRequest("_atlarix/sign_out", (p) => p as Record<string, unknown>, async () => {
      const { realServices } = await import("../agent/services");
      await realServices.account.signOut();
      return {};
    })
    .onRequest("_atlarix/providers", (p) => p as Record<string, unknown>, async () => {
      const { realServices } = await import("../agent/services");
      // Each with how many models it offers, from the catalog: the editor lists
      // every provider with that before you connect one (owner).
      const { catalogModelCount } = await import("@/lib/models_dev");
      const providers = await realServices.providers.list();
      const counts = await Promise.all(providers.map((x) => (x.custom ? Promise.resolve(0) : catalogModelCount(x.id))));
      return { providers: providers.map((x, i) => (counts[i] ? { ...x, catalogModels: counts[i] } : x)) };
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
      try {
        await realServices.providers.saveKey(providerId, key.trim());
      } catch (e) {
        throw acp.RequestError.invalidParams(undefined, (e as Error).message);
      }
      await agent.modelsChanged();
      return {};
    })
    // With `key`: check a key before it is saved (Add a provider's Connect).
    .onRequest("_atlarix/provider_test", (p) => p as { providerId: string; key?: string }, async (ctx) => {
      const { realServices } = await import("../agent/services");
      return realServices.providers.test(ctx.params.providerId, ctx.params.key);
    })
    .onRequest("_atlarix/provider_enabled", (p) => p as { providerId: string; on: boolean }, async (ctx) => {
      const { realServices } = await import("../agent/services");
      await realServices.providers.setEnabled(ctx.params.providerId, ctx.params.on === true);
      // Off works like a removed key for the chats on it: they move to Auto.
      await agent.modelsChanged(ctx.params.on === true ? undefined : ctx.params.providerId);
      return {};
    })
    .onRequest("_atlarix/local_providers", (p) => p as Record<string, unknown>, async () => {
      const { realServices } = await import("../agent/services");
      return { local: await realServices.providers.local() };
    })
    // One provider's models in full, for its page: price, context and what each can do.
    .onRequest("_atlarix/models", (p) => p as { providerId: string }, async (ctx) => {
      const id = ctx.params.providerId;
      const { getLanguageModels, stampDeepThinkingSupport } = await import("@/ipc/shared/language_model_helpers");
      const { detectVisionCapability } = await import("@/lib/routing/model-capability-profile");
      const raw = await getLanguageModels({ providerId: id }).catch(() => []);
      const models = stampDeepThinkingSupport({ [id]: raw })[id] ?? [];
      if (!models.length) {
        // No key yet (or the provider lists none live): its models from the
        // catalog, so its page shows what you'd get before you connect it.
        const { catalogModelsFor } = await import("@/lib/models_dev");
        const catalog = await catalogModelsFor(id);
        return { catalog: true, models: catalog.map((m) => ({ ...m, value: `${id}/${m.id}` })) };
      }
      return {
        models: models.map((m) => {
          const cost = (m as { cost?: { input?: number; output?: number } }).cost;
          return {
            value: `${id}/${m.apiName}`,
            name: m.displayName || m.apiName,
            id: m.apiName,
            context: m.contextWindow ?? null,
            price: cost && typeof cost.input === "number" && typeof cost.output === "number" ? { input: cost.input, output: cost.output } : null,
            tools: (m as { supportsToolChoice?: boolean }).supportsToolChoice !== false,
            thinking: !!m.supportsDeepThinking,
            images: detectVisionCapability(id, m.apiName),
          };
        }),
      };
    })
    .onRequest("_atlarix/provider_base_url", (p) => p as { providerId: string; baseUrl: string }, async (ctx) => {
      // A custom provider's address, fixed in place (it was read-only: a typo
      // could only be removed, QA).
      const { realServices } = await import("../agent/services");
      try {
        await realServices.providers.setBaseUrl(ctx.params.providerId, String(ctx.params.baseUrl ?? ""));
      } catch (e) {
        throw acp.RequestError.invalidParams(undefined, (e as Error).message);
      }
      await agent.modelsChanged();
      return {};
    })
    .onRequest("_atlarix/provider_custom", (p) => p as { name: string; baseUrl: string; key: string; models?: string[]; apiFormat?: "openai" | "anthropic" }, async (ctx) => {
      const { realServices, NoModelsListedError } = await import("../agent/services");
      const { name, baseUrl, key, models, apiFormat } = ctx.params;
      if (!name?.trim() || !baseUrl?.trim()) throw acp.RequestError.invalidParams(undefined, "A name and a base URL are needed.");
      if (apiFormat !== undefined && apiFormat !== "openai" && apiFormat !== "anthropic") {
        throw acp.RequestError.invalidParams(undefined, `Unknown API format "${String(apiFormat)}".`);
      }
      try {
        const r = await realServices.providers.addCustom({ name, baseUrl, key: key ?? "", models, apiFormat });
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
      (p) => p as { sessionId: string; action: "list" | "preview" | "resend" | "restore_files"; messageId?: number; text?: string; restore?: boolean },
      async (ctx) => {
        const { sessionId, action, messageId, text, restore } = ctx.params;
        if (action === "list") return { messages: agent.undoList(sessionId) };
        if (messageId == null) throw acp.RequestError.invalidParams(undefined, "Which message?");
        if (action === "preview") return agent.undoPreview(sessionId, Number(messageId));
        if (action === "resend") return agent.undoResend(sessionId, Number(messageId), String(text ?? ""), restore === true);
        if (action === "restore_files") return agent.restoreFiles(sessionId, Number(messageId));
        throw acp.RequestError.invalidParams(undefined, `unknown action ${action}`);
      },
    )
    .onRequest(
      "_atlarix/checkpoint",
      (p) => p as { sessionId: string; action: "files" | "before"; messageId?: number; turnId?: string; path?: string },
      async (ctx) => {
        const { sessionId, action, messageId, turnId, path } = ctx.params;
        if (action === "files" && messageId != null) return { files: await agent.checkpointFiles(sessionId, Number(messageId)) };
        if (action === "before" && turnId && path) return { file: await agent.checkpointBefore(sessionId, turnId, path) };
        throw acp.RequestError.invalidParams(undefined, "Which message, or which turn and file?");
      },
    )
    // "A different model for Plan" and starred chats: the terminal's own state (cli-state.json), shared.
    .onRequest("_atlarix/plan_model", (p) => p as { model?: string | null }, async (ctx) => {
      const models = await import("../agent/models");
      const state = models.readCliState();
      if (ctx.params.model !== undefined) {
        const [provider, ...rest] = String(ctx.params.model ?? "").split("/");
        const planModel = ctx.params.model && provider && rest.length ? { provider, name: rest.join("/") } : undefined;
        models.writeCliState({ ...state, planModel });
        return { model: planModel ? `${planModel.provider}/${planModel.name}` : null };
      }
      return { model: state.planModel ? `${state.planModel.provider}/${state.planModel.name}` : null };
    })
    .onRequest("_atlarix/favorite", (p) => p as { model: string; on: boolean }, async (ctx) => {
      const models = await import("../agent/models");
      const [provider, ...rest] = String(ctx.params.model).split("/");
      if (!provider || !rest.length) throw acp.RequestError.invalidParams(undefined, "Which model?");
      const ref = { provider, name: rest.join("/") };
      const state = models.readCliState();
      const has = state.favorites.some((f) => f.provider === ref.provider && f.name === ref.name);
      if (has !== (ctx.params.on === true)) models.writeCliState(models.toggleFavorite(state, ref));
      await agent.modelsChanged();
      return {};
    })
    .onRequest("_atlarix/star", (p) => p as { sessionId?: string; on?: boolean }, async (ctx) => {
      const models = await import("../agent/models");
      const state = models.readCliState();
      let starred = state.starredSessions ?? [];
      const id = ctx.params.sessionId;
      if (id && ctx.params.on !== undefined) {
        starred = ctx.params.on ? [id, ...starred.filter((x) => x !== id)] : starred.filter((x) => x !== id);
        models.writeCliState({ ...state, starredSessions: starred });
      }
      return { starred };
    })
    // Auto-approve in Atlarix's extension: the rules remembered for this folder, and the whole-folder edit switch.
    .onRequest(
      "_atlarix/permissions",
      (p) => p as { sessionId: string; action: "list" | "revoke" | "edits"; index?: number; on?: boolean },
      async (ctx) => {
        const { realServices } = await import("../agent/services");
        const { readablePermission } = await import("./permission-labels");
        const { appId } = agent.sessionInfo(ctx.params.sessionId);
        const list = async () => {
          const rows = await realServices.permissions.list(appId);
          const folderEdits = rows.some((r) => r.kind === "file" && "scopeValue" in r.revoke && r.revoke.scopeType === "directory" && r.revoke.scopeValue === "." && r.decision === "always_allow");
          return {
            folderEdits,
            rules: rows
              .filter((r) => !(r.kind === "file" && "scopeValue" in r.revoke && r.revoke.scopeValue === "."))
              .map((r) => readablePermission(r)),
          };
        };
        if (ctx.params.action === "edits") {
          await realServices.permissions.setFolderEdits(appId, ctx.params.on === true);
        } else if (ctx.params.action === "revoke") {
          const rows = (await realServices.permissions.list(appId)).filter((r) => !(r.kind === "file" && "scopeValue" in r.revoke && r.revoke.scopeValue === "."));
          const row = rows[Number(ctx.params.index)];
          if (!row) throw acp.RequestError.invalidParams(undefined, "That rule is gone already.");
          await realServices.permissions.revoke(appId, row);
        }
        return list();
      },
    )
    // Past chats in Atlarix's extension: this folder's or every folder's, with mode and star.
    .onRequest("_atlarix/sessions", (p) => p as { cwd?: string; all?: boolean }, async (ctx) => {
      const { listFolderSessions, listAllSessions } = await import("../agent/session");
      const { lineageNote } = await import("@/shared/session-lineage");
      const models = await import("../agent/models");
      const starred = new Set(models.readCliState().starredSessions ?? []);
      const rows = ctx.params.all ? await listAllSessions() : ctx.params.cwd ? await listFolderSessions(ctx.params.cwd) : [];
      return {
        sessions: rows.map((r) => ({
          sessionId: r.id,
          title: r.title,
          updatedAt: new Date(r.updatedAt).toISOString(),
          mode: (r as { workMode?: string | null }).workMode ?? null,
          starred: starred.has(r.id),
          ...("folder" in r ? { folder: (r as unknown as { folder: string }).folder, folderName: (r as unknown as { folderName: string }).folderName } : {}),
          // Where it came from: the panel shows each child under its parent.
          depth: r.depth ?? 0,
          ...(r.parentSessionId ? { parentSessionId: r.parentSessionId, via: r.origin?.via ?? null } : {}),
          ...(lineageNote({ origin: r.origin ?? null, depth: r.depth, runs: r.runs, parentTitle: r.parentTitle })
            ? { lineage: lineageNote({ origin: r.origin ?? null, depth: r.depth, runs: r.runs, parentTitle: r.parentTitle }) }
            : {}),
        })),
      };
    })
    .onRequest("_atlarix/rating_due", (p) => p as { sessionId: string }, (ctx) => agent.ratingDue(ctx.params.sessionId))
    .onRequest("_atlarix/rate", (p) => p as { sessionId: string; rating: number }, (ctx) => agent.rate(ctx.params.sessionId, Number(ctx.params.rating)))
    .onRequest("_atlarix/feedback", (p) => p as { sessionId: string; text: string }, (ctx) => agent.feedback(ctx.params.sessionId, ctx.params.text))
    .onRequest("_atlarix/sessions_watch", (p) => p as { on?: boolean }, async (ctx) => {
      await agent.watchSessions(ctx.params.on === true);
      return {};
    })
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
    .onRequest(
      "_atlarix/mcp",
      (p) =>
        p as {
          sessionId: string;
          action: string;
          id?: number | string;
          enabled?: boolean;
          name?: string;
          command?: string;
          url?: string;
          text?: string;
          query?: string;
          offset?: number;
          optionId?: string;
          values?: Record<string, string>;
          secret?: string;
          serverName?: string;
        },
      async (ctx) => {
        const { realServices } = await import("../agent/services");
        const mcp = realServices.mcp;
        const { appId } = agent.sessionInfo(ctx.params.sessionId);
        const p = ctx.params;
        const id = Number(p.id);
        const accountId = String(p.id ?? "");
        switch (p.action) {
          case "list":
            return { servers: await mcp.list(appId) };
          case "set":
            await mcp.setEnabled(id, p.enabled === true);
            return { servers: await mcp.list(appId) };
          case "add":
            await mcp.add(appId, { name: String(p.name ?? ""), command: p.command, url: p.url });
            return { servers: await mcp.list(appId) };
          case "remove":
            await mcp.remove(id);
            return { servers: await mcp.list(appId) };
          case "test":
            return { result: await mcp.test(id) };
          case "tools":
            return { tools: await mcp.tools(id).catch(() => []) };
          case "found":
            return { found: await mcp.found(appId).catch(() => []) };
          case "defaults":
            return { defaults: await mcp.defaults(appId).catch(() => []) };
          case "import":
            await mcp.importFound(appId, String((p as { key?: string }).key ?? ""));
            return { servers: await mcp.list(appId) };
          case "oauth":
            // Opens the server's sign-in page (via the editor) and resolves once it's done or refused.
            return { result: await mcp.signIn(id) };
          // The marketplace, "add your own", and the account's web servers.
          case "catalog":
            return await mcp.catalog(appId, String(p.query ?? ""), Number(p.offset ?? 0));
          case "install":
            return { added: await mcp.install(appId, String(p.name ?? ""), String(p.optionId ?? ""), p.values ?? {}) };
          case "paste":
            return await mcp.paste(appId, String(p.text ?? ""));
          case "account":
            return { servers: await mcp.account() };
          case "accountSet":
            await mcp.accountSetEnabled(appId, accountId, p.enabled === true);
            return { servers: await mcp.account() };
          case "accountRemove":
            await mcp.accountRemove(accountId);
            return { servers: await mcp.account() };
          case "accountSignIn":
            // The page opens through the editor (stderr), as a local server's does.
            return { result: await mcp.accountSignIn(appId, accountId, () => {}) };
          case "accountSecret":
            await mcp.accountSecret(appId, accountId, String(p.secret ?? ""));
            return { servers: await mcp.account() };
          case "setKey":
            await mcp.setKey(id, String(p.secret ?? ""));
            return { servers: await mcp.list(appId) };
          // A suggestion card in Atlarix's editor extension.
          case "suggestConnect":
            return { added: await mcp.suggestConnect(String(p.id ?? ""), p.optionId, p.values ?? {}) };
          case "suggestFinish":
            return { result: await mcp.suggestFinish(String(p.id ?? "")) };
          case "suggestDismiss":
            await mcp.suggestDismiss(String(p.id ?? ""));
            return {};
          // A logo for the editor's rows and cards (a checked data: URL, or null).
          case "icon":
            return {
              icon: await mcp
                .icon(appId, { name: p.name, url: p.url, serverName: p.serverName })
                .catch(() => null),
            };
          default:
            throw acp.RequestError.invalidParams(undefined, `unknown action ${p.action}`);
        }
      },
    )
    .onRequest(
      "_atlarix/automations",
      (p) =>
        p as {
          sessionId: string;
          action: "list" | "create" | "update" | "toggle" | "remove" | "run" | "read" | "servers" | "tools";
          id?: string;
          draft?: AutomationDraft;
          enabled?: boolean;
          all?: boolean;
          runIds?: string[];
          serverId?: number;
          serverRef?: string;
        },
      async (ctx) => {
        // The editor's Automations page: the same services as the CLI's /automations.
        const { realServices } = await import("../agent/services");
        const a = realServices.automations;
        const p = ctx.params;
        const { appId } = agent.sessionInfo(p.sessionId);
        const state = async () => ({
          automations: await a.list(p.all ? null : appId),
          runs: await a.runs(appId).catch(() => []),
        });
        switch (p.action) {
          case "list":
            return state();
          case "create":
            await a.create(appId, p.draft!);
            return state();
          case "update":
            await a.update(String(p.id), p.draft!);
            return state();
          case "toggle":
            await a.toggle(String(p.id), p.enabled === true);
            return state();
          case "remove":
            await a.remove(String(p.id));
            return state();
          case "run":
            await a.runNow(String(p.id));
            return state();
          case "read":
            await a.markRead(p.runIds ?? []);
            return {};
          case "servers":
            // This folder's and the account's, each with a ref (`local:<id>` / `account:<name>`).
            return { servers: await realServices.mcp.watchable(appId) };
          case "tools":
            return {
              tools: await realServices.mcp
                .watchTools(p.serverRef ?? (p.serverId != null ? `local:${p.serverId}` : ""))
                .catch(() => []),
            };
          default:
            throw new Error(`Unknown automations action: ${String(p.action)}`);
        }
      },
    )
    .onRequest(
      "_atlarix/interject",
      (p) => p as { sessionId: string; text: string; kind?: "steer" | "queue" },
      (ctx) => agent.interject(ctx.params.sessionId, String(ctx.params.text ?? ""), ctx.params.kind === "queue" ? "queue" : "steer"),
    )
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
  // Links main would open in a browser (an MCP server's sign-in) go to the editor to open.
  process.env.ATLARIX_OPEN_URLS_VIA_STDERR = "1";
  const { installProcessGuards } = await import("../shutdown");
  installProcessGuards();

  const { AgentSession, seedDevProvider, listFolderSessions, changeFolderSession } = await import("../agent/session");
  const devModel = opts.devUrl
    ? await seedDevProvider({ baseUrl: opts.devUrl, model: opts.devModel ?? "fake-model", apiKey: opts.apiKey, apiFormat: opts.devFormat })
    : undefined;
  const models = await import("../agent/models");
  const cliState = opts.devUrl ? null : models.readCliState();
  // Dev mode's choices, in memory only (never ~/.atlarix/cli-state.json).
  const devPick: { model: typeof devModel; effort: { effort: string; deepThinking: boolean } } = {
    model: devModel,
    effort: { effort: "", deepThinking: false },
  };
  const { setRuntimeSettingsOverride } = await import("../../main/settings");
  // The terminal's own level, always, even unset: the app's (user-settings.json)
  // leaked into requests while the CLI showed its own (QA: header showed the
  // default, the request carried the app's "low").
  if (cliState) setRuntimeSettingsOverride({ deepThinking: cliState.deepThinking ?? false, effort: cliState.effort ?? "" });
  // Free Auto has no /effort; the plan is looked up at most once a minute.
  let kindSeen: { at: number; kind: string | null } | null = null;
  const accountKind = async (): Promise<string | null> => {
    if (kindSeen && Date.now() - kindSeen.at < 60_000) return kindSeen.kind;
    const { realServices } = await import("../agent/services");
    const kind = (await realServices.account.kind?.().catch(() => null)) ?? null;
    // A failed lookup is not remembered: the next ask tries again (QA R4).
    if (kind) kindSeen = { at: Date.now(), kind };
    return kind;
  };

  const agent = new AcpAgent({
    // Dev mode (own endpoint) needs no account, as in the CLI.
    ...(opts.devUrl
      ? {}
      : {
          signedIn: async () => {
            const { currentEmail } = await import("../auth/account");
            return Boolean(await currentEmail());
          },
        }),
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
      // Dev mode: the scratch folder's models (the seeded endpoint, and any
      // provider added there), with their /effort levels.
      // Atlarix Auto needs an account, which dev mode has none of: not offered.
      // The model and level chosen here live in memory (QA B1: the level was
      // never echoed back, so the editor's control jumped to the default).
      if (devModel) {
        const options = (await models.loadModelOptions().catch(() => [])).filter((o) => o.provider !== "compass");
        const seeded = options.some((o) => o.provider === devModel.provider && o.name === devModel.name);
        return {
          options: seeded ? options : [{ ...devModel, label: devModel.name }, ...options],
          current: devPick.model,
          effort: devPick.effort,
        };
      }
      const state = models.readCliState();
      return {
        options: await models.loadModelOptions(),
        current: state.model,
        picks: { favorites: state.favorites, recent: state.recent },
        effort: { effort: state.effort ?? "", deepThinking: state.deepThinking ?? false },
        freeAccount: (await accountKind()) === "free",
      };
    },
    setSessionMcpServers: async (sessionId, servers) => {
      const { mcpManager } = await import("@/ipc/utils/mcp_manager");
      if (servers.length > 0) mcpManager.setSessionServers(sessionId, servers);
      else mcpManager.clearSessionServers(sessionId);
    },
    rememberModel: (ref) => {
      if (opts.devUrl) devPick.model = ref;
      else models.writeCliState(models.rememberChoice(models.readCliState(), ref));
    },
    computerUse: {
      isOn: (m) => isComputerUseOn(m),
      set: (m, on) => setComputerUse(m, on),
      notice: () => computerUseGrantNotice(),
    },
    setEffort: (patch) => {
      setRuntimeSettingsOverride(patch);
      if (opts.devUrl) devPick.effort = { effort: patch.effort ?? "", deepThinking: patch.deepThinking ?? false };
      else models.writeCliState({ ...models.readCliState(), ...patch });
    },
    listSessions: (cwd) => listFolderSessions(cwd),
    changeSession: (sessionId, change) => changeFolderSession(sessionId, change),
  });

  if (!opts.devUrl) {
    opts.startBridge?.();
    // The provider and model catalog stays current here too: only the desktop
    // app refreshed it, so without the app it went stale (owner).
    const { startModelsDevRefresh } = await import("@/lib/models_dev");
    startModelsDevRefresh();
    const { startMcpRegistryRefresh } = await import("@/lib/mcp/registry-catalog");
    startMcpRegistryRefresh();
    // Automations run in whichever Atlarix is open, the editor included: with
    // only VS Code open they never fired. runner.ts leases each run, so with
    // the app, the CLI or another window open too, every run still happens once.
    const { startAutomationRunner } = await import("../../lib/automations/runner");
    startAutomationRunner();
  }

  const connection = buildAgentApp(agent, opts.version, { chromeStatus: opts.chromeStatus }).connect(acp.ndJsonStream(stdoutStream(), stdinStream()));

  await connection.closed;
  await agent.closeAll();
}
