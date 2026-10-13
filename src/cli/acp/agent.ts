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
  type PlanEntry,
  type PromptResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { parsePlanChecklist, type PlanChecklistStep } from "@/lib/tasks/plan-checklist";
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
import { groupOptions, type ModelOption } from "../agent/models";

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
  models(): Promise<{
    options: Array<Pick<ModelOption, "provider" | "name" | "label"> & Partial<ModelOption>>;
    current?: ModelChoice;
    /** The TUI's favourites and recents, so the editor's picker leads with them too. */
    picks?: { favorites: ModelChoice[]; recent: ModelChoice[] };
    /** Deep thinking (ctrl+t in the terminal), shared with the TUI. */
    deepThinking?: boolean;
  }>;
  /** Remember a model the user picked, as the TUI's /model does. */
  rememberModel(ref: ModelChoice): void;
  /** Deep thinking on or off, as the TUI's ctrl+t. */
  setDeepThinking?(on: boolean): void;
  /** This folder's stored sessions, newest first (the TUI's /resume list). */
  listSessions(cwd: string): Promise<Array<{ id: string; title: string | null; updatedAt: Date | string }>>;
  /** Rename or delete a stored session (the editor's Past chats). */
  changeSession?(sessionId: string, change: { rename: string } | { delete: true }): Promise<void>;
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
  /** This folder's skills and the account's, offered as / commands. */
  private skills: Array<{ name: string; description: string; readPath: string }> = [];
  private lastMode: WorkMode;
  private planSent = "";
  /** Going back to an earlier message: the editor cleared its view, so send the whole transcript again. */
  private replayAll = false;

  constructor(
    readonly id: string,
    readonly cwd: string,
    readonly session: AgentSession,
    private readonly client: () => AgentContext,
    /** The editor said it is Atlarix's own (clientCapabilities._meta.atlarix). */
    private readonly extras: () => boolean,
    private readonly options: () => Promise<SessionConfigOption[]>,
  ) {
    this.lastMode = session.state.mode;
    session.on("change", (s: SessionState) => this.onChange(s));
    session.on("peer-message", () => this.onPeerMessage());
    session.on("background-ready", () => this.onBackgroundReady());
    session.on("tasks-changed", () => this.checkTasks());
  }

  /**
   * Background work finished while idle. Atlarix's extension opens the wake
   * turn itself (as the desktop does); other editors only start turns from a
   * prompt, so there the results wait for the next message, which reads them.
   */
  private onBackgroundReady(): void {
    if (!this.extras()) return;
    void this.flush().then(() => this.client().notify("_atlarix/background_ready", { sessionId: this.id }).catch(() => {}));
  }

  private tasksSent = "";
  private tasksTimer: ReturnType<typeof setTimeout> | null = null;
  private tasksPoll: ReturnType<typeof setInterval> | null = null;

  /**
   * Tell Atlarix's extension when what is running changes (a task starts, stalls
   * or ends), so its chip and task list follow without polling. Coalesced: the
   * session changes many times a second while a turn streams. While anything
   * runs, re-checked every few seconds too, since a job ending between turns
   * changes no transcript cell.
   */
  private checkTasks(): void {
    if (!this.extras() || this.tasksTimer) return;
    this.tasksTimer = setTimeout(() => {
      this.tasksTimer = null;
      void this.session
        .liveTasks()
        .then((tasks) => {
          const sig = tasks.map((t) => `${t.id}:${t.stalled ? 1 : 0}`).join(",");
          if (tasks.length && !this.tasksPoll) {
            this.tasksPoll = setInterval(() => this.checkTasks(), 3_000);
            (this.tasksPoll as { unref?: () => void }).unref?.();
          } else if (!tasks.length && this.tasksPoll) {
            clearInterval(this.tasksPoll);
            this.tasksPoll = null;
          }
          if (sig === this.tasksSent) return;
          this.tasksSent = sig;
          return this.client().notify("_atlarix/tasks_changed", { sessionId: this.id, count: tasks.length });
        })
        .catch(() => {});
    }, 400);
  }

  /** What is running in this session, for Atlarix's extension: list, read the output of, or stop one. */
  async tasks(action: "list" | "output" | "stop", id?: string): Promise<Record<string, unknown>> {
    const all = await this.session.liveTasks();
    if (action === "list") {
      return {
        tasks: all.map((t) => ({
          id: t.id,
          kind: t.kind,
          label: t.label,
          elapsedMs: t.elapsedMs,
          stalled: t.stalled,
          tokens: t.tokens ?? null,
          progress: t.progress ?? null,
          tools: t.tools.length,
          canStop: !!t.jobId,
        })),
      };
    }
    const t = all.find((x) => x.id === id);
    if (!t) return { gone: true };
    if (action === "output") return { text: await this.session.taskOutput(t) };
    const message = await this.session.stopTask(t);
    this.checkTasks();
    return { message };
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
    for (const u of diffUpdates(s.cells, this.emitted, { replay: this.replayAll, ids: this.extras() })) void this.send(u);
    // A sub-agent starting or ending inside a turn changes what is running.
    this.checkTasks();
    if (s.title && s.title !== this.lastTitle && !s.busy) {
      // Renamed from the editor's Past chats while open.
      this.lastTitle = s.title;
      void this.send({ sessionUpdate: "session_info_update", title: s.title });
    }
    if (s.mode !== this.lastMode) {
      // The session changed its own mode (building a plan switches to Build):
      // without this the editor's picker kept showing the old one.
      this.lastMode = s.mode;
      void this.send({ sessionUpdate: "current_mode_update", currentModeId: s.mode });
      void this.options().then((configOptions) => this.send({ sessionUpdate: "config_option_update", configOptions }));
    }
    const planKey = `${s.planReady?.planId ?? ""}:${s.planRevision}`;
    if (planKey !== this.planSent) {
      this.planSent = planKey;
      void this.sendPlan(s);
    }
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
    // Atlarix's own editor extension opens the turn itself, as the app does.
    if (this.extras()) {
      void this.flush().then(() => this.client().notify("_atlarix/peer_waiting", { sessionId: this.id }).catch(() => {}));
      return;
    }
    void this.send({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "\n\n📨 A message from another Atlarix session arrived. Send anything (\"go on\") and I'll read it.\n",
      },
    });
  }

  /**
   * The plan as ACP's plan list (any editor draws its steps), and for Atlarix's
   * own extension the whole document too, so it can show it and offer Build.
   */
  private async sendPlan(s: SessionState): Promise<void> {
    // The plan stays up while it is being built, its steps ticking off: the
    // ready plan is cleared the moment Build starts, so follow the one we built.
    const id = s.planReady?.planId ?? this.activePlanId;
    if (!id) {
      if (this.lastPlanEntries) {
        this.lastPlanEntries = false;
        void this.send({ sessionUpdate: "plan", entries: [] });
      }
      return;
    }
    const plans = await this.session.plans().catch(() => []);
    const p = plans.find((x) => x.id === id);
    if (!p) return;
    this.activePlanId = p.id;
    this.lastPlanEntries = true;
    void this.send({
      sessionUpdate: "plan",
      entries: planEntries(parsePlanChecklist(p.content)),
      ...(this.extras()
        ? {
            _meta: {
              atlarix: {
                plan: {
                  id: p.id,
                  title: p.title || s.planReady?.title || "Plan",
                  content: p.content,
                  revision: s.planRevision,
                  status: p.status,
                  buildable: p.status === "plan",
                },
              },
            },
          }
        : {}),
    });
  }

  /**
   * After a load's replay: the editor has just cleared its screen, so send the
   * plan again even if this thread already sent it. A reopened chat lost its
   * plan card and Build it otherwise (QA #54).
   */
  async resendPlan(): Promise<void> {
    const s = this.session.state;
    this.planSent = `${s.planReady?.planId ?? ""}:${s.planRevision}`;
    this.lastPlanEntries = false;
    await this.sendPlan(s);
  }

  /** The plan on screen: the ready one, then the one being built. */
  private activePlanId: string | null = null;
  private lastPlanEntries = false;

  /** Replay what is already in the session (session/load). */
  async replay(): Promise<void> {
    // The editor shows the loaded chat's name, not "New chat".
    if (this.session.state.title) {
      this.lastTitle = this.session.state.title;
      void this.send({ sessionUpdate: "session_info_update", title: this.session.state.title });
    }
    for (const u of diffUpdates(this.session.state.cells, this.emitted, { replay: true, ids: this.extras() })) void this.send(u);
    await this.flush();
  }

  /** The model list changed (a key saved or removed): tell the editor. */
  sendOptions(): void {
    void this.options().then((configOptions) => this.send({ sessionUpdate: "config_option_update", configOptions }));
  }

  /**
   * Go back to one of your messages and send it again, edited: the TUI's /undo
   * (session.resendEdited). Everything after it leaves the conversation, and
   * with `restore` the files those turns changed come back first. Atlarix's
   * extension clears its view first; the transcript is sent again from the top.
   */
  async resend(messageId: number, text: string, restore: boolean): Promise<PromptResponse> {
    if (this.session.state.busy) throw RequestError.invalidParams(undefined, "Wait for this turn to finish (or stop it), then go back.");
    const preview = restore ? await this.session.undoPreview(messageId) : null;
    const turn = { done: () => {}, cancelled: false };
    const finished = new Promise<void>((resolve) => (turn.done = resolve));
    this.turn = turn;
    this.emitted.clear();
    this.replayAll = true;
    const errorBefore = this.session.state.lastError;
    try {
      await this.session.resendEdited(messageId, text, preview?.turnIds.length ? preview.turnIds : null);
      if (!this.session.state.busy) turn.done();
      await finished;
    } catch (e) {
      throw RequestError.internalError(undefined, (e as Error).message ?? String(e));
    } finally {
      this.turn = null;
      this.replayAll = false;
    }
    for (const u of diffUpdates(this.session.state.cells, this.emitted, { ids: this.extras() })) void this.send(u);
    await this.afterTurn();
    await this.flush();
    if (turn.cancelled) return { stopReason: "cancelled" };
    const err = this.session.state.lastError;
    if (err && err !== errorBefore) throw RequestError.internalError(undefined, err);
    return { stopReason: "end_turn" };
  }

  async prompt(blocks: readonly ContentBlock[], meta?: AtlarixPromptMeta): Promise<PromptResponse> {
    const { text, images } = promptInput(blocks, this.cwd);
    // Cells already on screen (the user's own message among them) are not news.
    diffUpdates(this.session.state.cells, this.emitted);
    const errorBefore = this.session.state.lastError;
    const slash = /^\/(\w+)\s*$/.exec(text);
    const skill = this.skillFor(text);
    const mcpAdd = /^\/mcp\s+add\s+(\S+)\s*$/i.exec(text);
    if (mcpAdd) {
      const { accountCommandText } = await import("./account-commands");
      const reply = await accountCommandText(`mcp add ${mcpAdd[1]}`, this.session).catch((e: Error) => `Couldn't add it: ${e.message}`);
      await this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
      return { stopReason: "end_turn" };
    }
    if (slash?.[1] === "keys" || /^\/keys\s/.test(text)) {
      const { keysCommandText } = await import("./account-commands");
      const reply = await keysCommandText(text).catch((e: Error) => `Couldn't read your keys: ${e.message}`);
      await this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
      return { stopReason: "end_turn" };
    }
    if (slash?.[1] === "undo" && !this.extras()) {
      await this.send({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `Going back to an earlier message happens in Atlarix's own panels. In a terminal: \`atlarix --resume ${this.id}\`, then /undo.`,
        },
      });
      return { stopReason: "end_turn" };
    }
    // Account commands for editors with no Atlarix panel (Zed, JetBrains): the
    // CLI's /status, /billing and /mcp, answered as a message.
    if (slash && (slash[1] === "status" || slash[1] === "billing" || slash[1] === "mcp" || slash[1] === "logout")) {
      const { accountCommandText } = await import("./account-commands");
      const reply = await accountCommandText(slash[1], this.session).catch((e: Error) => `Couldn't read that: ${e.message}`);
      await this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
      return { stopReason: "end_turn" };
    }
    if (slash?.[1] === "handoff") {
      const reply = await this.session.handoffToApp().then(
        () => "Continued in the Atlarix app. It's the same chat: you can keep going here too.",
        (e: Error) => e.message,
      );
      await this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
      return { stopReason: "end_turn" };
    }
    if (slash?.[1] === "compact") {
      const r = await this.session.compact();
      await this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: r.message } });
      return { stopReason: "end_turn" };
    }
    // A finished build's plan stays up until the next request, then goes.
    if (this.activePlanId && !this.session.state.planReady && slash?.[1] !== "build") {
      const done = (await this.session.plans().catch(() => [])).find((x) => x.id === this.activePlanId);
      if (!done || done.status === "built") {
        this.activePlanId = null;
        this.lastPlanEntries = false;
        void this.send({ sessionUpdate: "plan", entries: [] });
      }
    }
    const turn = { done: () => {}, cancelled: false };
    const finished = new Promise<void>((resolve) => (turn.done = resolve));
    this.turn = turn;
    try {
      if (slash?.[1] === "build" && this.session.state.planReady) {
        this.activePlanId = this.session.state.planReady.planId;
        await this.session.buildPlan(this.session.state.planReady.planId);
      } else if (meta?.peerTurn) {
        // Atlarix's extension, told a message from another session is waiting: read it now.
        await this.session.takeHeldPeerMessages();
      } else if (meta?.wakeTurn) {
        // Atlarix's extension, told background work finished: let the agent act on it.
        await this.session.wakeForBackground();
      } else if (this.session.state.question && meta?.answers?.length) {
        await this.session.answerQuestion(meta.answers);
      } else if (this.session.state.question) {
        // The last turn ended on a question (ask_user): this prompt is the answer.
        await this.session.answerQuestion([text]);
      } else {
        await this.session.submit(skill ?? (text || "(attachment)"), images.length ? { images } : undefined);
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

  /** How full the context is, for the editor's ring (after a turn, and on load). */
  sendUsage(): void {
    const s = this.session.state;
    if (s.contextUsed == null || !s.contextLimit) return;
    void this.send({
      sessionUpdate: "usage_update",
      used: s.contextUsed,
      size: s.contextLimit,
      ...(s.costUsd > 0 ? { cost: { amount: s.costUsd, currency: "USD" } } : {}),
      // The task header in Atlarix's extension: this chat's tokens, and how many came from cache.
      ...(this.extras() ? { _meta: { atlarix: { tokens: s.sessionTokens, cachedTokens: s.cachedTokens } } } : {}),
    });
  }

  private async afterTurn(): Promise<void> {
    const s = this.session.state;
    this.sendUsage();
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
        // Atlarix's extension draws this as a question card and answers with
        // `_meta.atlarix.answers` on the next prompt; other editors read the text.
        ...(this.extras() ? { _meta: { atlarix: { question: { items: s.question.items } } } } : {}),
      });
    }
    if (this.activePlanId) await this.sendPlan(s);
    const plan = s.planReady?.planId ?? null;
    if (plan !== this.lastPlan) {
      this.lastPlan = plan;
      void this.send(commandsUpdate(!!plan, this.skills));
    }
  }

  /** Load the skills, then send the command list (the editor's / menu). */
  async refreshCommands(): Promise<void> {
    try {
      const { buildSkillIndex } = await import("@/lib/skills/skill-index");
      const all = await buildSkillIndex(this.cwd, this.session.state.mode);
      const builtin = new Set(BUILTIN_COMMANDS);
      this.skills = all
        .filter((s) => s.source !== "guide" && /^[\w-]+$/.test(s.name) && !builtin.has(s.name))
        .map((s) => ({ name: s.name, description: s.description, readPath: s.readPath }));
    } catch {
      this.skills = [];
    }
    await this.send(commandsUpdate(!!this.session.state.planReady, this.skills));
  }

  /** "/deploy fix the staging url" → ask for the deploy skill, with the rest as the task. */
  private skillFor(text: string): string | null {
    const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
    const s = m && this.skills.find((x) => x.name === m[1]);
    if (!s) return null;
    const rest = m![2]?.trim();
    return `Use the "${s.name}" skill: read ${s.readPath} first.${rest ? `\n\n${rest}` : ""}`;
  }

  async cancel(): Promise<void> {
    if (this.turn) this.turn.cancelled = true;
    await this.session.interrupt();
  }
}

