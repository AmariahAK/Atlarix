/**
 * One editor thread = one `AgentSession`. This file keeps them, turns each
 * session's state changes into ACP updates and prompts, and answers the
 * editor's requests (session/new, prompt, cancel, mode and model).
 *
 * The CLI's session does the work; nothing here decides anything an agent
 * decides. What this owns is the protocol's shape:
 * - a prompt is one request that resolves when the turn is over;
 * - updates are deltas (updates.ts);
 * - an approval is a question to the editor (permissions.ts).
 */
import path from "node:path";
import {
  RequestError,
  type AgentContext,
  type ContentBlock,
  type ListSessionsResponse,
  type NewSessionResponse,
  type PromptResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentSession, ModelChoice, SessionState, WorkMode } from "../agent/session";
import { promptInput } from "./content";
import {
  approvalMode,
  approvalOptions,
  approvalOwner,
  approvalToolCall,
  MCP_CONSENT_OPTIONS,
  mcpConsentDecision,
  mcpConsentToolCall,
} from "./permissions";
import { diffUpdates, type Emitted } from "./updates";

const MODES: Array<{ id: WorkMode; name: string; description: string }> = [
  { id: "build", name: "Build", description: "Make changes; every edit and command waits for your yes." },
  { id: "ask", name: "Explore", description: "Read and answer; changes nothing." },
  { id: "plan", name: "Plan", description: "Write a plan to review before building." },
  { id: "debug", name: "Debug", description: "Find the cause before fixing it." },
  { id: "review", name: "Review", description: "Review the changes in this folder." },
];

export interface AcpDeps {
  /** A new, started session in `cwd` (the TUI's own construction). */
  createSession(cwd: string): Promise<AgentSession>;
  /** The models the CLI offers, and the one it would pick (cli-state.json). */
  models(): Promise<{ options: Array<{ provider: string; name: string; label: string }>; current?: ModelChoice }>;
  /** Remember a model the user picked, as the TUI's /model does. */
  rememberModel(ref: ModelChoice): void;
  /** This folder's stored sessions, newest first (the TUI's /resume list). */
  listSessions(cwd: string): Promise<Array<{ id: string; title: string | null; updatedAt: Date | string }>>;
}

function isAuthError(msg: string | null | undefined): boolean {
  return !!msg && /ATLARIX_AUTH_REQUIRED|sign in to use atlarix|please sign in/i.test(msg);
}

class Thread {
  readonly emitted: Emitted = new Map();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly asked = new Set<string>();
  private turn: { done: () => void; cancelled: boolean } | null = null;
  private lastTitle: string | null = null;
  private lastPlan: string | null = null;

  constructor(
    readonly id: string,
    readonly cwd: string,
    readonly session: AgentSession,
    private readonly client: () => AgentContext,
  ) {
    session.on("change", (s: SessionState) => this.onChange(s));
    session.on("peer-message", () => this.onPeerMessage());
  }

  /** Updates go out in order: each waits for the one before it. */
  private send(update: SessionUpdate): Promise<unknown> {
    this.chain = this.chain
      .then(() => this.client().notify("session/update", { sessionId: this.id, update }))
      .catch(() => {});
    return this.chain;
  }

  flush(): Promise<unknown> {
    return this.chain;
  }

  private onChange(s: SessionState): void {
    for (const u of diffUpdates(s.cells, this.emitted)) void this.send(u);
    for (const a of s.approvals) {
      if (this.asked.has(a.operationId)) continue;
      this.asked.add(a.operationId);
      const owner = approvalOwner(a, s.cells);
      void this.flush().then(async () => {
        const toolCall = approvalToolCall(a, owner ?? undefined);
        const r = await this.client()
          .request("session/request_permission", {
            sessionId: this.id,
            toolCall,
            options: approvalOptions(a, owner != null),
          })
          .catch(() => ({ outcome: { outcome: "cancelled" as const } }));
        const mode = approvalMode(a, r.outcome);
        await this.session.answerApproval(a.operationId, mode);
        // A prompt with its own card: close it. One inside a tool call is
        // finished by that call's own updates.
        if (!owner) {
          void this.send({
            sessionUpdate: "tool_call_update",
            toolCallId: toolCall.toolCallId,
            status: mode === "deny" ? "failed" : "completed",
          });
        }
      });
    }
    const c = s.mcpConsent;
    if (c && !this.asked.has(`mcp:${c.requestId}`)) {
      this.asked.add(`mcp:${c.requestId}`);
      void this.flush().then(async () => {
        const r = await this.client()
          .request("session/request_permission", {
            sessionId: this.id,
            toolCall: mcpConsentToolCall(c),
            options: MCP_CONSENT_OPTIONS,
          })
          .catch(() => ({ outcome: { outcome: "cancelled" as const } }));
        await this.session.answerMcpConsent(mcpConsentDecision(r.outcome));
      });
    }
    if (this.turn && !s.busy) {
      // Idle for a moment, not just between two chained turns (a queued steer
      // opens the next one the instant this one ends).
      setTimeout(() => {
        if (this.turn && !this.session.state.busy) this.turn.done();
      }, 60);
    }
  }

