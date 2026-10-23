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
import { extractPlanChecklistTitle, parsePlanChecklist, plainStepText, type PlanChecklistStep } from "@/lib/tasks/plan-checklist";
import type { SessionMcpServer } from "@/ipc/utils/mcp_manager";
import type { FeedbackSession } from "@/main/lib/session-feedback";
import type { AgentSession, ModelChoice, SessionState, WorkMode } from "../agent/session";
import { promptInput } from "./content";
import { ineligibleReason } from "@/lib/computer/eligibility";
import {
  approvalMode,
  approvalOptions,
  approvalOwner,
  approvalToolCall,
  AUTO_CONSENT_OPTIONS,
  autoConsentToolCall,
  MCP_CONSENT_OPTIONS,
  mcpConsentDecision,
  mcpConsentToolCall,
} from "./permissions";
import { AUTO_CONSENT_MARKER, AUTO_CONSENT_TERMS } from "@/shared/billing_copy";
import { diffUpdates, type Emitted } from "./updates";
import { handler } from "../agent/ipc";
import { groupOptions, type ModelOption } from "../agent/models";
import { chosenLevel, effortAfterModelChange, effortSettingsPatch } from "@/lib/routing/model-reasoning-profile";

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
    /** /effort's level (ctrl+t in the terminal), shared with the TUI. */
    effort?: { effort: string; deepThinking: boolean };
    /** Signed in on the free plan: free Auto has no /effort. */
    freeAccount?: boolean;
  }>;
  /** Remember a model the user picked, as the TUI's /model does. */
  rememberModel(ref: ModelChoice): void;
  /** /effort's level, as the TUI's /effort (the old deep-thinking switch kept in step). */
  setEffort?(patch: { effort: string; deepThinking: boolean }): void;
  /** Computer use for a model: the same per-model switch as the app and the TUI's /computer. */
  computerUse?: { isOn(m: ModelChoice): boolean; set(m: ModelChoice, on: boolean): void; notice(): Promise<string | null> };
  /** This folder's stored sessions, newest first (the TUI's /resume list). */
  listSessions(cwd: string): Promise<Array<{ id: string; title: string | null; updatedAt: Date | string }>>;
  /** Rename or delete a stored session (the editor's Past chats). */
  changeSession?(sessionId: string, change: { rename: string } | { delete: true }): Promise<void>;
  /**
   * The MCP servers the editor passed for a session (`session/new`,
   * `session/load`), connected for that session alongside the folder's own.
   * An empty list clears them.
   */
  setSessionMcpServers?(sessionId: string, servers: SessionMcpServer[]): void | Promise<void>;
}

/**
 * The editor's `mcpServers`, in the shape the MCP manager connects. stdio and
 * http only (what `initialize` advertises); an `sse` or other entry is left out.
 */
export function sessionMcpServersFrom(list: unknown): SessionMcpServer[] {
  if (!Array.isArray(list)) return [];
  const out: SessionMcpServer[] = [];
  const pairs = (v: unknown): Record<string, string> =>
    Object.fromEntries(
      (Array.isArray(v) ? v : [])
        .filter((p): p is { name: string; value: string } => typeof p?.name === "string" && typeof p?.value === "string")
        .map((p) => [p.name, p.value]),
    );
  for (const raw of list as Array<Record<string, unknown>>) {
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    if (!name) continue;
    if (raw.type === "http" && typeof raw.url === "string" && /^https?:\/\//i.test(raw.url)) {
      out.push({ name, transport: "http", url: raw.url, headers: pairs(raw.headers) });
    } else if (raw.type === undefined && typeof raw.command === "string" && raw.command) {
      out.push({
        name,
        transport: "stdio",
        command: raw.command,
        args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [],
        env: pairs(raw.env),
      });
    }
  }
  return out;
}

const SESSION_WATCH_MS = 2_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAuthError(msg: string | null | undefined): boolean {
  return !!msg && /ATLARIX_AUTH_REQUIRED|sign in to use atlarix|please sign in/i.test(msg);
}

/** "the CLI", "the app": session.ts's names, read once a session exists (it loads that module). */
let surfaceNames: Readonly<Record<string, string>> = {};