const BUILTIN_COMMANDS = ["compact", "undo", "keys", "status", "billing", "mcp", "handoff", "logout", "build"];

function commandsUpdate(planReady: boolean, skills: Array<{ name: string; description: string }> = []): SessionUpdate {
  return {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "compact", description: "Summarize the conversation so far to free up context." },
      { name: "undo", description: "Go back to one of your messages, edit it and send it again." },
      { name: "keys", description: "Your own API keys, and whether each one works." },
      { name: "status", description: "Your Atlarix account, plan, credit and this chat's usage." },
      { name: "billing", description: "Get Pro, add credit, or manage or cancel your subscription." },
      { name: "mcp", description: "MCP servers in this folder." },
      { name: "handoff", description: "Continue this chat in the Atlarix app." },
      { name: "logout", description: "Sign out of Atlarix on this computer (the app and CLI share the sign-in)." },
      ...(planReady ? [{ name: "build", description: "Build the plan that is ready for review." }] : []),
      ...skills.map((s) => ({ name: s.name, description: `Skill: ${s.description || s.name}`, input: { hint: "what to do (optional)" } })),
    ],
  };
}

/** What Atlarix's own extension adds to a prompt (`_meta.atlarix`). */
export interface AtlarixPromptMeta {
  /** Answers to the pending question, one per item. */
  answers?: string[];
  /** Read the message another session left while this one was idle. */
  peerTurn?: boolean;
  /** Background work finished while idle: let the agent deal with it now. */
  wakeTurn?: boolean;
}