  /**
   * Another session messaged this one while idle. An editor starts turns itself,
   * so the message waits (main keeps it queued) and the next prompt reads it.
   * Say so, so it isn't a surprise.
   */
  private onPeerMessage(): void {
    void this.send({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "\n\n📨 A message from another Atlarix session arrived. Send anything (\"go on\") and I'll read it.\n",
      },
    });
  }

  /** Replay what is already in the session (session/load). */
  async replay(): Promise<void> {
    for (const u of diffUpdates(this.session.state.cells, this.emitted, { replay: true })) void this.send(u);
    await this.flush();
  }

  async prompt(blocks: readonly ContentBlock[]): Promise<PromptResponse> {
    const { text, images } = promptInput(blocks, this.cwd);
    // Cells already on screen (the user's own message among them) are not news.
    diffUpdates(this.session.state.cells, this.emitted);
    const errorBefore = this.session.state.lastError;
    const slash = /^\/(\w+)\s*$/.exec(text);
    if (slash?.[1] === "compact") {
      const r = await this.session.compact();
      await this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: r.message } });
      return { stopReason: "end_turn" };
    }
    const turn = { done: () => {}, cancelled: false };
    const finished = new Promise<void>((resolve) => (turn.done = resolve));
    this.turn = turn;
    try {
      if (slash?.[1] === "build" && this.session.state.planReady) {
        await this.session.buildPlan(this.session.state.planReady.planId);
      } else if (this.session.state.question) {
        // The last turn ended on a question (ask_user): this prompt is the answer.
        await this.session.answerQuestion([text]);
      } else {
        await this.session.submit(text || "(attachment)", images.length ? { images } : undefined);
      }
      if (!this.session.state.busy) turn.done();
      await finished;
    } finally {
      this.turn = null;
    }
    for (const u of diffUpdates(this.session.state.cells, this.emitted)) void this.send(u);
    await this.afterTurn();
    await this.flush();
    if (turn.cancelled) return { stopReason: "cancelled" };
    const err = this.session.state.lastError;
    if (err && err !== errorBefore) {
      if (isAuthError(err)) throw RequestError.authRequired(undefined, "Sign in to Atlarix first (`atlarix login`).");
      throw RequestError.internalError(undefined, err);
    }
    return { stopReason: "end_turn" };
  }

  private async afterTurn(): Promise<void> {
    const s = this.session.state;
    if (s.contextUsed != null && s.contextLimit) {
      void this.send({
        sessionUpdate: "usage_update",
        used: s.contextUsed,
        size: s.contextLimit,
        ...(s.costUsd > 0 ? { cost: { amount: s.costUsd, currency: "USD" } } : {}),
      });
    }
    if (s.title && s.title !== this.lastTitle) {
      this.lastTitle = s.title;
      void this.send({ sessionUpdate: "session_info_update", title: s.title });
    }
    if (s.question) {
      const lines = s.question.items.map((q, i) => {
        const opts = q.options?.length ? `\n${q.options.map((o) => `   • ${o}`).join("\n")}` : "";
        return `${s.question!.items.length > 1 ? `${i + 1}. ` : ""}${q.question}${opts}`;
      });
      void this.send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `\n\n${lines.join("\n\n")}\n\n(Reply with your answer.)` },
      });
    }
    const plan = s.planReady?.planId ?? null;
    if (plan !== this.lastPlan) {
      this.lastPlan = plan;
      void this.send(commandsUpdate(!!plan));
    }
  }

  async cancel(): Promise<void> {
    if (this.turn) this.turn.cancelled = true;
    await this.session.interrupt();
  }
}

function commandsUpdate(planReady: boolean): SessionUpdate {
  return {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "compact", description: "Summarize the conversation so far to free up context." },
      ...(planReady ? [{ name: "build", description: "Build the plan that is ready for review." }] : []),
    ],
  };
}

