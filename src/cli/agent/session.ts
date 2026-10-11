/**
 * The interactive CLI's connection to the agent: the SAME main-process handlers
 * the desktop app registers (chat:stream, the session store, permissions),
 * driven in-process, with the TUI in place of the renderer.
 *
 * Events arrive exactly as the renderer receives them (see the event dump in
 * the Phase 2 notes): the whole message list on every `chat:response:chunk`,
 * permission requests in-band on the same channel, `chat:response:end` /
 * `chat:response:error` at the end of a turn. This class turns them into one
 * state object and emits "change"; the TUI renders that state and nothing else.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { placeShellRuns, withShellContext, type ShellRun } from "./shell-mode";
import {
  collapseCancelled,
  markInterrupted,
  placeSteers,
  activityToolLine,
  locateBlocks,
  withDelegations,
  type Delegation,
  type Cell,
  type ChatMessageLike,
  type SteerAnchor,
  type ToolLine,
} from "./transcript";

import { conversationText } from "./btw";
import { handler } from "./ipc";
import { readCliState, turnModelFor } from "./models";
import { applyLiveTextPatch, type LiveTextPatch } from "@/lib/chat/live-text-patch";

/** The desktop's five work modes (WorkModeSchema); "ask" is shown as Explore. */
export type WorkMode = "build" | "ask" | "plan" | "debug" | "review";

export interface PendingApproval {
  operationId: string;
  // The PermissionRequest as sent (src/lib/tools/permissions/schema.ts).
  request: {
    operation?: string;
    preview?: unknown;
  };
}

export interface QueuedMessage {
  id: string;
  text: string;
  /** "steer": goes into the running turn at its next step. "queued": opens the next turn. */
  kind: "steer" | "queued";
}

export interface SessionState {
  cells: Cell[];
  busy: boolean;
  /** "Thinking…", "Running command…" — what the agent says it is doing. */
  phase: string | null;
  turnStartedAt: number | null;
  approvals: PendingApproval[];
  pending: QueuedMessage[];
  mode: WorkMode;
  tokensThisTurn: number | null;
  /** How full the model's context is, from the provider's own count of the last step. */
  contextPercent: number | null;
  /** The same as tokens: what the last step sent, of how many the model holds. */
  contextUsed: number | null;
  contextLimit: number | null;
  /** Tokens used this session, summed per finished turn (only ever goes up). */
  sessionTokens: number;
  /** Of those, read from the provider's prompt cache. */
  cachedTokens: number;
  /** What this session's turns cost on your own keys (Core reports none). */
  costUsd: number;
  lastError: string | null;
  /** ask_user: the turn ended on these questions; the answers open the next one. */
  question: PendingQuestion | null;
  /** A Plan-mode turn ended with a plan ready to build. */
  planReady: { planId: string; title: string } | null;
  /** Bumped each time this session's plan is written or changed: the pinned plan redraws live. */
  planRevision: number;
  /** The session's title, once it has one (the first message names it). */
  title: string | null;
  /** Automation runs that finished while you were here and that you have not opened. */
  automationUnread: number;
  /** An MCP tool the agent wants to call, waiting for your OK (mcp_consent.ts). */
  mcpConsent: McpConsentRequest | null;
}

export interface McpConsentRequest {
  requestId: string;
  serverName: string;
  toolName: string;
  toolDescription?: string;
  inputPreview?: string;
}

export interface PendingQuestion {
  questionId: string;
  items: Array<{ question: string; options?: string[] }>;
}

export interface SessionSummary {
  id: string;
  title: string | null;
  updatedAt: Date | string;
  workMode: string | null;
}

/** The desktop's answer for a question left unanswered (InlineUserQuestions). */
const SKIP_ANSWER = "(skipped)";

/** One message for the model when several questions were asked, as the desktop sends it. */
export function combineAnswers(items: PendingQuestion["items"], answers: string[]): string {
  if (items.length === 1) return answers[0] ?? "";
  return items.map((it, i) => `Q: ${it.question}\nA: ${answers[i]?.trim() || SKIP_ANSWER}`).join("\n\n");
}

export interface LiveTask {
  id: string;
  kind: "agent" | "command";
  label: string;
  elapsedMs: number;
  stalled: boolean;
  /** The background job behind it: its output can be read and it can be stopped. */
  jobId?: string;
  /** A sub-agent's tool calls so far. */
  tools: ToolLine[];
  progress?: string;
  /** A sub-agent's tokens so far. */
  tokens?: number;
  /** What a sub-agent has written so far. */
  text?: string;
}

export interface BackgroundCommand {
  id: string;
  command: string;
  elapsedMs: number;
  stalled: boolean;
}

export interface ModelChoice {
  provider: string;
  name: string;
}

export interface SessionOptions {
  workspaceDir: string;
  /** Per-turn model override; the desktop's selected model when absent. */
  model?: ModelChoice;
  mode?: WorkMode;
  /** How other sessions see this one: the TUI is "cli", `atlarix acp` is "editor". */
  surface?: "cli" | "editor";
  /**
   * A message from another session while idle. The TUI opens a turn with it;
   * an editor (ACP) starts turns itself, so it HOLDS: main keeps the message
   * queued and the next turn reads it at its first step. "peer-message" fires.
   */
  idlePeerMessages?: "start-turn" | "hold";
}

let handlersRegistered = false;

async function registerHandlers(): Promise<void> {
  if (handlersRegistered) return;
  handlersRegistered = true;
  const { registerChatStreamHandlers } = await import("@/ipc/handlers/chat_stream_handlers");
  registerChatStreamHandlers();
  const { registerWorkspaceSessionHandlers } = await import(
    "@/ipc/handlers/workspace_session_handlers"
  );
  registerWorkspaceSessionHandlers();
  await import("@/ipc/handlers/permissions/handlers");
  const { registerBackgroundHandlers } = await import("@/ipc/handlers/background_handlers");
  registerBackgroundHandlers();
}



/** A folder's stored sessions, newest first, without opening one (ACP's session/list). */
export async function listFolderSessions(workspaceDir: string): Promise<SessionSummary[]> {
  const { initializeDatabase } = await import("@/db");
  initializeDatabase();
  await registerHandlers();
  const { workspaceAppIdForPath } = await import("@/lib/workspace-app-by-path");
  const appId = await workspaceAppIdForPath(workspaceDir);
  return (await (await handler("sessions:list"))({}, appId)) as SessionSummary[];
}

/** Every folder's chats, newest first, with each one's folder (an editor's Past chats → All folders). */
export async function listAllSessions(): Promise<Array<SessionSummary & { folder: string; folderName: string }>> {
  const { initializeDatabase } = await import("@/db");
  initializeDatabase();
  await registerHandlers();
  return (await (await handler("sessions:list-all"))({}, 200)) as Array<SessionSummary & { folder: string; folderName: string }>;
}

/** Rename or delete a stored session without opening it (the editor's Past chats). */
export async function changeFolderSession(sessionId: string, change: { rename: string } | { delete: true }): Promise<void> {
  const { initializeDatabase } = await import("@/db");
  initializeDatabase();
  await registerHandlers();
  if ("rename" in change) await (await handler("sessions:rename"))({}, sessionId, change.rename);
  else await (await handler("sessions:delete"))({}, sessionId);
}

let interjectionSeq = 0;

export interface TurnOptions {
  display?: string;
  images?: Array<{ path: string; mime: string; label: string }>;
  /** The answers to ask_user were just recorded: carry the task on, no new prompt. */
  continueAfterQuestions?: boolean;
  /** Sending the same message again (after Auto's consent): its `!` output was already given. */
  retry?: boolean;
}

/** A running sub-agent (spawn-task.ts listRunningSubagentTasks). */
export interface SubagentJob {
  taskId: string;
  description: string;
  prompt?: string;
  elapsedMs: number;
  lastOutput: string;
  stalled: boolean;
}

function formatTokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