export function promptMeta(meta: unknown): AtlarixPromptMeta | undefined {
  const a = (meta as { atlarix?: unknown } | null | undefined)?.atlarix as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") return undefined;
  return {
    answers: Array.isArray(a.answers) ? a.answers.map(String) : undefined,
    peerTurn: a.peerTurn === true,
    wakeTurn: a.wakeTurn === true,
  };
}

/** Plan steps as ACP plan entries. Blocked or external steps are still to do. */
export function planEntries(steps: readonly PlanChecklistStep[]): PlanEntry[] {
  return steps.map((st) => ({
    content: st.text,
    priority: "medium",
    status: st.state === "done" ? "completed" : st.state === "in_progress" ? "in_progress" : "pending",
  }));
}

/**
 * The model list as ACP groups (favourites, recent, then one per provider, the
 * TUI's order), so every editor's picker can show where a model comes from.
 */
export function modelGroups(
  options: Array<Pick<ModelOption, "provider" | "name" | "label"> & Partial<ModelOption>>,
  picks?: { favorites: ModelChoice[]; recent: ModelChoice[] },
) {
  const full: ModelOption[] = options.map((o) => ({
    providerName: o.provider,
    detail: "",
    deepThinking: false,
    ...o,
  }));
  return groupOptions(full, picks ?? { favorites: [], recent: [] }).map((g) => ({
    group: g.id,
    name: g.title,
    options: g.options.map((o) => ({
      value: `${o.provider}/${o.name}`,
      name: o.label,
      ...(o.detail || o.free ? { description: [o.free ? "Free" : "", o.detail].filter(Boolean).join(" · ") } : {}),
    })),
  }));
}