class Thread {
  readonly emitted: Emitted = new Map();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly asked = new Set<string>();
  /** Approval cards the editor still shows, to take back if something else answers them. */
  private readonly openCards = new Map<string, AbortController>();
  /** Where another process runs this session's turn, as last told to the editor. */
  private followingSent: string | null = null;
  /** `/fork`: a copy of this session, made by the agent (it may not be open here). */
  forkTo: ((title?: string) => Promise<{ id: string; title: string }>) | null = null;
  private turn: { done: () => void; cancelled: boolean } | null = null;
  /** Set a config option as the editor's picker does (the agent's setConfigOption): /effort uses it. */
  setOption: ((configId: string, value: string) => Promise<SessionConfigOption[]>) | null = null;
  private lastTitle: string | null = null;
  private lastPlan: string | null = null;
  /** This folder's skills and the account's, offered as / commands. */
  private skills: Array<{ name: string; description: string; readPath: string }> = [];
  private lastMode: WorkMode;
  private planSent = "";
  private pendingSent = "";
  private retryingSent: string | null = null;
  /** Going back to an earlier message: the editor cleared its view, so send the whole transcript again. */
  private replayAll = false;
  /** The editor's own MCP servers for this session, listed by /mcp (QA #9). */
  editorMcpServers: SessionMcpServer[] = [];
  /** When this chat was opened here: the session length a rating sends. */
  readonly openedAt = Date.now();
  /** The session rating was asked in this chat (answered or dismissed): once a session. */
  ratingAsked = false;

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
    session.on("automation", (run: Record<string, unknown>) => this.onAutomationRun(run));
    // Another session changed the model (item 9): the editor's picker follows.
    // A mode change already goes out with the session's state.
    // The line saying who changed it is its notice cell, sent with the cells.
    session.on("peer-settings", () => {
      void this.options().then((configOptions) => this.send({ sessionUpdate: "config_option_update", configOptions }));
    });
    // A stopped turn's unsent text goes back to the editor's input box.
    session.on("unsent", (text: string) => {
      if (this.extras()) void this.client().notify("_atlarix/unsent", { sessionId: this.id, text }).catch(() => {});
    });
  }

  /** An automation finished a run: Atlarix's extension says so, as the CLI flashes a line. */
  private onAutomationRun(run: Record<string, unknown>): void {
    if (!this.extras()) return;
    void this.client()
      .notify("_atlarix/automation_run", {
        sessionId: this.id,
        automationId: typeof run.automationId === "string" ? run.automationId : null,
        name: typeof run.automationName === "string" ? run.automationName : "Automation",
        status: typeof run.status === "string" ? run.status : "ok",
        summary: typeof run.summary === "string" ? run.summary : typeof run.error === "string" ? run.error : null,
      })
      .catch(() => {});
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

  /**
   * A message sent while a turn runs (Atlarix's extension): "steer" goes into
   * the running turn at its next step, "queue" opens the next turn, as the
   * CLI's Enter and Tab. Idle, either starts a turn like a prompt would not:
   * the editor sends a prompt then, so this only answers while busy.
   */
  async interject(
    text: string,
    kind: "steer" | "queue",
  ): Promise<{ pending: Array<{ id: string; text: string; kind: string }>; started: boolean; wait?: string }> {
    const t = text.trim();
    if (!t) return { pending: this.session.state.pending, started: false };
    const elsewhere = !!this.session.state.following;
    if (!this.session.state.busy && !elsewhere) return { pending: this.session.state.pending, started: false };
    // A command (/compact, a skill) is never the model's text, steered or
    // queued: it runs as a command once the turn is over (QA E10).
    const command = /^\/([\w-]+)(?:\s|$)/.exec(t)?.[1];
    if (command && (BUILTIN_COMMANDS.includes(command) || this.skills.some((s) => s.name === command))) {
      return { pending: this.session.state.pending, started: false, wait: `Wait for this turn to finish, then send /${command}.` };
    }
    // Running elsewhere, Tab steers too: held for after, it would open a turn
    // here that no editor asked for.
    if (kind === "queue" && !elsewhere) this.session.queueNext(t);
    else await this.session.submit(t);
    return { pending: this.session.state.pending, started: true };
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

  /**
   * The turn was stopped: here (session/cancel), or from another surface,
   * whose Stop lands as Esc in the session and not through this editor; then
   * this turn's footer says so, or, stopped before any output (no footer),
   * the session does. It ended as a normal finish (QA E12).
   */
  private stopped(turn: { cancelled: boolean }, cellsBefore: ReadonlySet<string>): boolean {
    return (
      turn.cancelled ||
      this.session.turnWasStopped ||
      this.session.state.cells.some((c) => c.kind === "footer" && !!c.interrupted && !cellsBefore.has(c.id))
    );
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
    const elsewhere = s.following ? `Running in ${surfaceNames[s.following.surface] ?? s.following.surface}` : null;
    if (elsewhere !== this.followingSent && this.extras()) {
      // Another surface runs the turn: the panel shows it working, its Enter
      // steers that turn and its Stop stops it (session.ts follows it).
      this.followingSent = elsewhere;
      void this.client()
        .notify("_atlarix/working", { sessionId: this.id, title: elsewhere ?? s.retrying ?? null, following: elsewhere != null })
        .catch(() => {});
    }
    if ((s.retrying ?? null) !== this.retryingSent && this.extras()) {
      // "Couldn't connect, retrying…" in the editor's working line (QA).
      this.retryingSent = s.retrying ?? null;
      void this.client().notify("_atlarix/working", { sessionId: this.id, title: s.retrying ?? null }).catch(() => {});
    }
    const pendingSig = s.pending.map((x) => `${x.kind}:${x.id}`).join(",");
    if (pendingSig !== this.pendingSent && this.extras()) {
      // What you sent while it worked, still waiting: the editor lists it above the box.
      this.pendingSent = pendingSig;
      void this.client()
        .notify("_atlarix/pending", { sessionId: this.id, items: s.pending.map((x) => ({ id: x.id, text: x.text, kind: x.kind })) })
        .catch(() => {});
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
        // Answered meanwhile without a card (a rule saved on another one): nothing to ask.
        if (!this.session.state.approvals.some((x) => x.operationId === a.operationId)) return;
        const toolCall = approvalToolCall(a, owner ?? undefined);
        const card = new AbortController();
        this.openCards.set(a.operationId, card);
        const r = await this.client()
          .request(
            "session/request_permission",
            { sessionId: this.id, toolCall, options: approvalOptions(a, owner != null) },
            { cancellationSignal: card.signal },
          )
          .catch(() => ({ outcome: { outcome: "cancelled" as const } }));
        this.openCards.delete(a.operationId);
        // Taken back (below): already decided, so answering it would be a second answer (QA E2).
        if (card.signal.aborted) {
          if (!owner) void this.send({ sessionUpdate: "tool_call_update", toolCallId: toolCall.toolCallId, status: this.turn?.cancelled ? "failed" : "completed" });
          return;
        }
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
    // A card answered without the editor (a saved rule covered it, or the turn
    // stopped): take it back, or it stayed open after its edit had run (QA E2).
    for (const [operationId, card] of this.openCards) {
      if (!s.approvals.some((x) => x.operationId === operationId)) card.abort();
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
    this.relaySuggestions(s);
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
        text: "\n\nA message from another Atlarix session arrived. Send anything (\"go on\") and I'll read it.\n",
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
                  title: p.title || s.planReady?.title || extractPlanChecklistTitle(p.content) || "Plan",
                  content: p.content,
                  revision: s.planRevision,
                  status: p.status,
                  // A build that stopped with steps left can be picked up again (QA C4).
                  buildable: p.status === "plan" || s.planReady?.planId === p.id,
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

  /**
   * A load (the panel back on this chat): where its turn runs, again. It is
   * sent once, when that changes, and the panel may have been on another chat
   * then; it showed no "Running in the CLI" and no Stop (QA E14).
   */
  resendWorking(): void {
    if (!this.extras() || !this.followingSent) return;
    void this.client().notify("_atlarix/working", { sessionId: this.id, title: this.followingSent, following: true }).catch(() => {});
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
    const cellsBefore = new Set(this.session.state.cells.map((c) => c.id));
    const turn = { done: () => {}, cancelled: false };
    const finished = new Promise<void>((resolve) => (turn.done = resolve));
    this.turn = turn;
    this.emitted.clear();
    this.replayAll = true;
    const errorBefore = this.session.state.lastError;
    let kept: string[] = [];
    try {
      ({ kept } = await this.session.resendEdited(messageId, text, preview?.turnIds.length ? preview.turnIds : null));
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
    if (this.stopped(turn, cellsBefore)) return { stopReason: "cancelled" };
    const err = this.session.state.lastError;
    if (err && err !== errorBefore) throw RequestError.internalError(undefined, err);
    // Files the restore left alone (changed since): Atlarix's extension says so.
    return {
      stopReason: "end_turn",
      ...(this.extras() && kept.length ? { _meta: { atlarix: { kept } } } : {}),
    };
  }

  /** Suggestion cards already sent to the editor, by id. */
  private readonly suggestionsSent = new Set<string>();

  /**
   * An MCP server Atlarix suggested. Atlarix's editor extension draws a card
   * (`_atlarix/mcp_suggestion`, acted on through `_atlarix/mcp`); any other
   * editor gets its own permission prompt: Connect, or Not now.
   */
  private relaySuggestions(s: SessionState): void {
    const cards = s.mcpSuggestions ?? [];
    const open = new Set(cards.map((x) => x.id));
    for (const id of [...this.suggestionsSent]) {
      if (open.has(id)) continue;
      this.suggestionsSent.delete(id);
      if (this.extras()) {
        void this.client().notify("_atlarix/mcp_suggestion", { sessionId: this.id, id, resolved: true }).catch(() => {});
      }
    }
    for (const card of cards) {
      if (this.suggestionsSent.has(card.id)) continue;
      this.suggestionsSent.add(card.id);
      if (this.extras()) {
        void this.client().notify("_atlarix/mcp_suggestion", { sessionId: this.id, ...card }).catch(() => {});
        continue;
      }
      void this.flush().then(() => this.askToConnect(card));
    }
  }

  private async askToConnect(card: SessionState["mcpSuggestions"][number]): Promise<void> {
    const { realServices } = await import("../agent/services");
    const mcp = realServices.mcp;
    const needsValues = card.inputs.some((i) => i.required && i.default === undefined);
    const r = await this.client()
      .request("session/request_permission", {
        sessionId: this.id,
        toolCall: {
          toolCallId: `mcp-suggest:${card.id}`,
          title: `Connect ${card.title}?`,
          kind: "other",
          status: "pending",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: [
                  card.verified ? `${card.title} · Verified` : `${card.title} · ${card.publisher}`,
                  card.reason,
                  needsValues
                    ? `It asks for ${card.inputs.filter((i) => i.required).map((i) => i.label).join(", ")}: add it from the Atlarix app or the CLI's /mcp.`
                    : "",
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            },
          ],
        },
        options: needsValues
          ? [{ optionId: "no", name: "Not now", kind: "reject_once" }]
          : [
              { optionId: "connect", name: "Connect", kind: "allow_once" },
              { optionId: "no", name: "Not now", kind: "reject_once" },
            ],
      })
      .catch(() => ({ outcome: { outcome: "cancelled" as const } }));
    const chosen = r.outcome.outcome === "selected" ? r.outcome.optionId : "no";
    if (chosen !== "connect") {
      await mcp.suggestDismiss(card.id).catch(() => {});
      return;
    }
    try {
      const added = await mcp.suggestConnect(card.id, card.optionId, {});
      // Sign-in pages open through the editor (stderr), as a local server's do.
      if (added.needsSignIn && added.where === "account") {
        const signed = await mcp.accountSignIn(this.session.appId, String(added.id), () => {});
        if (!signed.ok) return void (await mcp.suggestDismiss(card.id).catch(() => {}));
      } else if (added.needsSignIn) {
        await mcp.signIn(Number(added.id));
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline) {
          if ((await mcp.suggestFinish(card.id)).connected) return;
          await new Promise((res) => setTimeout(res, 2000));
        }
        return void (await mcp.suggestDismiss(card.id).catch(() => {}));
      } else if (added.needsSecret) {
        // A key can't be typed into a permission prompt.
        return void (await mcp.suggestDismiss(card.id).catch(() => {}));
      }
      const done = await mcp.suggestFinish(card.id);
      if (!done.connected) await mcp.suggestDismiss(card.id).catch(() => {});
    } catch {
      await mcp.suggestDismiss(card.id).catch(() => {});
    }
  }

  async prompt(blocks: readonly ContentBlock[], meta?: AtlarixPromptMeta): Promise<PromptResponse> {
    const { text, images } = promptInput(blocks, this.cwd);
    // Cells already on screen (the user's own message among them) are not news.
    diffUpdates(this.session.state.cells, this.emitted);
    const errorBefore = this.session.state.lastError;
    const slash = /^\/(\w+)\s*$/.exec(text);
    const skill = this.skillFor(text);
    // `/feedback [1|2|3] [text]`: to Atlarix, never to the model.
    const feedbackCmd = /^\/feedback(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (feedbackCmd) {
      await this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: await this.feedbackCommand(feedbackCmd[1] ?? "") } });
      return { stopReason: "end_turn" };
    }
    // `/mcp add` with nothing after it: say what it takes, rather than sending it to the model.
    if (/^\/mcp\s+add\s*$/i.test(text)) {
      await this.send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "`/mcp add` takes a URL, a command, or a marketplace server's name, e.g. `/mcp add linear`." },
      });
      return { stopReason: "end_turn" };
    }
    const mcpAdd = /^\/mcp\s+add\s+(.+?)\s*$/is.exec(text);
    if (mcpAdd) {
      const { accountCommandText } = await import("./account-commands");
      const reply = await accountCommandText(`mcp add ${mcpAdd[1]}`, this.session).catch((e: Error) => `Couldn't add it: ${e.message}`);
      await this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
      return { stopReason: "end_turn" };
    }
    // /effort typed in the chat: answered here, never sent to the model as a turn (QA N3).
    const effortCmd = /^\/effort(?:\s+(\S+))?\s*$/i.exec(text.trim());
    if (effortCmd) {
      await this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: await this.effortCommand(effortCmd[1]) } });
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
    // `/automations`, `/automations run <name>`, `/automations on|off <name>`.
    const automations = /^\/automations(?:\s+([\s\S]+))?$/i.exec(text.trim());
    if (automations || (slash && (slash[1] === "status" || slash[1] === "stats" || slash[1] === "billing" || slash[1] === "mcp" || slash[1] === "logout"))) {
      const { accountCommandText } = await import("./account-commands");
      const cmd = automations ? `automations ${automations[1]?.trim() ?? ""}`.trim() : slash![1]!;
      const reply = await accountCommandText(cmd, this.session, this.editorMcpServers).catch((e: Error) => `Couldn't read that: ${e.message}`);
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
    const forkCmd = /^\/fork(?:\s+([\s\S]+?))?\s*$/i.exec(text.trim());
    if (forkCmd && this.forkTo) {
      const reply = await this.forkTo(forkCmd[1]?.trim() || undefined).then(
        (made) => {
          // Atlarix's own panel opens it; another editor lists it in its history.
          if (!this.extras()) return `Forked as '${made.title}': open it from your session history.`;
          void this.client().notify("_atlarix/open_session", { sessionId: made.id, title: made.title }).catch(() => {});
          return `Forked as '${made.title}'.`;
        },
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
    const cellsBefore = new Set(this.session.state.cells.map((c) => c.id));
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
    if (this.stopped(turn, cellsBefore)) return { stopReason: "cancelled" };
    const err = this.session.state.lastError;
    if (err && err !== errorBefore && err.includes(AUTO_CONSENT_MARKER)) return this.autoConsent();
    if (err && err !== errorBefore) {
      if (isAuthError(err)) throw RequestError.authRequired(undefined, "Sign in to Atlarix first (`atlarix login`).");
      throw RequestError.internalError(undefined, err);
    }
    return { stopReason: "end_turn" };
  }

  /**
   * Free Atlarix Auto needs the user's OK before its first turn. The CLI asks in
   * a dialog; an editor gets a permission card with the same words (Zed,
   * JetBrains and Atlarix's own VS Code panel all draw one). On yes the same
   * request runs again, in this prompt, as the CLI's dialog does it.
   */
  private async autoConsent(): Promise<PromptResponse> {
    const r = await this.client()
      .request("session/request_permission", {
        sessionId: this.id,
        toolCall: autoConsentToolCall(AUTO_CONSENT_TERMS),
        options: AUTO_CONSENT_OPTIONS,
      })
      .catch(() => ({ outcome: { outcome: "cancelled" as const } }));
    const yes = r.outcome.outcome === "selected" && (r.outcome as { optionId?: string }).optionId === "accept";
    if (!yes) {
      // Answered: without this the next send's refusal compared equal to this
      // one and nothing asked again (QA 15.7.1 #10).
      this.session.declineAutoConsent();
      await this.send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Atlarix Auto is free once you OK it. Send again to review it, or pick another model." },
      });
      return { stopReason: "end_turn" };
    }
    const cellsBefore = new Set(this.session.state.cells.map((c) => c.id));
    const turn = { done: () => {}, cancelled: false };
    const finished = new Promise<void>((resolve) => (turn.done = resolve));
    this.turn = turn;
    try {
      await this.session.acceptAutoConsent();
      if (!this.session.state.busy) turn.done();
      await finished;
    } finally {
      this.turn = null;
    }
    for (const u of diffUpdates(this.session.state.cells, this.emitted)) void this.send(u);
    await this.afterTurn();
    await this.flush();
    if (this.stopped(turn, cellsBefore)) return { stopReason: "cancelled" };
    const err = this.session.state.lastError;
    if (err) throw RequestError.internalError(undefined, err);
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

  /** `/effort` lists this model's levels; `/effort <level>` sets one (as the picker's Effort). */
  /** What a rating or /feedback says about this chat: never a prompt or code. */
  async feedbackSession(): Promise<FeedbackSession> {
    const thinking = (await this.options().catch(() => [])).find((o) => o.id === "thinking") as { currentValue?: unknown } | undefined;
    return {
      mode: this.session.state.mode,
      ...(thinking?.currentValue ? { effort: String(thinking.currentValue) } : {}),
      provider: this.session.model?.provider,
      model: this.session.model?.name,
      turns: this.session.myMessages().length,
      startedAt: this.openedAt,
    };
  }

  async feedbackCommand(rest: string): Promise<string> {
    const { parseFeedbackCommand, FEEDBACK_THANKS, FEEDBACK_FAILED, FEEDBACK_USAGE, FEEDBACK_TOO_LONG } = await import(
      "@/lib/feedback/session-rating"
    );
    const { sendSessionFeedback, noteRatingAsked } = await import("@/main/lib/session-feedback");
    const { rating, body, problem } = parseFeedbackCommand(rest);
    if (problem === "rating" || (!rating && !body)) return FEEDBACK_USAGE;
    // Nothing is sent: your message is still above, to shorten and send again.
    if (problem === "too_long") return FEEDBACK_TOO_LONG;
    const about = await this.feedbackSession();
    if (rating) {
      this.ratingAsked = true;
      noteRatingAsked();
      await sendSessionFeedback({ kind: "rating", rating }, about);
    }
    if (!body) return FEEDBACK_THANKS;
    const sent = await sendSessionFeedback({ kind: "text", body }, about);
    // Typed text is never dropped quietly: it is repeated, to copy and send again.
    return sent.ok ? FEEDBACK_THANKS : `${FEEDBACK_FAILED} What you wrote: "${body}"`;
  }

  private async effortCommand(arg: string | undefined): Promise<string> {
    const option = (await this.options()).find((o) => o.id === "thinking") as
      | { currentValue: unknown; options: Array<{ value: string; description?: string | null }> }
      | undefined;
    if (!option) return "This model has no effort setting. (Free Auto runs at one level; Pro, credit or your own key adds effort.)";
    const levels = option.options.map((o) => o.value);
    const def = option.options.find((o) => o.description === "default")?.value;
    const list = levels.map((l) => (l === def ? `${l} (default)` : l)).join(", ");
    if (!arg) return `Effort: **${String(option.currentValue)}**. This model's levels: ${list}. Set one with \`/effort <level>\` or in the model picker.`;
    const hit = levels.find((l) => l.toLowerCase() === arg.toLowerCase());
    if (!hit) return `No level "${arg}". This model's levels: ${list}.`;
    const configOptions = (await this.setOption?.("thinking", hit)) ?? (await this.options());
    void this.send({ sessionUpdate: "config_option_update", configOptions });
    return `Effort: **${hit}**.`;
  }

  async cancel(): Promise<void> {
    if (this.turn) this.turn.cancelled = true;
    await this.session.interrupt();
  }
}