export class AgentSession extends EventEmitter {
  readonly workspaceDir: string;
  appId = 0;
  sessionId = "";
  chatId = 0;
  model: ModelChoice | undefined;
  private messages: ChatMessageLike[] = [];
  private shellRuns: ShellRun[] = [];
  // Stream ids only grow. A turn's end can be sent after the NEXT turn started
  // (Enter right as a turn finishes); without this, that late end marked the new
  // turn idle while it ran on. Ends from streams below `staleBelow` are old.
  private highestStreamId = 0;
  private staleBelow = 0;
  private shellProc: ChildProcess | null = null;
  private queue: QueuedMessage[] = [];
  private interruptRequested = false;
  private readonly interrupted = new Set<string>();
  /** Steers sent this turn whose message has not shown up in the transcript yet. */
  private steerTexts: string[] = [];
  private readonly anchors = new Map<string, SteerAnchor>();
  private readonly seenUserIds = new Set<string>();
  private contextWindow: number | null = null;
  private readonly surface: "cli" | "editor";
  private readonly idlePeerMessages: "start-turn" | "hold";
  private detachWindow: (() => void) | null = null;
  state: SessionState;

  private readonly event = {
    sender: {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: (channel: string, payload: unknown) => this.onSend(channel, payload),
    },
  };

  constructor(opts: SessionOptions) {
    super();
    this.workspaceDir = opts.workspaceDir;
    this.model = opts.model;
    this.surface = opts.surface ?? "cli";
    this.idlePeerMessages = opts.idlePeerMessages ?? "start-turn";
    this.state = {
      cells: [],
      busy: false,
      phase: null,
      turnStartedAt: null,
      approvals: [],
      pending: [],
      mode: opts.mode ?? "build",
      tokensThisTurn: null,
      contextPercent: null,
      contextUsed: null,
      contextLimit: null,
      sessionTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      lastError: null,
      question: null,
      planReady: null,
      planRevision: 0,
      title: null,
      automationUnread: 0,
      mcpConsent: null,
    };
  }

  /** Database, handlers, this folder's workspace, and a NEW session in it. */
  async start(): Promise<void> {
    const { initializeDatabase } = await import("@/db");
    initializeDatabase();
    const electron = (await import("electron")) as unknown as {
      attachCliWindow?: (send: (channel: string, payload: unknown) => void) => (() => void) | void;
    };
    this.detachWindow =
      electron.attachCliWindow?.((channel, payload) => this.onSend(channel, payload)) || null;
    await registerHandlers();
    // Other Atlarix sessions (CLI or app) can message this one (lib/peers).
    void import("@/lib/peers/main-host").then((m) => m.startPeerMessaging(this.surface));
    const { workspaceAppIdForPath } = await import("@/lib/workspace-app-by-path");
    this.appId = await workspaceAppIdForPath(this.workspaceDir);
    await this.newSession();
  }

  /**
   * A fresh session in this folder (`/new`), like Codex and Claude Code on start.
   * Only local state here: the session row is created by the FIRST message
   * (ensureSession), so opening the CLI and leaving does not add an empty
   * session to the desktop app's list.
   */
  async newSession(): Promise<void> {
    this.sessionId = "";
    this.chatId = 0;
    this.messages = [];
    this.shellRuns = [];
    this.queue = [];
    this.anchors.clear();
    this.seenUserIds.clear();
    this.persisted.clear();
    this.turnSnapshots.clear();
    this.delegations.clear();
    this.delegationCount.clear();
    this.lastStepTokens = 0;
    this.interrupted.clear();
    this.update({
      cells: [],
      approvals: [],
      pending: [],
      lastError: null,
      busy: false,
      phase: null,
      contextPercent: null,
      contextUsed: null,
      contextLimit: null,
      sessionTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      question: null,
      planReady: null,
      planRevision: 0,
      title: null,
    });
    // A fresh session (startup, /new) is reachable before its first message.
    if (this.appId) void this.registerPendingPeer();
  }

  setMode(mode: WorkMode): void {
    this.update({ mode });
    // A deliberate choice in this session, stamped on it as the desktop does,
    // so resuming it (here or in the app) comes back in the same mode.
    if (this.sessionId) {
      void handler("sessions:set-work-mode")
        .then((h) => h({}, this.sessionId, mode))
        .catch(() => {});
    }
  }

  // ─── earlier sessions (/resume) ────────────────────────────────────────────

  /** This folder's sessions, newest first: the CLI's and the desktop app's. */
  async listSessions(): Promise<SessionSummary[]> {
    const rows = (await (await handler("sessions:list"))({}, this.appId)) as SessionSummary[];
    return rows;
  }

  /**
   * Open an earlier session: its messages on screen, its transport filled so the
   * next turn continues it, its mode back. The desktop's own sequence
   * (allocate-transport → get → hydrate-transport).
   */
  async resume(sessionId: string): Promise<void> {
    if (this.state.busy) throw new Error("Wait for this turn to finish (or esc to stop it), then resume.");
    const { chatId } = (await (await handler("sessions:allocate-transport"))({}, sessionId)) as { chatId: number };
    const got = (await (await handler("sessions:get"))({}, sessionId)) as {
      session: SessionSummary;
      messages: Array<{ id: string; role: string; content: string; modelContent?: string | null; snapshotTurnId?: string | null }>;
    };
    const rows = got.messages.map((m, i) => ({ id: i + 1, sessionRowId: m.id }));
    await (await handler("sessions:hydrate-transport"))({}, { chatId, sessionId, rows });
    await this.newSession();
    this.sessionId = sessionId;
    this.chatId = chatId;
    // Reachable by its real id now (allocate-transport registered it).
    void import("@/lib/peers/peers").then((m) => m.forgetLiveSession(this.pendingPeerId()));
    // modelContent: what the model was sent, when it differs from what you
    // typed (pastes expanded); the transcript shows the paste from it.
    this.messages = got.messages.map((m, i) => ({ id: i + 1, role: m.role, content: m.content, modelContent: m.modelContent ?? null }));
    for (const m of this.messages) {
      if (m.role === "user") this.seenUserIds.add(String(m.id));
      else this.persisted.add(String(m.id));
    }
    got.messages.forEach((m, i) => {
      if (m.snapshotTurnId) this.turnSnapshots.set(String(i + 1), m.snapshotTurnId);
    });
    const mode = got.session.workMode;
    const { getLatestPlanArtifact } = await import("@/lib/plans/plan-artifacts");
    const plan = await getLatestPlanArtifact(sessionId, "plan").catch(() => null);
    this.update({
      cells: this.cellsFor(false),
      title: got.session.title,
      ...(mode === "build" || mode === "ask" || mode === "plan" || mode === "debug" || mode === "review" ? { mode } : {}),
      planReady: plan ? { planId: plan.id, title: plan.title ?? "Plan" } : null,
    });
  }

  /** `atlarix -c`: the newest session in this folder, if there is one. */
  async resumeLatest(): Promise<boolean> {
    const [latest] = await this.listSessions();
    if (!latest) return false;
    await this.resume(latest.id);
    return true;
  }

  // ─── /undo: edit an earlier message and resend ─────────────────────────────

  /** Your messages in this session, newest first (what /undo and esc esc can go back to). */
  myMessages(): Array<{ id: number; text: string }> {
    return this.messages
      .filter((m) => m.role === "user" && m.content.trim() && !/^\*\*\*Q:\*\*\*/.test(m.content))
      .map((m) => ({ id: Number(m.id), text: m.content.trim() }))
      .reverse();
  }

  /** What going back to this message would discard: the replies' file snapshots and the files they touched. */
  async undoPreview(messageId: number): Promise<{ turnIds: string[]; filesChanged: string[]; createdFiles: string[] }> {
    const { discardedTurnSnapshotIds } = await import("@/lib/chat/discarded-turn-snapshots");
    const snapshotById = new Map([...this.turnSnapshots].map(([k, v]) => [Number(k), v]));
    const turnIds = discardedTurnSnapshotIds(
      this.messages.map((m) => ({ id: Number(m.id), role: m.role })),
      messageId,
      snapshotById,
    );
    if (!turnIds.length) return { turnIds, filesChanged: [], createdFiles: [] };
    const files = (await (await handler("snapshot:files-range"))({}, { chatId: this.chatId, turnIds }).catch(() => null)) as {
      filesChanged: string[];
      createdFiles: string[];
    } | null;
    return { turnIds, filesChanged: files?.filesChanged ?? [], createdFiles: files?.createdFiles ?? [] };
  }