export class AcpAgent {
  private readonly threads = new Map<string, Thread>();
  private client: AgentContext | null = null;
  /** The editor is Atlarix's own extension: send the `_meta.atlarix` extras. */
  private atlarixClient = false;

  /** From `initialize`: `clientCapabilities._meta.atlarix`. */
  setClientCapabilities(caps: unknown): void {
    const meta = (caps as { _meta?: { atlarix?: unknown } } | null | undefined)?._meta;
    this.atlarixClient = !!meta?.atlarix;
  }

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
    const { options, current, picks, deepThinking } = await this.deps.models().catch(() => ({
      options: [],
      current: undefined,
      picks: undefined,
      deepThinking: undefined,
    }));
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
    if (!options.length) return out;
    const key = (m: { provider: string; name: string }) => `${m.provider}/${m.name}`;
    const want = t.session.model ?? current;
    // A model whose provider's key was just removed is no longer offered: the
    // picker shows the first one instead of a value it doesn't have.
    const chosen = want && options.some((o) => key(o) === key(want)) ? want : options[0]!;
    out.push({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: key(chosen),
      options: modelGroups(options, picks),
    });
    if (options.find((o) => key(o) === key(chosen))?.deepThinking && this.deps.setDeepThinking) {
      out.push({
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: deepThinking ? "deep" : "normal",
        options: [
          { value: "normal", name: "Normal", description: "The model's usual thinking." },
          { value: "deep", name: "Deep", description: "Thinks at the model's ceiling: slower, and more tokens." },
        ],
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
    let session: AgentSession | null = null;
    try {
      session = await this.deps.createSession(cwd);
      if (sessionId) await session.resume(sessionId);
      else await session.open();
    } catch (e) {
      await session?.close().catch(() => {});
      const msg = (e as Error).message ?? String(e);
      if (isAuthError(msg)) throw RequestError.authRequired(undefined, "Sign in to Atlarix first (`atlarix login`).");
      // A plain throw reaches the editor as "Internal error"; the reason (an
      // older desktop app guarding the database, say) is what the user needs.
      throw RequestError.internalError(undefined, msg);
    }
    if (!session) throw RequestError.internalError(undefined, "Atlarix couldn't start a session.");
    const t: Thread = new Thread(
      session.sessionId,
      cwd,
      session,
      this.ctx,
      () => this.atlarixClient,
      () => this.configOptions(t),
    );
    this.threads.set(t.id, t);
    return t;
  }

  async newSession(cwd: string): Promise<NewSessionResponse> {
    const t = await this.open(cwd);
    // After the response, so the editor knows the session the list belongs to.
    setTimeout(() => void t.refreshCommands(), 0);
    return { sessionId: t.id, configOptions: await this.configOptions(t), modes: this.modes(t) };
  }

  async loadSession(cwd: string, sessionId: string): Promise<{ configOptions: SessionConfigOption[]; modes: SessionModeState }> {
    const existing = this.threads.get(sessionId);
    const t = existing ?? (await this.open(cwd, sessionId));
    // A thread this process already has open remembers what it sent; the
    // editor that asks to load it again has nothing on screen, so start over.
    if (existing) existing.emitted.clear();
    await t.replay();
    await t.resendPlan();
    t.sendUsage();
    setTimeout(() => void t.refreshCommands(), 0);
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

  /** The workspace's app id and this session's usage, for the extension's Account panel. */
  sessionInfo(sessionId: string): { appId: number; tokens: number; cachedTokens: number; costUsd: number; contextPercent: number | null } {
    const s = this.thread(sessionId).session;
    return {
      appId: s.appId,
      tokens: s.state.sessionTokens ?? 0,
      cachedTokens: s.state.cachedTokens ?? 0,
      costUsd: s.state.costUsd ?? 0,
      contextPercent: s.state.contextPercent ?? null,
    };
  }

  /** Continue this session in the Atlarix app (the CLI's /handoff). */
  async handoff(sessionId: string): Promise<void> {
    await this.thread(sessionId).session.handoffToApp();
  }

  /** Atlarix's extension, back after a while away: one line on where this session stands. */
  tasks(sessionId: string, action: "list" | "output" | "stop", id?: string): Promise<Record<string, unknown>> {
    return this.thread(sessionId).tasks(action, id);
  }

  async recap(sessionId: string): Promise<{ text: string | null }> {
    const t = this.thread(sessionId);
    if (t.session.state.busy) return { text: null };
    return { text: await t.session.recap() };
  }

  /** Your messages in this session, newest first, and what going back to one would undo. */
  undoList(sessionId: string): Array<{ id: number; text: string }> {
    return this.thread(sessionId).session.myMessages();
  }

  async undoPreview(sessionId: string, messageId: number): Promise<{ filesChanged: string[]; createdFiles: string[] }> {
    const p = await this.thread(sessionId).session.undoPreview(messageId);
    return { filesChanged: p.filesChanged, createdFiles: p.createdFiles };
  }

  /** Compare at a checkpoint: what changed since a message, and each file's version from then. */
  checkpointFiles(sessionId: string, messageId: number) {
    return this.thread(sessionId).session.checkpointFiles(messageId);
  }

  checkpointBefore(sessionId: string, turnId: string, relativePath: string) {
    return this.thread(sessionId).session.checkpointBefore(turnId, relativePath);
  }

  undoResend(sessionId: string, messageId: number, text: string, restore: boolean): Promise<PromptResponse> {
    return this.thread(sessionId).resend(messageId, text, restore);
  }

  /**
   * A provider's key was saved or removed. Chats on a removed provider's model
   * move to the first model offered (Atlarix Auto), as does the remembered
   * choice, and every editor gets the new list.
   */
  async modelsChanged(removedProvider?: string): Promise<void> {
    if (removedProvider) {
      const { options, current } = await this.deps.models().catch(() => ({ options: [], current: undefined }));
      const first = options.find((o) => o.provider !== removedProvider);
      if (first) {
        const ref = { provider: first.provider, name: first.name };
        for (const t of this.threads.values()) if (t.session.model?.provider === removedProvider) t.session.setModel(ref);
        if (current?.provider === removedProvider) this.deps.rememberModel(ref);
      }
    }
    for (const t of this.threads.values()) t.sendOptions();
  }

  /** Rename or delete a stored chat. One open here is renamed live, or closed before it is deleted. */
  async changeSession(sessionId: string, change: { rename: string } | { delete: true }): Promise<void> {
    const open = this.threads.get(sessionId);
    if ("rename" in change && open) {
      await open.session.rename(change.rename);
      return;
    }
    if ("delete" in change && open) {
      await open.cancel().catch(() => {});
      await open.session.close().catch(() => {});
      this.threads.delete(sessionId);
    }
    if (!this.deps.changeSession) throw RequestError.methodNotFound("_atlarix/session");
    await this.deps.changeSession(sessionId, change);
  }

  prompt(sessionId: string, blocks: readonly ContentBlock[], meta?: unknown): Promise<PromptResponse> {
    return this.thread(sessionId).prompt(blocks, promptMeta(meta));
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
    } else if (configId === "thinking" && this.deps.setDeepThinking) {
      this.deps.setDeepThinking(String(value) === "deep");
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
