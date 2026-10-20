/**
 * One `atlarix acp` process for this window, shared by every chat in it.
 *
 * The process is the whole agent: Atlarix's sessions, tools, approvals, the
 * Chrome bridge, messages between sessions. This file only starts it, speaks
 * ACP to it, and routes what comes back to the chat that owns each session.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ContentBlock,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
} from "@agentclientprotocol/sdk";

export interface AccountInfo {
  email: string | null;
  kind: "signed-out" | "free" | "pro" | "payg" | null;
  balanceCents: number | null;
  usage: { tokens: number; cachedTokens: number; costUsd: number; contextPercent: number | null } | null;
  manageUrl: string;
  pricingUrl: string;
}
export interface ProviderInfo {
  id: string;
  name: string;
  hasKey: boolean;
  keyUrl?: string;
  keyHint?: string;
  custom?: boolean;
}
export interface McpServer {
  id: number;
  name: string;
  transport: string;
  enabled: boolean;
}
export interface McpResult {
  servers?: McpServer[];
  result?: { ok: boolean; error?: string; needsOAuth?: boolean };
}

export interface SessionListener {
  update(n: SessionNotification): void;
  /** `withdrawn`: aborted when the agent takes the card back (something else answered it). */
  permission(req: RequestPermissionRequest, withdrawn: AbortSignal): Promise<RequestPermissionResponse>;
  peerWaiting(): void;
  /** What is running in the session changed. */
  tasksChanged?(count: number): void;
  /** Background work finished while the session was idle: the agent can deal with it now. */
  backgroundReady?(): void;
  /** Messages sent while the turn runs changed. */
  pendingChanged?(items: Array<{ id: string; text: string; kind: string }>): void;
  /** What the working line says instead of "Thinking" ("Couldn't connect, retrying…"), or null. */
  /** `following`: another surface runs this session's turn (title says which); absent for a retry note. */
  workingChanged?(title: string | null, following?: boolean): void;
  /** Text you typed into a turn you stopped that the agent never got: back to the input. */
  unsent?(text: string): void;
  /** An automation finished a run. */
  automationRun?(run: { name: string; status: string; summary: string | null }): void;
  /** Atlarix suggests connecting an MCP server (or a suggestion was answered: `resolved`). */
  mcpSuggestion?(card: Record<string, unknown>): void;
}

export interface ConnectionOptions {
  binary: string;
  cwd: string;
  version: string;
  /** The host editor (VS Code, Cursor, Windsurf…), reported with usage. */
  editor?: string;
  log: (line: string) => void;
  /** A page to open: Atlarix's sign-in, or an MCP server's (the CLI prints them on stderr). */
  openUrl: (url: string, kind: "sign-in" | "open") => void;
  onExit: (code: number | null) => void;
  /** A session to open in a panel (a fork made with `/fork`). */
  openSession?: (sessionId: string) => void;
}

/** ACP's "sign in first" (RequestError.authRequired). */
export function isAuthRequired(e: unknown): boolean {
  const err = e as { code?: number; message?: string };
  return err?.code === -32000 || /sign in|auth.?required/i.test(err?.message ?? "");
}

export class AtlarixConnection {
  private child: ChildProcess | null = null;
  private conn: acp.ClientConnection | null = null;
  private readonly listeners = new Map<string, SessionListener>();
  init: InitializeResponse | null = null;

  constructor(private readonly opts: ConnectionOptions) {}

  get alive(): boolean {
    return this.conn != null;
  }