  /**
   * The editor's Compare at a checkpoint: the files changed since one of your
   * messages, each with the turn whose snapshot holds its version from before
   * (the first turn after the message that wrote it).
   */
  async checkpointFiles(messageId: number): Promise<Array<{ path: string; turnId: string; created: boolean }>> {
    const { turnIds } = await this.undoPreview(messageId);
    const { listSnapshotFiles } = await import("@/lib/snapshot/snapshot-manager");
    const out = new Map<string, { path: string; turnId: string; created: boolean }>();
    for (const turnId of turnIds) {
      const files = await listSnapshotFiles(this.workspaceDir, turnId).catch(() => null);
      for (const f of files?.filesChanged ?? []) {
        if (!out.has(f)) out.set(f, { path: f, turnId, created: files!.createdFiles.includes(f) });
      }
    }
    return [...out.values()];
  }

  /** One file as it was before `turnId` wrote it (see checkpointFiles). */
  async checkpointBefore(turnId: string, relativePath: string): Promise<{ existed: boolean; content: string } | null> {
    const { readSnapshotFile } = await import("@/lib/snapshot/snapshot-manager");
    return readSnapshotFile({ workspacePath: this.workspaceDir, turnId, relativePath });
  }

  /**
   * Replace an earlier message and carry on from there, as the app's edit does
   * (SimpleInlineChat.performEdit): everything after it leaves the conversation,
   * and with `restoreTurnIds` the files those turns changed go back first.
   */
  async resendEdited(messageId: number, text: string, restoreTurnIds: string[] | null): Promise<{ restoredFiles: number }> {
    if (this.state.busy) throw new Error("Wait for this turn to finish (or esc to stop it).");
    let restoredFiles = 0;
    if (restoreTurnIds?.length) {
      const res = (await (await handler("revert:snapshot-range"))({}, { chatId: this.chatId, turnIds: restoreTurnIds })) as {
        success: boolean;
        restoredFiles?: number;
        error?: string;
      };
      if (!res.success) throw new Error(res.error ?? "Restoring the files failed; nothing was changed.");
      restoredFiles = res.restoredFiles ?? 0;
    }
    await (await handler("chat:edit-message"))(this.event, { chatId: this.chatId, userMessageId: messageId, newContent: text });
    const { getStreamTransport } = await import("@/lib/chat/stream-transport");
    const kept = (getStreamTransport(this.chatId)?.messages ?? []) as ChatMessageLike[];
    this.messages = kept.map((m) => ({ id: m.id, role: m.role, content: m.content, modelContent: m.modelContent ?? null }));
    const ids = new Set(this.messages.map((m) => String(m.id)));
    for (const id of [...this.turnSnapshots.keys()]) if (!ids.has(id)) this.turnSnapshots.delete(id);
    this.shellRuns = this.shellRuns.filter((r) => !r.afterMessageId || ids.has(r.afterMessageId));
    this.update({ cells: this.cellsFor(false), lastError: null, planReady: null, question: null });
    await this.startTurn("", { continueAfterQuestions: true });
    return { restoredFiles };
  }

  // ─── /compact ──────────────────────────────────────────────────────────────

  /** Summarise the conversation so far, as the agent does when the context fills. */
  async compact(): Promise<{ ok: boolean; message: string }> {
    if (this.state.busy) return { ok: false, message: "Compacting waits for the turn to finish (esc stops it)." };
    if (!this.chatId || this.messages.length < 4) {
      return { ok: false, message: "Nothing to compact yet: the conversation is still short." };
    }
    const { forceCompactEphemeralChat } = await import("@/lib/tools/workspace");
    const { getStreamTransport } = await import("@/lib/chat/stream-transport");
    const count = (t: unknown) =>
      ((t as { messages?: Array<{ content?: string }> } | undefined)?.messages ?? []).reduce(
        (n, m) => n + (m.content?.length ?? 0),
        0,
      );
    const before = count(getStreamTransport(this.chatId));
    this.update({ busy: true, phase: "Compacting…", turnStartedAt: Date.now() });
    try {
      const done = await forceCompactEphemeralChat(this.chatId, this.model?.provider);
      if (!done) return { ok: false, message: "Nothing to compact yet: the conversation is still short." };
      const after = count(getStreamTransport(this.chatId));
      // ~4 characters a token: an estimate, said as one.
      const tokens = (chars: number) => formatTokenCount(Math.round(chars / 4));
      return {
        ok: true,
        message: `Compacted · ~${tokens(before)} → ~${tokens(after)} tokens. Earlier messages stay on screen; Atlarix now works from the summary.`,
      };
    } finally {
      this.update({ busy: false, phase: null, turnStartedAt: null, contextPercent: null, contextUsed: null, contextLimit: null });
    }
  }

  // ─── plans (/plan) ─────────────────────────────────────────────────────────