export class AcpAgent {
  private readonly threads = new Map<string, Thread>();
  private client: AgentContext | null = null;

  constructor(private readonly deps: AcpDeps) {}

  /** The connection's client side, for updates sent outside a request. */
  attach(client: AgentContext): void {
    this.client = client;
  }

  private ctx = (): AgentContext => {
    if (!this.client) throw new Error("ACP connection not ready");
    return this.client;
  };

  private thread(id: string): Thread {
    const t = this.threads.get(id);
    if (!t) throw RequestError.resourceNotFound(id);
    return t;
  }

  private async configOptions(t: Thread): Promise<SessionConfigOption[]> {
    const { options, current } = await this.deps.models().catch(() => ({ options: [], current: undefined }));
    const chosen = t.session.model ?? current;
    const out: SessionConfigOption[] = [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: t.session.state.mode,
        options: MODES.map((m) => ({ value: m.id, name: m.name, description: m.description })),
      },
    ];
    if (options.length) {
      const key = (m: { provider: string; name: string }) => `${m.provider}/${m.name}`;
      out.push({
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: chosen ? key(chosen) : key(options[0]!),
        options: options.map((o) => ({ value: key(o), name: o.label })),
      });
    }
    return out;
  }

  private modes(t: Thread): SessionModeState {
    return {
      currentModeId: t.session.state.mode,
      availableModes: MODES.map((m) => ({ id: m.id, name: m.name, description: m.description })),
    };
  }

  private async open(cwd: string, sessionId?: string): Promise<Thread> {
    if (!path.isAbsolute(cwd)) throw RequestError.invalidParams(undefined, "cwd must be an absolute path");
    const session = await this.deps.createSession(cwd);
    try {
      if (sessionId) await session.resume(sessionId);
      else await session.open();
    } catch (e) {
      await session.close().catch(() => {});
      const msg = (e as Error).message ?? String(e);
      if (isAuthError(msg)) throw RequestError.authRequired(undefined, "Sign in to Atlarix first (`atlarix login`).");
      throw e;
    }
    const t = new Thread(session.sessionId, cwd, session, this.ctx);
    this.threads.set(t.id, t);
    return t;
  }

  async newSession(cwd: string): Promise<NewSessionResponse> {
    const t = await this.open(cwd);
    setTimeout(() => void this.ctx().notify("session/update", { sessionId: t.id, update: commandsUpdate(false) }).catch(() => {}), 0);
    return { sessionId: t.id, configOptions: await this.configOptions(t), modes: this.modes(t) };
  }

  async loadSession(cwd: string, sessionId: string): Promise<{ configOptions: SessionConfigOption[]; modes: SessionModeState }> {
    const existing = this.threads.get(sessionId);
    const t = existing ?? (await this.open(cwd, sessionId));
    await t.replay();
    return { configOptions: await this.configOptions(t), modes: this.modes(t) };
  }

  async listSessions(cwd: string | undefined): Promise<ListSessionsResponse> {
    if (!cwd) return { sessions: [] };
    const rows = await this.deps.listSessions(cwd);
    return {
      sessions: rows.map((r) => ({
        sessionId: r.id,
        cwd,
        title: r.title,
        updatedAt: new Date(r.updatedAt).toISOString(),
      })),
    };
  }

  prompt(sessionId: string, blocks: readonly ContentBlock[]): Promise<PromptResponse> {
    return this.thread(sessionId).prompt(blocks);
  }

  async cancel(sessionId: string): Promise<void> {
    await this.threads.get(sessionId)?.cancel();
  }

  async setConfigOption(sessionId: string, configId: string, value: unknown): Promise<SessionConfigOption[]> {
    const t = this.thread(sessionId);
    if (configId === "mode") this.setMode(t, String(value));
    else if (configId === "model") {
      const [provider, ...rest] = String(value).split("/");
      const ref = { provider: provider!, name: rest.join("/") };
      t.session.setModel(ref);
      this.deps.rememberModel(ref);
    } else throw RequestError.invalidParams(undefined, `unknown option ${configId}`);
    return this.configOptions(t);
  }

  setSessionMode(sessionId: string, modeId: string): void {
    this.setMode(this.thread(sessionId), modeId);
  }

  private setMode(t: Thread, modeId: string): void {
    const m = MODES.find((x) => x.id === modeId);
    if (!m) throw RequestError.invalidParams(undefined, `unknown mode ${modeId}`);
    t.session.setMode(m.id);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.threads.values()].map((t) => t.session.close().catch(() => {})));
    this.threads.clear();
  }
}