  async start(): Promise<InitializeResponse> {
    const child = spawn(this.opts.binary, ["acp"], {
      cwd: this.opts.cwd,
      env: {
        ...process.env,
        ATLARIX_ACP_CLIENT: "vscode",
        ...(this.opts.editor ? { ATLARIX_ACP_EDITOR: this.opts.editor } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      let nl: number;
      while ((nl = stderr.indexOf("\n")) >= 0) {
        const line = stderr.slice(0, nl);
        stderr = stderr.slice(nl + 1);
        this.opts.log(line);
        const m = /Atlarix (sign-in|open):\s*(https?:\/\/\S+)/.exec(line);
        if (m) this.opts.openUrl(m[2]!, m[1] === "sign-in" ? "sign-in" : "open");
      }
    });
    child.on("exit", (code) => {
      this.conn = null;
      this.child = null;
      this.opts.onExit(code);
    });

    const client = acp
      .client({ name: "atlarix-vscode" })
      .onRequest("session/request_permission", (ctx) => {
        const l = this.listeners.get(ctx.params.sessionId);
        if (!l) return { outcome: { outcome: "cancelled" } };
        return l.permission(ctx.params, ctx.signal);
      })
      .onNotification("session/update", (ctx) => {
        this.listeners.get(ctx.params.sessionId)?.update(ctx.params);
      })
      .onNotification(
        "_atlarix/peer_waiting",
        (p) => p as { sessionId: string },
        (ctx) => {
          this.listeners.get(ctx.params.sessionId)?.peerWaiting();
        },
      )
      .onNotification(
        "_atlarix/tasks_changed",
        (p) => p as { sessionId: string; count?: number },
        (ctx) => {
          this.listeners.get(ctx.params.sessionId)?.tasksChanged?.(Number(ctx.params.count ?? 0));
        },
      )
      .onNotification(
        "_atlarix/working",
        (p) => p as { sessionId: string; title?: string | null; following?: boolean },
        (ctx) => {
          this.listeners.get(ctx.params.sessionId)?.workingChanged?.(ctx.params.title ?? null, ctx.params.following);
        },
      )
      // `/fork` typed in the panel: open the copy here.
      .onNotification(
        "_atlarix/open_session",
        (p) => p as { sessionId: string },
        (ctx) => {
          if (ctx.params.sessionId) this.opts.openSession?.(ctx.params.sessionId);
        },
      )
      .onNotification(
        "_atlarix/unsent",
        (p) => p as { sessionId: string; text?: string },
        (ctx) => {
          if (ctx.params.text) this.listeners.get(ctx.params.sessionId)?.unsent?.(ctx.params.text);
        },
      )
      .onNotification(
        "_atlarix/pending",
        (p) => p as { sessionId: string; items?: Array<{ id: string; text: string; kind: string }> },
        (ctx) => {
          this.listeners.get(ctx.params.sessionId)?.pendingChanged?.(ctx.params.items ?? []);
        },
      )
      .onNotification(
        "_atlarix/automation_run",
        (p) => p as { sessionId: string; name?: string; status?: string; summary?: string | null },
        (ctx) => {
          const p = ctx.params;
          this.listeners.get(p.sessionId)?.automationRun?.({ name: p.name ?? "Automation", status: p.status ?? "ok", summary: p.summary ?? null });
        },
      )
      .onNotification(
        "_atlarix/mcp_suggestion",
        (p) => p as { sessionId: string } & Record<string, unknown>,
        (ctx) => {
          const { sessionId, ...card } = ctx.params;
          this.listeners.get(sessionId)?.mcpSuggestion?.(card);
        },
      )
      .onNotification(
        "_atlarix/background_ready",
        (p) => p as { sessionId: string },
        (ctx) => {
          this.listeners.get(ctx.params.sessionId)?.backgroundReady?.();
        },
      );

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    this.conn = client.connect(stream);
    this.init = await this.conn.agent.request("initialize", {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { _meta: { atlarix: { version: 1 } } },
      clientInfo: { name: "atlarix-vscode", version: this.opts.version },
    });
    return this.init;
  }

  private get agent(): acp.ClientContext {
    if (!this.conn) throw new Error("Atlarix is not running.");
    return this.conn.agent;
  }

  listen(sessionId: string, l: SessionListener): void {
    this.listeners.set(sessionId, l);
  }

  /** Stop listening, unless another chat has taken this session over since. */
  forget(sessionId: string, l?: SessionListener): void {
    if (!l || this.listeners.get(sessionId) === l) this.listeners.delete(sessionId);
  }

  /** The chat now showing this session, if any. */
  listening(sessionId: string): boolean {
    return this.listeners.has(sessionId);
  }

  newSession(cwd: string): Promise<NewSessionResponse> {
    return this.agent.request("session/new", { cwd, mcpServers: [] });
  }

  loadSession(cwd: string, sessionId: string): Promise<LoadSessionResponse> {
    return this.agent.request("session/load", { cwd, sessionId, mcpServers: [] }) as Promise<LoadSessionResponse>;
  }

  listSessions(cwd: string): Promise<ListSessionsResponse> {
    return this.agent.request("session/list", { cwd });
  }

  prompt(sessionId: string, prompt: ContentBlock[], meta?: Record<string, unknown>): Promise<PromptResponse> {
    return this.agent.request("session/prompt", { sessionId, prompt, ...(meta ? { _meta: { atlarix: meta } } : {}) });
  }

  cancel(sessionId: string): void {
    void this.agent.notify("session/cancel", { sessionId }).catch(() => {});
  }

  async setOption(sessionId: string, configId: string, value: string): Promise<SessionConfigOption[]> {
    const r = await this.agent.request("session/set_config_option", { sessionId, configId, value });
    return r.configOptions;
  }

  authenticate(): Promise<unknown> {
    return this.agent.request("authenticate", { methodId: "atlarix-browser" });
  }

  status(): Promise<{ chrome?: string; recap?: boolean }> {
    return this.agent.request<{ chrome?: string; recap?: boolean }>("_atlarix/status", {});
  }

  recap(sessionId: string): Promise<{ text: string | null }> {
    return this.agent.request<{ text: string | null }>("_atlarix/recap", { sessionId });
  }

  setRecap(on: boolean): Promise<unknown> {
    return this.agent.request("_atlarix/recap_setting", { on });
  }

  /** Usage analytics: the setting shared with the app and the CLI. */
  analyticsConsent(): Promise<{ consent: "opted_in" | "opted_out" | "unset" }> {
    return this.agent.request("_atlarix/analytics_consent", {});
  }

  setAnalyticsConsent(consent: "opted_in" | "opted_out"): Promise<unknown> {
    return this.agent.request("_atlarix/analytics_set", { consent });
  }

  handoff(sessionId: string): Promise<unknown> {
    return this.agent.request("_atlarix/handoff", { sessionId });
  }

  account(sessionId: string | null): Promise<AccountInfo> {
    return this.agent.request<AccountInfo>("_atlarix/account", sessionId ? { sessionId } : {});
  }

  checkout(kind: "pro" | "credit", amountCents?: number): Promise<{ url: string }> {
    return this.agent.request<{ url: string }>("_atlarix/checkout", { kind, ...(amountCents ? { amountCents } : {}) });
  }

  signOut(): Promise<unknown> {
    return this.agent.request("_atlarix/sign_out", {});
  }

  providers(): Promise<{ providers: ProviderInfo[] }> {
    return this.agent.request<{ providers: ProviderInfo[] }>("_atlarix/providers", {});
  }

  saveKey(providerId: string, key: string): Promise<unknown> {
    return this.agent.request("_atlarix/provider_key", { providerId, key });
  }

  removeKey(providerId: string): Promise<unknown> {
    return this.agent.request("_atlarix/provider_key", { providerId, key: null });
  }

  testKey(providerId: string): Promise<{ status: "works" | "rejected" | "unchecked" | "unreachable"; detail: string }> {
    return this.agent.request("_atlarix/provider_test", { providerId });
  }

  addCustomProvider(p: { name: string; baseUrl: string; key: string; models?: string[]; apiFormat?: "openai" | "anthropic" }): Promise<{ id: string; models: number }> {
    return this.agent.request("_atlarix/provider_custom", p);
  }

  undo(
    sessionId: string,
    action: "list" | "preview" | "resend",
    args: { messageId?: number; text?: string; restore?: boolean } = {},
  ): Promise<{ messages?: Array<{ id: number; text: string }>; filesChanged?: string[]; createdFiles?: string[]; stopReason?: string }> {
    return this.agent.request("_atlarix/undo", { sessionId, action, ...args });
  }

  changeSession(sessionId: string, action: "rename" | "delete", title?: string): Promise<unknown> {
    return this.agent.request("_atlarix/session", { sessionId, action, ...(title != null ? { title } : {}) });
  }

  /** An Atlarix method the chat screens call directly (allow-listed in protocol.ts). */
  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    return this.agent.request<T>(method, params);
  }

  mcp(sessionId: string, action: string, args: Record<string, unknown> = {}): Promise<McpResult> {
    return this.agent.request<McpResult>("_atlarix/mcp", { sessionId, action, ...args });
  }

  /**
   * Let the agent go. EOF, not a kill: it closes its sessions, runs its exit
   * sweep and releases its temp lease, then exits (bounded). Killed, it never
   * did on Windows, where kill() is TerminateProcess (QA E11). Resolves once
   * it has exited, for deactivate to wait on: on Windows the agent also dies
   * with the extension host (libuv's job object). The kill is only for one
   * that hangs.
   */
  dispose(): Promise<void> {
    const child = this.child;
    this.conn?.close();
    this.conn = null;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    child.stdin?.end();
    return new Promise((resolve) => {
      const backstop = setTimeout(() => {
        child.kill();
        resolve();
      }, 5_000);
      backstop.unref?.();
      child.once("exit", () => {
        clearTimeout(backstop);
        resolve();
      });
    });
  }
}