  async plans(): Promise<Array<{ id: string; title: string; status: string; content: string; createdAt: Date }>> {
    if (!this.sessionId) return [];
    const { listPlanArtifactsForSession } = await import("@/lib/plans/plan-artifacts");
    const rows = await listPlanArtifactsForSession(this.sessionId);
    return rows.map((r) => ({
      id: r.id,
      // Rows from before the title column: the first line, as the desktop's card does.
      title: r.title ?? ((r.content.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim() || "Plan"),
      status: r.planStatus,
      content: r.content,
      createdAt: r.createdAt,
    }));
  }

  /** Plans from this folder's earlier sessions (here or in the app), newest first. */
  async earlierPlans(): Promise<Array<{ id: string; title: string; status: string; content: string; createdAt: Date; sessionTitle: string | null }>> {
    const { listPlanArtifactsForWorkspace } = await import("@/lib/plans/plan-artifacts");
    const rows = await listPlanArtifactsForWorkspace(this.appId, { excludeSessionId: this.sessionId || undefined });
    return rows.map((r) => ({
      id: r.id,
      title: r.title ?? ((r.content.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim() || "Plan"),
      status: r.planStatus,
      content: r.content,
      createdAt: r.createdAt,
      sessionTitle: r.sessionTitle,
    }));
  }

  /** An earlier session's plan, copied into this one and built here (the original keeps its history). */
  async buildEarlierPlan(planId: string): Promise<void> {
    if (this.state.busy) throw new Error("Wait for this turn to finish (or esc to stop it), then build.");
    await this.ensureSession();
    const { copyPlanArtifactToSession } = await import("@/lib/plans/plan-artifacts");
    const copy = await copyPlanArtifactToSession(planId, this.sessionId);
    if (!copy) throw new Error("That plan no longer exists.");
    await this.buildPlan(copy.id);
  }

  /** Share a plan as a relic: a hosted link on paid Core, a local page otherwise. */
  async sharePlan(planId: string): Promise<{ url?: string; path?: string; note?: string }> {
    const { getPlanArtifact } = await import("@/lib/plans/plan-artifacts");
    const plan = await getPlanArtifact(planId);
    if (!plan) throw new Error("That plan no longer exists.");
    const title = plan.title ?? ((plan.content.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim() || "Plan");
    const { planPageHtml } = await import("@/lib/relics/plan-page");
    const { runRelic } = await import("@/lib/tools/relic");
    const res = await runRelic({
      title,
      html: planPageHtml(title, plan.content),
      workspace: this.workspaceDir,
      _chatSessionId: this.chatId || undefined,
    });
    if (!res.success) throw new Error(res.error ?? "Couldn't share the plan.");
    return { url: res.url, path: res.path, note: res.note };
  }

  /** "Build it": the plan moves to building and a Build turn starts on it (PlanExecutionPanel.handleBuild). */
  async buildPlan(planId: string): Promise<void> {
    const { setPlanArtifactStatus } = await import("@/lib/plans/plan-artifacts");
    const { BUILD_FROM_PLAN_PROMPT } = await import("@/lib/work-mode");
    await setPlanArtifactStatus(planId, "building");
    this.update({ planReady: null });
    this.setMode("build");
    await this.submit(BUILD_FROM_PLAN_PROMPT);
  }

  dismissPlanReady(): void {
    this.update({ planReady: null });
  }

  // ─── ask_user ──────────────────────────────────────────────────────────────

  /** The answers become your next message and the agent carries on (InlineUserQuestions.submitAll). */
  async answerQuestion(answers: string[]): Promise<void> {
    const q = this.state.question;
    if (!q) return;
    this.update({ question: null });
    const res = (await (await handler("chat:submit-user-question-answer"))(this.event, {
      chatId: this.chatId,
      questionId: q.questionId,
      answer: combineAnswers(q.items, answers),
      questionText: q.items.length === 1 ? q.items[0]!.question : `${q.items.length} questions`,
    })) as { success: boolean; restream?: boolean };
    if (res?.restream) await this.startTurn("", { continueAfterQuestions: true });
  }

  /** Esc on the questions: they stay unanswered; whatever you type next is the reply. */
  dismissQuestion(): void {
    this.update({ question: null });
  }

  /** Your answer to an MCP tool call (the desktop's consent toast). */
  async answerMcpConsent(decision: "accept-once" | "accept-always" | "decline"): Promise<void> {
    const req = this.state.mcpConsent;
    if (!req) return;
    this.update({ mcpConsent: null });
    const { resolveConsent } = await import("@/ipc/utils/mcp_consent");
    resolveConsent(req.requestId, decision);
  }

  // ─── Atlarix Auto's one-time consent ───────────────────────────────────────

  private lastTurn: { text: string; opts: TurnOptions } | null = null;

  /** Free Auto asked for the OK to share prompts; record it and send the refused message again. */
  async acceptAutoConsent(): Promise<void> {
    const { writeSettings } = await import("@/main/settings");
    writeSettings({ atlarixAutoConsentAt: new Date().toISOString() } as never);
    this.update({ lastError: null });
    const last = this.lastTurn;
    if (last) await this.startTurn(last.text, { ...last.opts, retry: true });
  }

  // ─── sub-agents (/agents) ──────────────────────────────────────────────────

  /** /btw: a side question about this conversation; nothing is saved (btw.ts). */
  private recapLine: string | null = null;

  /** Show a recap under the conversation until the next turn starts. */
  showRecap(text: string | null): void {
    this.recapLine = text;
    this.update({ cells: this.cellsFor(this.state.busy) });
  }

  /** The one-line recap for someone coming back (lib/recap); null when none is due or allowed. */
  async recap(opts: { force?: boolean } = {}): Promise<string | null> {
    const { generateRecap } = await import("@/lib/recap/recap");
    const cells = this.state.cells.filter((c) => c.kind !== "recap");
    return generateRecap(conversationText(cells), { chatId: this.chatId, model: this.model, force: opts.force });
  }

  async aside(question: string): Promise<string> {
    const { answerAside } = await import("./btw");
    return answerAside(question, this.state.cells, this.chatId, this.model);
  }

  /** Commands the agent started in the background (run_command background:true), still running. */
  async backgroundCommands(): Promise<BackgroundCommand[]> {
    if (!this.chatId) return [];
    const { listBackgroundJobs } = await import("@/lib/agent/background-commands");
    return listBackgroundJobs(this.chatId).map((j) => ({
      id: j.operationId,
      command: j.command,
      elapsedMs: j.elapsedMs,
      stalled: !!j.stalled,
    }));
  }

  async backgroundOutput(id: string): Promise<string> {
    if (!this.chatId) return "";
    const { readBackgroundOutputTail } = await import("@/lib/agent/background-commands");
    return readBackgroundOutputTail(this.chatId, id).tail;
  }

  async stopBackgroundCommand(id: string): Promise<boolean> {
    if (!this.chatId) return false;
    const { killBackgroundJob } = await import("@/lib/agent/background-commands");
    return killBackgroundJob(this.chatId, id);
  }

  /**
   * Everything still running for this session, as the task list shows it:
   * sub-agents (with the tool calls they have made, like the app's card) and
   * background commands. A sub-agent's delegation is paired with its job (the
   * one that can be read and stopped) by the prompt it was given.
   */
  async liveTasks(): Promise<LiveTask[]> {
    const [jobs, commands] = await Promise.all([
      this.subagentJobs().catch(() => [] as SubagentJob[]),
      this.backgroundCommands().catch(() => [] as BackgroundCommand[]),
    ]);
    const now = Date.now();
    const used = new Set<string>();
    const out: LiveTask[] = [];
    for (const d of this.delegations.values()) {
      if (d.status !== "running") continue;
      const job = jobs.find((j) => !used.has(j.taskId) && j.prompt != null && j.prompt === d.task);
      if (job) used.add(job.taskId);
      out.push({
        id: `agent:${d.id}`,
        kind: "agent",
        label: job?.description || d.label || "Sub-agent",
        elapsedMs: now - (d.startedAt ?? now),
        stalled: job?.stalled ?? false,
        jobId: job?.taskId,
        tools: d.children,
        progress: d.progress,
        tokens: d.tokens,
        text: d.text ? [...d.text.values()].join("\n\n") : undefined,
      });
    }
    // Background sub-agents this session didn't see start (a resumed session).
    for (const j of jobs) {
      if (used.has(j.taskId)) continue;
      out.push({ id: `job:${j.taskId}`, kind: "agent", label: j.description, elapsedMs: j.elapsedMs, stalled: j.stalled, jobId: j.taskId, tools: [] });
    }
    for (const c of commands) {
      out.push({ id: `cmd:${c.id}`, kind: "command", label: c.command, elapsedMs: c.elapsedMs, stalled: c.stalled, jobId: c.id, tools: [] });
    }
    return out;
  }

  /** The latest output of a task from liveTasks(). */
  async taskOutput(t: LiveTask): Promise<string> {
    if (!t.jobId) return "";
    return t.kind === "command" ? this.backgroundOutput(t.jobId) : this.subagentOutput(t.jobId);
  }

  /** Stop a task from liveTasks(). A sub-agent working inside the current turn stops with the turn (esc). */
  async stopTask(t: LiveTask): Promise<string> {
    if (t.kind === "command" && t.jobId) {
      await this.stopBackgroundCommand(t.jobId);
      return `Stopped “${t.label.split("\n")[0]}”.`;
    }
    if (t.jobId) {
      await this.cancelSubagent(t.jobId);
      return `Stopped “${t.label}”.`;
    }
    return "This sub-agent is part of the current turn: esc stops the turn.";
  }

  async subagentJobs(): Promise<SubagentJob[]> {
    if (!this.chatId) return [];
    return ((await (await handler("chat:subagent-jobs-list"))({}, this.chatId)) ?? []) as SubagentJob[];
  }

  async subagentOutput(taskId: string): Promise<string> {
    const res = (await (await handler("chat:subagent-job-output"))({}, { chatId: this.chatId, taskId })) as unknown;
    return (res as { text?: string } | null)?.text ?? "";
  }

  async cancelSubagent(taskId: string): Promise<void> {
    await (await handler("chat:subagent-job-cancel"))({}, { chatId: this.chatId, taskId });
  }

  // ─── export / import ───────────────────────────────────────────────────────

  /** What /export writes: this session's messages as the agent has them. */
  exportable(): { title: string | null; sessionId: string; messages: ChatMessageLike[]; model: ModelChoice | undefined } {
    return { title: this.state.title, sessionId: this.sessionId, messages: this.messages, model: this.model };
  }

  /** A new session in this folder holding these messages, then opened. */
  async importMessages(title: string, messages: Array<{ role: "user" | "assistant"; content: string }>): Promise<void> {
    const created = (await (await handler("sessions:create"))({}, this.appId)) as { id?: string; sessionId?: string };
    const sessionId = created.id ?? created.sessionId!;
    const add = await handler("messages:add");
    for (const m of messages) await add({}, sessionId, m.role, m.content);
    await (await handler("sessions:rename"))({}, sessionId, title);
    await this.resume(sessionId);
  }

  setModel(model: ModelChoice | undefined): void {
    this.model = model;
  }

  /**
   * The model a turn runs on: the Plan model while planning, when one is set
   * (cli-state `planModel`, shared by the terminal and the editors), else the
   * chosen one. "Build it" switches to Build, so the plan is built on the
   * chosen model.
   */
  turnModel(): ModelChoice | undefined {
    if (process.env.ATLARIX_CLI_DEV_PROVIDER === "1") return this.model;
    let plan: ModelChoice | undefined;
    try {
      plan = readCliState().planModel;
    } catch {
      /* no state file: the chosen model */
    }
    return turnModelFor(this.state.mode, this.model, plan) as ModelChoice | undefined;
  }

  /**
   * Enter: a new turn when idle; while a turn runs, a STEER that the agent reads
   * at its next step (Codex's Enter). Tab: `queue()` instead.
   */
  async submit(
    text: string,
    opts: { display?: string; images?: Array<{ path: string; mime: string; label: string }> } = {},
  ): Promise<void> {
    if (this.state.busy) {
      await this.steer(text);
      return;
    }
    await this.startTurn(text, opts);
  }

  /** Held until the running turn ends, then sent as the next turn. Editable until then. */
  queueNext(text: string): void {
    if (!this.state.busy) {
      void this.startTurn(text);
      return;
    }
    this.queue.push({ id: `q${++interjectionSeq}`, text, kind: "queued" });
    this.syncPending();
  }

  /** Pull the most recent queued (not yet sent) message back for editing. */
  popLastQueued(): string | null {
    const last = this.queue.pop();
    this.syncPending();
    return last?.text ?? null;
  }

  private async steer(text: string): Promise<void> {
    const id = `s${++interjectionSeq}`;
    this.steerTexts.push(text.trim());
    const res = (await (await handler("chat:interject"))({}, {
      chatId: this.chatId,
      id,
      text,
    })) as { ok: boolean; pending: Array<{ id: string; text: string }> };
    if (!res.ok) {
      // Could not be attached to the running turn: it opens the next one instead.
      this.queue.push({ id, text, kind: "queued" });
    }
    this.syncPending(res.pending);
  }

  private steers: QueuedMessage[] = [];

  private syncPending(steers?: Array<{ id: string; text: string }>): void {
    if (steers) this.steers = steers.map((s) => ({ id: s.id, text: s.text, kind: "steer" as const }));
    this.update({ pending: [...this.steers, ...this.queue] });
  }

  /**
   * Create the stored session now rather than at the first message. An editor
   * (ACP) needs the id up front; it throws when the user isn't signed in.
   */
  async open(): Promise<{ sessionId: string; chatId: number }> {
    await this.ensureSession();
    return { sessionId: this.sessionId, chatId: this.chatId };
  }

  /** Stop hearing this process's broadcasts and leave the session list. */
  async close(): Promise<void> {
    await this.interrupt();
    this.detachWindow?.();
    this.detachWindow = null;
    const peers = await import("@/lib/peers/peers");
    peers.forgetLiveSession(this.pendingPeerId());
    if (this.sessionId) peers.forgetLiveSession(this.sessionId);
    this.removeAllListeners();
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionId) return;
    // An editor thread claims its session: opened before any message, it must
    // not be handed to (or pruned by) the next session started in this folder.
    const started = (await (await handler("sessions:start"))(
      {},
      this.appId,
      this.surface === "editor" ? { claim: true } : undefined,
    )) as {
      sessionId: string;
      chatId: number;
    };
    this.sessionId = started.sessionId;
    this.chatId = started.chatId;
    // The real session is registered by sessions:start; drop the placeholder.
    void import("@/lib/peers/peers").then((m) => m.forgetLiveSession(this.pendingPeerId()));
  }

  /** The id other sessions can reach this one under before its first message. */
  private pendingPeerId(): string {
    return `pending-${this.surface}-${process.pid}`;
  }

  /** Reachable from other sessions before the first message (lib/peers). */
  private async registerPendingPeer(): Promise<void> {
    const { noteLiveSession } = await import("@/lib/peers/peers");
    noteLiveSession({
      sessionId: this.pendingPeerId(),
      chatId: 0,
      name: `New ${this.surface === "editor" ? "editor" : "CLI"} session (${path.basename(this.workspaceDir)})`,
      workspace: this.workspaceDir,
      materialize: async () => {
        await this.ensureSession();
        return { sessionId: this.sessionId, chatId: this.chatId };
      },
    });
  }

  private async startTurn(text: string, opts: TurnOptions = {}): Promise<void> {
    this.recapLine = null;
    await this.ensureSession();
    if (!opts.continueAfterQuestions) {
      const display = opts.display ?? text;
      if (!opts.retry) text = this.takeShellContext(text);
      opts = { ...opts, display };
      this.lastTurn = { text, opts };
    }
    const attachments = (opts.images ?? []).map((img) => ({
      name: path.basename(img.path),
      type: img.mime,
      data: fs.readFileSync(img.path).toString("base64"),
      attachmentType: "chat-context" as const,
    }));
    this.turnSeq++;
    this.update({
      busy: true,
      phase: "Thinking…",
      turnStartedAt: Date.now(),
      tokensThisTurn: null,
      lastError: null,
    });
    this.steerTexts = [];
    this.steerTakenAt.clear();
    this.staleBelow = this.highestStreamId + 1;
    void this.refreshContextWindow();
    try {
      await (await handler("chat:stream"))(this.event, {
        chatId: this.chatId,
        appId: this.appId,
        workspaceSessionId: this.sessionId,
        prompt: text,
        ...(opts.display && opts.display !== text ? { displayPrompt: opts.display } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(this.turnModel() ? { modelOverride: this.turnModel() } : {}),
        ...(opts.continueAfterQuestions ? { continueAfterQuestions: true } : {}),
        workModeOverride: this.state.mode,
      });
    } catch (e) {
      this.update({ busy: false, phase: null, lastError: e instanceof Error ? e.message : String(e) });
    }
  }

  private async refreshContextWindow(): Promise<void> {
    try {
      const { getContextWindow } = await import("@/ipc/utils/token_utils");
      this.contextWindow = await getContextWindow(this.turnModel() as never, this.chatId);
    } catch {
      this.contextWindow = null;
    }
  }

  /** Esc: stop the running turn. The session stays; the next message starts a new turn. */
  async interrupt(): Promise<void> {
    if (!this.state.busy) return;
    this.interruptRequested = true;
    // Anything queued for after this turn would otherwise start right away.
    this.queue = [];
    this.syncPending();
    try {
      await (await handler("chat:cancel"))({}, this.chatId);
    } catch {
      /* the turn ends through its own error path either way */
    }
  }

  /**
   * When each thought this session watched began and ended, by cell id: a
   * thought ends when anything comes after it, or the turn does. Thoughts read
   * back from an earlier session have no time.
   */
  private readonly thoughtTimes = new Map<string, { start: number; end?: number }>();

  private timeThoughts(cells: Cell[], streaming: boolean): Cell[] {
    const now = Date.now();
    return cells.map((c, i) => {
      if (c.kind !== "thought") return c;
      let t = this.thoughtTimes.get(c.id);
      if (!t) {
        if (!streaming) return c;
        t = { start: now };
        this.thoughtTimes.set(c.id, t);
      }
      if (t.end == null && (i < cells.length - 1 || !streaming)) t.end = now;
      return t.end != null ? { ...c, ms: t.end - t.start } : c;
    });
  }

  private cellsFor(streaming: boolean): Cell[] {
    const cells = this.withFooters(this.numberEdits(this.timeThoughts(this.untimedCells(streaming), streaming)));
    // The recap is shown, never stored: it sits after everything and goes with the next turn.
    return this.recapLine ? [...cells, { kind: "recap", id: "recap", text: this.recapLine }] : cells;
  }

  /** Each turn this session ran, by its reply's id: "Build · deepseek-flash · 12s". */
  private readonly turnFooters = new Map<string, { text: string; interrupted: boolean }>();

  private withFooters(cells: Cell[]): Cell[] {
    if (!this.turnFooters.size) return cells;
    // After the reply's LAST line only. A message sent mid-turn sits inside the
    // reply, and a footer after each part made the turn look finished above it.
    const last = new Map<string, number>();
    cells.forEach((c, i) => last.set(c.id.split(":")[0]!, i));
    const out: Cell[] = [];
    cells.forEach((c, i) => {
      out.push(c);
      const owner = c.id.split(":")[0]!;
      const footer = this.turnFooters.get(owner);
      if (footer && last.get(owner) === i) {
        out.push({ kind: "footer", id: `${owner}:footer`, text: footer.text, interrupted: footer.interrupted });
      }
    });
    return out;
  }

  /** Files read for edit line numbers, by path, with the mtime they were read at. */
  private readonly editFiles = new Map<string, { mtimeMs: number; text: string }>();

  /** An edit's diff with the file's own line numbers (found by its new text in the file). */
  private numberEdits(cells: Cell[]): Cell[] {
    return cells.map((c) => {
      if (c.kind !== "tool" || !c.tool.diff || c.tool.diff.starts) return c;
      const file = path.resolve(this.workspaceDir, c.tool.target);
      let text: string;
      try {
        const st = fs.statSync(file);
        const cached = this.editFiles.get(file);
        if (cached && cached.mtimeMs === st.mtimeMs) text = cached.text;
        else {
          if (st.size > 2_000_000) return c;
          text = fs.readFileSync(file, "utf8");
          this.editFiles.set(file, { mtimeMs: st.mtimeMs, text });
        }
      } catch {
        return c;
      }
      return { ...c, tool: { ...c.tool, diff: { ...c.tool.diff, starts: locateBlocks(c.tool.diff, text) } } };
    });
  }

  private untimedCells(streaming: boolean): Cell[] {
    const messages = collapseCancelled(this.messages, this.interrupted);
    return withDelegations(
      placeShellRuns(
        markInterrupted(placeSteers(messages, this.anchors, { streaming }), this.interrupted),
        this.shellRuns,
      ),
      this.delegations.values(),
    );
  }

  /** Sub-agents started in this session, by delegation id (their work nests under the `task` line). */
  private readonly delegations = new Map<string, Delegation>();
  /** How many delegations each reply has started (the next one's index). */
  private readonly delegationCount = new Map<string, number>();

  /** A sub-agent's `chat:activity` event: started, said something, ran a tool, finished. */
  private onSubagentActivity(p: Record<string, unknown>): boolean {
    const did = typeof p.parentDelegationId === "string" ? p.parentDelegationId : null;
    if (!did) return false;
    let d = this.delegations.get(did);
    if (p.type === "subagent_start" && !d) {
      // The reply being written now is the one whose `task` call started it.
      const last = [...this.messages].reverse().find((m) => m.role === "assistant");
      if (!last) return false;
      const assistantId = String(last.id);
      const index = this.delegationCount.get(assistantId) ?? 0;
      this.delegationCount.set(assistantId, index + 1);
      d = {
        id: did,
        assistantId,
        index,
        status: "running",
        children: [],
        label: typeof p.label === "string" ? p.label : undefined,
        task: typeof p.task === "string" ? p.task : undefined,
        startedAt: typeof p.timestamp === "number" ? p.timestamp : Date.now(),
      };
      this.delegations.set(did, d);
      return true;
    }
    if (!d) return false;
    if (p.type === "subagent_progress" && typeof p.preview === "string") d.progress = p.preview.split("\n")[0]!.slice(0, 120);
    else if (p.type === "subagent_tokens" && typeof p.tokens === "number") d.tokens = p.tokens;
    else if (p.type === "subagent_thought" && p.channel === "text" && typeof p.id === "string" && typeof p.preview === "string") {
      (d.text ??= new Map()).set(p.id, p.preview);
    } else if (p.type === "tool_use") {
      const line = activityToolLine(p);
      const at = d.children.findIndex((c) => c.id === line.id);
      if (at >= 0) d.children[at] = line;
      else d.children.push(line);
    } else if (p.type === "subagent_complete") {
      d.status = p.status === "error" ? "error" : "success";
      if (typeof p.result === "string") d.summary = p.result;
    } else return false;
    return true;
  }

  /** True while a `!command` is running (Esc stops it). */
  get shellRunning(): boolean {
    return this.shellProc != null;
  }

  /**
   * `!command`: run it in this folder as the user's own command — no approval,
   * no sandbox — streaming into the transcript. The agent gets the command and
   * its output with the next message (shell-mode.ts).
   */
  async runShell(command: string): Promise<void> {
    if (this.shellProc) {
      this.update({ lastError: "A command is already running. Esc stops it." });
      return;
    }
    const { runShellCommandStreaming, killShellProcess } = await import("@/ipc/utils/runShellCommand");
    const run: ShellRun = {
      id: `${Date.now().toString(36)}${++interjectionSeq}`,
      command,
      output: "",
      exitCode: null,
      status: "running",
      afterMessageId: this.messages.length ? String(this.messages.at(-1)!.id) : "",
      delivered: false,
    };
    this.shellRuns.push(run);
    const redraw = () => this.update({ cells: this.cellsFor(this.state.busy), lastError: null });
    redraw();
    let stopped = false;
    this.stopShell = () => {
      stopped = true;
      killShellProcess(this.shellProc);
    };
    try {
      const result = await runShellCommandStreaming(command, this.workspaceDir, {
        workspaceRoot: this.workspaceDir,
        onSpawn: (proc) => {
          this.shellProc = proc;
          redraw();
        },
        onOutput: (o) => {
          run.output = [o.stdout, o.stderr].filter(Boolean).join(o.stdout && o.stderr ? "\n" : "");
          redraw();
        },
      });
      run.output = [result.stdout, result.stderr].filter((x) => x?.trim()).join("\n");
      run.exitCode = result.exitCode;
      run.status = stopped ? "interrupted" : "success";
    } catch (e) {
      run.output = e instanceof Error ? e.message : String(e);
      run.status = "error";
    } finally {
      this.shellProc = null;
      this.stopShell = null;
      redraw();
    }
  }

  /** Esc while a `!command` runs. */
  stopShell: (() => void) | null = null;

  /** The prompt with any `!command` runs since the last message, which are then marked given. */
  private takeShellContext(text: string): string {
    const out = withShellContext(text, this.shellRuns);
    for (const r of this.shellRuns) if (r.status !== "running") r.delivered = true;
    return out;
  }

  /**
   * Where in the answer each steer was TAKEN, by its text. Main takes it from
   * the queue (this event) before the step that reads it streams; the message
   * itself reaches the list later, after a database write, by which time the
   * answer had often grown past it, so it was drawn below the reply that read it
   * (owner, 2026-10-05: "it goes to the bottom").
   */
  private readonly steerTakenAt = new Map<string, { assistantId: string; offset: number }>();

  private noteDelivered(pending: Array<{ id: string; text: string }>): void {
    const still = new Set(pending.map((x) => x.id));
    const answer = [...this.messages].reverse().find((m) => m.role === "assistant");
    if (!answer) return;
    for (const st of this.steers) {
      if (still.has(st.id)) continue;
      const key = st.text.trim();
      if (!this.steerTakenAt.has(key)) {
        this.steerTakenAt.set(key, { assistantId: String(answer.id), offset: answer.content.length });
      }
    }
  }

  /** A steer's message appearing in the list: remember where in the answer it arrived. */
  private anchorSteers(): void {
    let lastAssistant = -1;
    this.messages.forEach((m, i) => {
      if (m.role === "assistant") lastAssistant = i;
    });
    this.messages.forEach((m, i) => {
      const id = String(m.id);
      if (m.role !== "user" || this.seenUserIds.has(id)) return;
      this.seenUserIds.add(id);
      const k = this.steerTexts.indexOf(m.content.trim());
      if (k < 0 || lastAssistant < i) return;
      this.steerTexts.splice(k, 1);
      const answer = this.messages[lastAssistant]!;
      const taken = this.steerTakenAt.get(m.content.trim());
      this.steerTakenAt.delete(m.content.trim());
      const at = taken && taken.assistantId === String(answer.id) ? taken.offset : answer.content.length;
      this.anchors.set(id, { messageId: id, assistantId: String(answer.id), offset: Math.min(at, answer.content.length) });
    });
  }

  async answerApproval(
    operationId: string,
    approvalMode: "once" | "deny" | "always_allow" | "always_allow_file" | "always_allow_directory",
  ): Promise<void> {
    this.update({ approvals: this.state.approvals.filter((a) => a.operationId !== operationId) });
    await (await handler("execute-permission"))({}, {
      chatId: this.chatId,
      operationId,
      approvalMode,
      appId: this.appId,
    });
  }

  // ─── events from the agent ─────────────────────────────────────────────────

  private onSend(channel: string, payload: unknown): void {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (typeof p.chatId === "number" && p.chatId !== this.chatId) return;
    if (typeof p.streamId === "number") this.highestStreamId = Math.max(this.highestStreamId, p.streamId);
    switch (channel) {
      // The desktop's permission handler sends requests to every WINDOW on their
      // own channel (reaching the CLI through attachCliWindow); some paths also
      // send them in-band on the chunk channel. Either way, one prompt per op.
      case "permission-request":
        this.addApproval(p);
        return;
      case "chat:response:chunk": {
        if (p.type === "permission-request") {
          this.addApproval(p);
          return;
        }
        if (Array.isArray(p.messages)) {
          // Copies: main runs in this process and keeps writing the live row it
          // sent. Shared, the row already held each patch's text when the patch
          // came, so the patch read as "no change": thinking and the answer
          // reached the screen and the editor only when the turn ended.
          this.messages = (p.messages as ChatMessageLike[]).map((m) => ({ ...m }));
          this.anchorSteers();
          this.update({ cells: this.cellsFor(this.state.busy) });
          return;
        }
        // Mid-turn, main sends only the live row's text (a `patch`) after the
        // first full list of the stream.
        const patch = p.patch as LiveTextPatch | undefined;
        if (patch) {
          const idx = this.messages.findIndex((m) => m.id === patch.messageId);
          if (idx < 0) return;
          const content = applyLiveTextPatch(this.messages[idx]!.content, patch);
          if (content === null || content === this.messages[idx]!.content) return;
          const next = this.messages.slice();
          next[idx] = { ...this.messages[idx]!, content };
          this.messages = next;
          this.update({ cells: this.cellsFor(this.state.busy) });
        }
        return;
      }
      case "chat:background-job-update":
        // Another Atlarix session sent this one a message while it was idle:
        // open a turn with it (lib/peers). While busy, the running turn reads it
        // at its next step instead, so nothing is needed here.
        if (p.status === "peer_message" && !this.state.busy) {
          if (this.idlePeerMessages === "hold") this.emit("peer-message");
          else void this.startPeerTurn();
        }
        return;
      case "chat:interjections":
        // Main's queue of steers changed: one was delivered, or added elsewhere.
        if (Array.isArray(p.pending)) {
          this.noteDelivered(p.pending as Array<{ id: string; text: string }>);
          this.syncPending(p.pending as Array<{ id: string; text: string }>);
        }
        return;
      case "chat:stream:phase":
        this.update({ phase: typeof p.label === "string" ? p.label : null });
        return;
      case "chat:token-usage": {
        // A step's REAL usage carries inputTokens (the whole prompt it sent), which
        // is how full the context is. Mid-stream estimates carry null there.
        const input = typeof p.inputTokens === "number" ? p.inputTokens : null;
        const output = typeof p.outputTokens === "number" ? p.outputTokens : 0;
        const patch: Partial<SessionState> = { tokensThisTurn: output };
        if (input != null) this.lastStepTokens = input + output;
        if (input != null && this.contextWindow) {
          patch.contextPercent = Math.min(100, Math.round(((input + output) / this.contextWindow) * 100));
          patch.contextUsed = input + output;
          patch.contextLimit = this.contextWindow;
        }
        this.update(patch);
        return;
      }
      case "chat:activity":
        if (this.onSubagentActivity(p)) this.update({ cells: this.cellsFor(this.state.busy) });
        return;
      case "user-question-request": {
        const items = Array.isArray(p.questions) && p.questions.length
          ? (p.questions as PendingQuestion["items"])
          : [{ question: String(p.question ?? ""), options: p.options as string[] | undefined }];
        this.update({ question: { questionId: String(p.questionId ?? ""), items } });
        return;
      }
      case "mcp:tool-consent-request":
        this.update({
          mcpConsent: {
            requestId: String(p.requestId ?? ""),
            serverName: String(p.serverName ?? "MCP server"),
            toolName: String(p.toolName ?? "tool"),
            toolDescription: typeof p.toolDescription === "string" ? p.toolDescription : undefined,
            inputPreview: typeof p.inputPreview === "string" ? p.inputPreview : undefined,
          },
        });
        return;
      case "plan:artifact-updated":
        if (typeof p.planId === "string" && (!p.sessionId || p.sessionId === this.sessionId)) {
          this.planTouched = { planId: p.planId, title: typeof p.title === "string" && p.title ? p.title : "Plan" };
          this.update({ planRevision: this.state.planRevision + 1 });
        }
        return;
      case "automation:run-update":
        // A run finished in this process or the app's: counted until /automations is opened.
        if (p.status && p.status !== "running" && p.unread !== false) {
          this.update({ automationUnread: this.state.automationUnread + 1 });
          this.emit("automation", p);
        }
        return;
      case "chat:response:error":
        // A cancel reports itself as an error; it is not one.
        if (this.interruptRequested) return;
        this.update({ lastError: String(p.error ?? p.message ?? "The turn failed.") });
        return;
      case "chat:response:end":
        if (typeof p.streamId === "number" && p.streamId < this.staleBelow) return;
        // Main sends a turn's end TWICE (same stream). Ending it twice ran
        // onTurnEnd twice, and the second, finishing later, marked the session
        // idle while the NEXT turn (sent or queued in between) was running:
        // the box then started a parallel turn instead of steering.
        if (typeof p.streamId === "number" && p.streamId === this.endedStreamId) return;
        if (typeof p.streamId === "number") this.endedStreamId = p.streamId;
        this.lastEnd = p;
        this.update({
          sessionTokens: this.state.sessionTokens + (typeof p.turnTokens === "number" ? p.turnTokens : 0),
          cachedTokens: this.state.cachedTokens + (typeof p.turnCachedInputTokens === "number" ? p.turnCachedInputTokens : 0),
          costUsd: this.state.costUsd + (typeof p.turnCostUsd === "number" ? p.turnCostUsd : 0),
        });
        void this.onTurnEnd();
        return;
      default:
        return;
    }
  }

  private addApproval(p: Record<string, unknown>): void {
    const op = String(p.operationId ?? "");
    if (!op || this.state.approvals.some((a) => a.operationId === op)) return;
    this.update({
      approvals: [
        ...this.state.approvals,
        { operationId: op, request: (p.request ?? {}) as PendingApproval["request"] },
      ],
    });
  }

  /** The plan the agent wrote or changed during this turn. */
  private planTouched: { planId: string; title: string } | null = null;

  markAutomationsRead(): void {
    this.update({ automationUnread: 0 });
  }

  /** Your own name for this session; never replaced by a generated one. */
  /**
   * CLI → app handoff: the running Atlarix app opens this session in a window
   * and carries on there (lib/peers). Same database, so nothing is copied.
   * On a Mac with the app closed, it is opened first.
   */
  async handoffToApp(): Promise<void> {
    if (this.state.busy) throw new Error("Wait for this turn to finish (or press esc), then hand it over.");
    if (!this.sessionId) throw new Error("Send a message first: there is no session to hand over yet.");
    const peers = await import("@/lib/peers/peers");
    let app = peers.liveAppProcess();
    if (!app && process.platform === "darwin") {
      const { spawn } = await import("node:child_process");
      spawn("open", ["-a", "Atlarix"], { detached: true, stdio: "ignore" }).unref();
      for (let i = 0; i < 30 && !app; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        app = peers.liveAppProcess();
      }
    }
    if (!app) throw new Error("Open the Atlarix app first, then /handoff again.");
    const r = await peers.requestOpenInApp(app, this.sessionId);
    if (!r.ok) throw new Error(`The app couldn't open it: ${r.error ?? "unknown error"}`);
  }

  async rename(title: string): Promise<void> {
    const name = title.trim();
    if (!name) throw new Error("Give the session a name: /rename <name>");
    if (!this.sessionId) throw new Error("Send a message first; then the session can be named.");
    await (await handler("sessions:rename"))({}, this.sessionId, name);
    this.update({ title: name });
  }

  /**
   * The session's title, read back after each turn. The first message names it
   * twice, a quick placeholder and then the model's title a few seconds later,
   * so stopping at the first one kept the placeholder for good.
   */
  private async refreshTitle(): Promise<void> {
    if (!this.sessionId) return;
    try {
      const { db } = await import("@/db");
      const { chatSessions } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      const row = await db.query.chatSessions.findFirst({ where: eq(chatSessions.id, this.sessionId) });
      if (row?.title && row.title !== this.state.title) this.update({ title: row.title });
    } catch {
      /* the title is a nicety */
    }
  }

  /** The last `chat:response:end` payload (what the reply is saved with). */
  private lastEnd: Record<string, unknown> = {};
  /** The stream whose end was handled (main repeats it). */
  private endedStreamId: number | null = null;
  /** Bumped by every turn that starts: an older turn's ending must not touch a newer turn. */
  private turnSeq = 0;
  /** A reply's file snapshot (its turn id), for /undo: assistant transport id → turn id. */
  private readonly turnSnapshots = new Map<string, string>();
  /** Assistant messages already in the session store (by transport id). */
  private readonly persisted = new Set<string>();
  /** The provider's total for the turn's last step (the context meter's ground truth on reload). */
  private lastStepTokens = 0;

  /**
   * Save the turn's reply in the session, as the desktop's renderer does when a
   * turn ends (useStreamChat): main saves the user's message, the client saves
   * the answer. Without this a CLI session held only questions — /resume (here
   * or in the app) showed no replies and the model lost them.
   */
  private async persistReply(): Promise<void> {
    const last = this.messages.at(-1);
    if (!this.sessionId || last?.role !== "assistant") return;
    const id = String(last.id);
    const content = last.content.trim();
    if (!content || this.persisted.has(id)) return;
    this.persisted.add(id);
    const end = this.lastEnd;
    if (typeof end.snapshotTurnId === "string") this.turnSnapshots.set(id, end.snapshotTurnId);
    const extras: { modelContent?: string; snapshotTurnId?: string; maxTokensUsed?: number } = {};
    if (typeof end.assistantModelContent === "string") extras.modelContent = end.assistantModelContent;
    if (typeof end.snapshotTurnId === "string") extras.snapshotTurnId = end.snapshotTurnId;
    if (this.lastStepTokens > 0) extras.maxTokensUsed = this.lastStepTokens;
    try {
      await (await handler("messages:add"))({}, this.sessionId, "assistant", content, undefined, Object.keys(extras).length ? extras : undefined);
    } catch {
      this.persisted.delete(id);
    }
  }

  private async onTurnEnd(): Promise<void> {
    const seq = this.turnSeq;
    // A stopped turn's partial answer is saved by main (upsertInterruptedAssistantDraft).
    if (!this.interruptRequested) await this.persistReply();
    // A newer turn started while the reply was being saved: it owns the state now.
    if (seq !== this.turnSeq) return;
    void this.refreshTitle();
    // The model's title can land after a short first turn ends: look once more.
    setTimeout(() => void this.refreshTitle(), 8_000).unref?.();
    const touched = this.planTouched;
    this.planTouched = null;
    // Anything still listed as a steer either reached a step or is taken by the
    // flush below; either way it is no longer waiting on this turn.
    this.steers = [];
    const wasInterrupted = this.interruptRequested;
    this.interruptRequested = false;
    const lastReply = [...this.messages].reverse().find((m) => m.role === "assistant");
    if (wasInterrupted && lastReply) this.interrupted.add(String(lastReply.id));
    if (lastReply && this.state.turnStartedAt) {
      const secs = Math.max(1, Math.round((Date.now() - this.state.turnStartedAt) / 1000));
      const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s` : `${secs}s`;
      const mode = { build: "Build", ask: "Explore", plan: "Plan", debug: "Debug", review: "Review" }[this.state.mode];
      this.turnFooters.set(String(lastReply.id), {
        text: [mode, this.model?.name, took].filter(Boolean).join(" · "),
        interrupted: wasInterrupted,
      });
    }
    this.update({
      pending: [...this.queue],
      busy: false,
      phase: null,
      turnStartedAt: null,
      cells: this.cellsFor(false),
      lastError: wasInterrupted ? null : this.state.lastError,
    });
    if (touched && !wasInterrupted && this.state.mode === "plan" && !this.state.question) {
      const { getPlanArtifact } = await import("@/lib/plans/plan-artifacts");
      const plan = await getPlanArtifact(touched.planId).catch(() => null);
      if (plan?.planStatus === "plan") this.update({ planReady: touched });
    }
    if (wasInterrupted) {
      // A stopped turn opens nothing: steers typed during it are dropped with it.
      await Promise.resolve((await handler("chat:interject-flush"))({}, this.chatId)).catch(() => {});
      this.syncPending();
      return;
    }
    // A steer that never reached a step (the model stopped first) opens the next
    // turn, ahead of anything queued: it was said first. Take-once in main.
    const flushed = (await (await handler("chat:interject-flush"))({}, this.chatId)) as {
      text?: string | null;
    };
    this.steers = [];
    const next = flushed?.text?.trim() ? flushed.text : this.queue.shift()?.text;
    this.syncPending();
    if (next) await this.startTurn(next);
  }

  /** Open a turn with a message another session queued while this one was idle. */
  /**
   * Read the messages another session left while this one was idle and held
   * them (`idlePeerMessages: "hold"`): the editor extension's "read it now".
   */
  async takeHeldPeerMessages(): Promise<void> {
    if (!this.state.busy) await this.startPeerTurn();
  }

  private async startPeerTurn(): Promise<void> {
    const flushed = (await Promise.resolve((await handler("chat:interject-flush"))({}, this.chatId)).catch(
      () => null,
    )) as { text?: string | null } | null;
    const text = flushed?.text?.trim();
    this.syncPending();
    if (text && !this.state.busy) await this.startTurn(text);
  }

  private update(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.emit("change", this.state);
  }
}

/**
 * `--provider-url` (testing against a local OpenAI-compatible model, e.g. the
 * fake one): seed that endpoint as a custom provider. Only ever called with a
 * scratch data folder (src/cli/entry.mts), never the desktop's.
 */
export async function seedDevProvider(opts: {
  baseUrl: string;
  model: string;
  apiKey?: string;
}): Promise<ModelChoice> {
  const { initializeDatabase } = await import("@/db");
  const db = initializeDatabase();
  const schema = await import("@/db/schema");
  const id = "atlarix-cli-dev";
  db.insert(schema.language_model_providers)
    .values({ id, name: "Local endpoint (CLI dev)", api_base_url: opts.baseUrl })
    .onConflictDoUpdate({
      target: schema.language_model_providers.id,
      set: { api_base_url: opts.baseUrl },
    })
    .run();
  db.insert(schema.language_models)
    .values({ displayName: opts.model, apiName: opts.model, customProviderId: id })
    .onConflictDoNothing()
    .run();
  const { writeSettings } = await import("@/main/settings");
  writeSettings({
    providerSettings: { [id]: { apiKey: { value: opts.apiKey ?? "dev" } } },
  } as never);
  return { provider: id, name: opts.model };
}