const BUILTIN_COMMANDS = ["compact", "fork", "effort", "undo", "keys", "status", "stats", "billing", "mcp", "automations", "handoff", "logout", "feedback", "build"];

function commandsUpdate(planReady: boolean, skills: Array<{ name: string; description: string }> = []): SessionUpdate {
  return {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "compact", description: "Summarize the conversation so far to free up context." },
      { name: "fork", description: "Carry on in a copy of this chat; this one stays as it is.", input: { hint: "a name (optional)" } },
      { name: "effort", description: "How hard the model thinks: its own levels, as it lists them.", input: { hint: "a level (optional)" } },
      { name: "undo", description: "Go back to one of your messages, edit it and send it again." },
      { name: "keys", description: "Your own API keys, and whether each one works." },
      { name: "status", description: "Your Atlarix account, plan, credit and this chat's usage." },
      { name: "stats", description: "Your activity on this computer: tokens, streaks, models, skills and MCP." },
      { name: "billing", description: "Get Pro, add credit, or manage or cancel your subscription." },
      { name: "mcp", description: "MCP servers in this folder." },
      { name: "automations", description: "Scheduled and triggered tasks in this folder; run one, or turn it on or off." },
      { name: "handoff", description: "Continue this chat in the Atlarix app." },
      { name: "logout", description: "Sign out of Atlarix on this computer (the app and CLI share the sign-in)." },
      { name: "feedback", description: "Tell us what to improve; 1, 2 or 3 first also rates this chat.", input: { hint: "1|2|3 (optional), then what to improve" } },
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
    content: plainStepText(st.text),
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
      // "Free" once: Auto's own description already starts with it (QA: "Free · Free · …").
      ...(o.detail || o.free ? { description: [o.free && !/^free\b/i.test(o.detail ?? "") ? "Free" : "", o.detail].filter(Boolean).join(" · ") } : {}),
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
    // Zed and JetBrains start turns themselves: a message waits for the next prompt.
    void import("@/lib/peers/peers").then((m) => m.setIdleMessagesWait(() => !this.atlarixClient));
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

  /**
   * Past chats open in the editor (`_atlarix/sessions_watch`): it is told
   * `_atlarix/sessions_changed` when the stored chats change, whoever changed
   * them (a CLI in another process saving one, say). Before, the list stayed as
   * it was until reopened (QA 4(b), 2026-10-22). One cheap local read every
   * 2 s, only while some page is watching; nothing is sent when nothing changed.
   */
  private sessionWatchers = 0;
  private stopSessionWatch: (() => void) | null = null;

  async watchSessions(on: boolean): Promise<void> {
    this.sessionWatchers = Math.max(0, this.sessionWatchers + (on ? 1 : -1));
    await this.syncStoreWatch();
  }

  /**
   * One watch of the stored sessions while anything needs it: a page showing
   * Past chats, or an open chat whose name another process may change (a
   * rename from the CLI or another editor; the tab kept the old one, QA E4).
   */
  private async syncStoreWatch(): Promise<void> {
    const needed = this.sessionWatchers > 0 || this.threads.size > 0;
    if (!needed) {
      this.stopSessionWatch?.();
      this.stopSessionWatch = null;
      return;
    }
    if (this.stopSessionWatch) return;
    const { watchStoredSessions } = await import("@/lib/sessions/stored-sessions-watch");
    if (this.stopSessionWatch) return;
    this.stopSessionWatch = watchStoredSessions(
      () => {
        if (this.sessionWatchers > 0) void this.client?.notify("_atlarix/sessions_changed", {}).catch(() => {});
        void this.refreshTitles();
      },
      { intervalMs: SESSION_WATCH_MS },
    );
  }

  /** Each open chat takes the name stored for it, when another process changed it. */
  private async refreshTitles(): Promise<void> {
    const ids = [...this.threads.keys()];
    if (!ids.length) return;
    try {
      const { db } = await import("@/db");
      const { chatSessions } = await import("@/db/schema");
      const { inArray } = await import("drizzle-orm");
      const rows = await db
        .select({ id: chatSessions.id, title: chatSessions.title })
        .from(chatSessions)
        .where(inArray(chatSessions.id, ids));
      for (const r of rows) this.threads.get(r.id)?.session.noteStoredTitle(r.title);
    } catch {
      /* a title is cosmetic: the next change tries again */
    }
  }

  private thread(id: string): Thread {
    const t = this.threads.get(id);
    if (!t) throw RequestError.resourceNotFound(id);
    return t;
  }

  private async configOptions(t: Thread): Promise<SessionConfigOption[]> {
    const { options, current, picks, effort, freeAccount } = await this.deps.models().catch(() => ({
      options: [],
      current: undefined,
      picks: undefined,
      effort: undefined,
      freeAccount: undefined,
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
    // /effort: the chosen model's own levels, exactly as it lists them (paid
    // Auto's low / medium / max; none on free Auto). The id stays "thinking" so
    // editors that already draw it keep working.
    const opt = options.find((o) => key(o) === key(chosen));
    const choices = opt?.effortChoices;
    if (choices && !(opt?.free && freeAccount) && this.deps.setEffort) {
      const sel = effort ?? { effort: "", deepThinking: false };
      out.push({
        id: "thinking",
        name: "Effort",
        category: "thought_level",
        type: "select",
        currentValue: chosenLevel(choices, sel.effort || undefined, sel.deepThinking && !sel.effort),
        options: choices.levels.map((l) => ({
          value: l,
          name: l,
          ...(l === choices.defaultLevel ? { description: "default" } : {}),
        })),
      });
    }
    // Computer use: shown for every model; one that can't have it says why.
    if (opt && this.deps.computerUse) {
      const why = opt.computerUse && opt.computerUse !== "eligible" ? opt.computerUse : null;
      const on = !why && this.deps.computerUse.isOn(opt);
      // On, with a macOS grant still to give: say whose name the prompt will carry.
      const notice = on ? await this.deps.computerUse.notice() : null;
      out.push({
        id: "computer_use",
        name: "Computer use",
        type: "select",
        currentValue: on ? "on" : "off",
        options: why
          ? [{ value: "off", name: "Off" }]
          : [
              { value: "on", name: "On" },
              { value: "off", name: "Off" },
            ],
        ...(why ? { description: ineligibleReason(why) } : notice ? { description: notice } : {}),
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
    let id = sessionId ?? "";
    try {
      session = await this.deps.createSession(cwd);
      // A new chat gets its id now; the stored session is made at its first prompt.
      if (!sessionId) id = (await session.open()).sessionId;
      else {
        try {
          await session.resume(sessionId);
        } catch (e) {
          // A new chat that never got a message isn't stored: an editor that
          // reopens it after the agent restarted gets it back, still empty.
          if (!/session not found/i.test((e as Error).message ?? "") || !UUID_RE.test(sessionId)) throw e;
          id = (await session.open(sessionId)).sessionId;
        }
      }
    } catch (e) {
      await session?.close().catch(() => {});
      const msg = (e as Error).message ?? String(e);
      if (isAuthError(msg)) throw RequestError.authRequired(undefined, "Sign in to Atlarix first (`atlarix login`).");
      // A plain throw reaches the editor as "Internal error"; the reason (an
      // older desktop app guarding the database, say) is what the user needs.
      throw RequestError.internalError(undefined, msg);
    }
    if (!session) throw RequestError.internalError(undefined, "Atlarix couldn't start a session.");
    surfaceNames = (await import("../agent/session")).SURFACE_NAMES;
    const t: Thread = new Thread(
      id,
      cwd,
      session,
      this.ctx,
      () => this.atlarixClient,
      () => this.configOptions(t),
    );
    t.setOption = (configId, value) => this.setConfigOption(t.id, configId, value);
    t.forkTo = (title) => this.forkCopy(t.id, title);
    this.threads.set(t.id, t);
    void this.syncStoreWatch();
    return t;
  }

  /** Sessions already reported as opened: the panel loads an open chat again on every return to it. */
  private readonly sessionsOpened = new Set<string>();
  /** New sessions not yet used: the panel opens an empty chat by itself on every launch. */
  private readonly unusedNew = new Set<string>();

  /**
   * Usage analytics for an editor session (only with consent): the process's
   * `session_started` and the day's `active_day` once, and `session_opened`
   * once per session, saying how: new (sent at its first prompt, so the empty
   * chat a panel opens by itself is not a session), load (a past chat) or fork.
   */
  private reportSessionOpened(sessionId: string, how: "new" | "load" | "fork"): void {
    // Decided now, not after the import: a prompt can arrive before it resolves.
    // A load of a new chat nobody has used yet is not a past chat (it counts as
    // new at its first prompt).
    const send = how !== "new" && !this.sessionsOpened.has(sessionId) && !this.unusedNew.has(sessionId);
    if (how === "new") this.unusedNew.add(sessionId);
    else if (send) this.sessionsOpened.add(sessionId);
    void import("@/main/lib/analytics")
      .then((m) => {
        // A failure the editor hit starting us last time (VS Code passes it).
        const hostError = process.env.ATLARIX_HOST_LAST_ERROR;
        m.trackSessionStarted(hostError ? { host_error: hostError } : undefined);
        m.trackActiveDay();
        if (send) m.captureSafe("session_opened", { how });
      })
      .catch(() => {});
  }

  /** A new session's first prompt: now it is one. */
  private reportFirstUse(sessionId: string): void {
    if (!this.unusedNew.delete(sessionId) || this.sessionsOpened.has(sessionId)) return;
    this.sessionsOpened.add(sessionId);
    void import("@/main/lib/analytics")
      .then((m) => m.captureSafe("session_opened", { how: "new" }))
      .catch(() => {});
  }

  async newSession(cwd: string, mcpServers?: unknown): Promise<NewSessionResponse> {
    const t = await this.open(cwd);
    this.reportSessionOpened(t.id, "new");
    t.editorMcpServers = sessionMcpServersFrom(mcpServers);
    await this.deps.setSessionMcpServers?.(t.id, t.editorMcpServers);
    // After the response, so the editor knows the session the list belongs to.
    setTimeout(() => void t.refreshCommands(), 0);
    return { sessionId: t.id, configOptions: await this.configOptions(t), modes: this.modes(t) };
  }

  async loadSession(
    cwd: string,
    sessionId: string,
    mcpServers?: unknown,
  ): Promise<{ configOptions: SessionConfigOption[]; modes: SessionModeState }> {
    const existing = this.threads.get(sessionId);
    const t = existing ?? (await this.open(cwd, sessionId));
    this.reportSessionOpened(t.id, "load");
    t.editorMcpServers = sessionMcpServersFrom(mcpServers);
    await this.deps.setSessionMcpServers?.(t.id, t.editorMcpServers);
    // A thread this process already has open remembers what it sent; the
    // editor that asks to load it again has nothing on screen, so start over.
    if (existing) existing.emitted.clear();
    await t.replay();
    await t.resendPlan();
    t.sendUsage();
    setTimeout(() => {
      void t.refreshCommands();
      t.resendWorking();
    }, 0);
    return { configOptions: await this.configOptions(t), modes: this.modes(t) };
  }

  /**
   * `session/fork`: the conversation as saved now, carried on in a new session
   * in its folder, open here. The original is untouched; a turn another
   * surface is still writing stays out (sessions:fork).
   */
  async forkSession(
    sessionId: string,
    cwd: string,
    mcpServers?: unknown,
  ): Promise<{ sessionId: string; configOptions: SessionConfigOption[]; modes: SessionModeState }> {
    const made = await this.forkCopy(sessionId).catch((e: Error) => {
      throw RequestError.invalidRequest(undefined, e.message);
    });
    return { sessionId: made.id, ...(await this.loadSession(cwd, made.id, mcpServers)) };
  }

  /** The copy itself (`/fork` and `session/fork`): the CLI's AgentSession.fork, without switching to it. */
  private async forkCopy(sessionId: string, title?: string): Promise<{ id: string; title: string }> {
    const open = this.threads.get(sessionId)?.session;
    if (open?.state.busy) throw new Error("Wait for this turn to finish (or stop it), then fork.");
    if (open && !open.myMessages().length) throw new Error("Send a message first: there is nothing to fork yet.");
    const made = (await (await handler("sessions:fork"))({}, sessionId, title ? { title } : undefined)) as { id: string; title: string | null };
    // Counted here, for both forks (session/fork and a typed /fork), before an
    // editor loads the copy, which would otherwise count as a past chat opened.
    this.sessionsOpened.add(made.id);
    void import("@/main/lib/analytics")
      .then((m) => m.captureSafe("session_opened", { how: "fork" }))
      .catch(() => {});
    return { id: made.id, title: made.title ?? "Untitled" };
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
  interject(sessionId: string, text: string, kind: "steer" | "queue"): ReturnType<Thread["interject"]> {
    return this.thread(sessionId).interject(text, kind);
  }

    tasks(sessionId: string, action: "list" | "output" | "stop", id?: string): Promise<Record<string, unknown>> {
    return this.thread(sessionId).tasks(action, id);
  }

  /**
   * The session rating, for an editor that draws its own card (the VS Code
   * panel): whether to ask now (lib/feedback/session-rating.ts), and the answer.
   * Other editors have `/feedback` only: an unprompted question would have to be
   * text in the agent's reply, saved in the chat and read by the model.
   */
  async ratingDue(sessionId: string): Promise<{ ask: boolean }> {
    const t = this.threads.get(sessionId);
    if (!t) return { ask: false };
    const { shouldAskRating } = await import("@/lib/feedback/session-rating");
    const { ratingAskedAt, forceRating } = await import("@/main/lib/session-feedback");
    return {
      ask:
        !t.session.state.busy &&
        shouldAskRating({
          turns: t.session.myMessages().length,
          ratedAt: ratingAskedAt(),
          now: Date.now(),
          askedThisSession: t.ratingAsked,
          force: forceRating(),
        }),
    };
  }

  /** 1-3 answers, 0 dismisses; either way it is not asked again for a while. */
  async rate(sessionId: string, rating: number): Promise<{ ok: boolean }> {
    const t = this.thread(sessionId);
    const { sendSessionFeedback, noteRatingAsked } = await import("@/main/lib/session-feedback");
    t.ratingAsked = true;
    noteRatingAsked();
    if (rating !== 1 && rating !== 2 && rating !== 3) return { ok: true };
    return sendSessionFeedback({ kind: "rating", rating }, await t.feedbackSession());
  }

  async feedback(sessionId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const t = this.thread(sessionId);
    const { sendSessionFeedback } = await import("@/main/lib/session-feedback");
    return sendSessionFeedback({ kind: "text", body: String(text ?? "") }, await t.feedbackSession());
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

  /** A checkpoint's "Restore files only": the files go back, the conversation stays. */
  restoreFiles(sessionId: string, messageId: number) {
    return this.thread(sessionId).session.restoreFilesSince(messageId);
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
      await this.deps.setSessionMcpServers?.(sessionId, []);
      this.threads.delete(sessionId);
      void this.syncStoreWatch();
    }
    if (!this.deps.changeSession) throw RequestError.methodNotFound("_atlarix/session");
    await this.deps.changeSession(sessionId, change);
  }

  prompt(sessionId: string, blocks: readonly ContentBlock[], meta?: unknown): Promise<PromptResponse> {
    this.reportFirstUse(sessionId);
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
      // The level stays only when the new model lists it (owner: never translated).
      const { options, effort } = await this.deps.models().catch(() => ({ options: [], effort: undefined }));
      const next = options.find((o) => o.provider === ref.provider && o.name === ref.name);
      this.deps.setEffort?.(effortAfterModelChange(next?.effortChoices ?? null, effort ?? { effort: "", deepThinking: false }));
    } else if (configId === "thinking" && this.deps.setEffort) {
      const { options, current } = await this.deps.models();
      const want = t.session.model ?? current;
      // The model the picker shows: the first offered when the session's is gone (as configOptions).
      const shown = options.find((o) => want && o.provider === want.provider && o.name === want.name) ?? options[0];
      const choices = shown?.effortChoices;
      if (!choices) throw RequestError.invalidParams(undefined, "this model has no effort setting");
      this.deps.setEffort(effortSettingsPatch(choices, String(value)));
    } else if (configId === "computer_use" && this.deps.computerUse) {
      const { options, current } = await this.deps.models();
      const want = t.session.model ?? current;
      const shown = options.find((o) => want && o.provider === want.provider && o.name === want.name) ?? options[0];
      if (!shown) throw RequestError.invalidParams(undefined, "pick a model first");
      const on = String(value) === "on";
      if (on && shown.computerUse && shown.computerUse !== "eligible") {
        throw RequestError.invalidParams(undefined, ineligibleReason(shown.computerUse));
      }
      this.deps.computerUse.set(shown, on);
    } else throw RequestError.invalidParams(undefined, `unknown option ${configId}`);
    return this.configOptions(t);
  }

  setSessionMode(sessionId: string, modeId: string): void {
    this.setMode(this.thread(sessionId), modeId);
  }

  private setMode(t: Thread, modeId: string): void {
    const m = MODES.find((x) => x.id === modeId);
    if (!m) throw RequestError.invalidParams(undefined, `unknown mode ${modeId}`);
    // Running in another surface: the mode waits for that turn (the session says so).
    const refused = t.session.setMode(m.id);
    if (refused) throw RequestError.invalidRequest(undefined, refused);
  }

  async closeAll(): Promise<void> {
    for (const id of this.threads.keys()) await this.deps.setSessionMcpServers?.(id, []);
    await Promise.all([...this.threads.values()].map((t) => t.session.close().catch(() => {})));
    this.threads.clear();
  }
}
