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
import { ownMessages, withTeammateMessages } from "./own-messages";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { placeShellRuns, withShellContext, type ShellRun } from "./shell-mode";
import {
  collapseCancelled,
  markInterrupted,
  interruptedRowIds,
  placeSteers,
  collectAnchors,
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
import { approvalConfirmation, firstPreview } from "./approval-choices";
import { inlinePlan } from "./inline-plan";
import { handler } from "./ipc";
import { readCliState, turnModelFor } from "./models";
import { applyLiveTextPatch, type LiveTextPatch } from "@/lib/chat/live-text-patch";
import { stripThinkBlocks } from "@/ipc/utils/thinking_tags";
import type { SessionLineage, SessionOrigin } from "@/shared/session-lineage";

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
  /** The running (or last) turn was started by the user's own message, not a peer or a wake. */
  userTurn: boolean;
  /**
   * Computer use is on for this session's model. The switch is shared with the
   * app and the editors (user-settings.json), so it can be turned on elsewhere:
   * the CLI then took the real screen with no sign of it (15.11.0, ai-c8).
   */
  computerUse: boolean;
  /** "Thinking…", "Running command…" — what the agent says it is doing. */
  phase: string | null;
  /** "Couldn't connect, retrying in 2s (1/3)…" while a request is retried, else null. */
  retrying: string | null;
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
  /** A plan waiting for /build: a new one, or (`resume`) a build that stopped with steps left. */
  planReady: { planId: string; title: string; resume?: boolean } | null;
  /** Bumped each time this session's plan is written or changed: the pinned plan redraws live. */
  planRevision: number;
  /** The session's title, once it has one (the first message names it). */
  title: string | null;
  /** Automation runs that finished while you were here and that you have not opened. */
  automationUnread: number;
  /** An MCP tool the agent wants to call, waiting for your OK (mcp_consent.ts). */
  mcpConsent: McpConsentRequest | null;
  /** MCP servers the agent suggested connecting, newest last (mcp-suggestions.ts). */
  mcpSuggestions: McpSuggestionCard[];
  /**
   * Another surface is running a turn of this session: this one follows it
   * (re-reads it as it grows; what you type goes to that turn; Stop stops it).
   */
  following: { surface: "cli" | "app" | "chrome" | "editor"; name: string } | null;
}

/** A suggestion card as the CLI and ACP show it. */
export interface McpSuggestionCard {
  id: string;
  server: string;
  title: string;
  reason: string;
  verified: boolean;
  publisher: string;
  /** Values it asks for before it can be added (none when already added). */
  inputs: Array<{ key: string; label: string; secret: boolean; required: boolean; default?: string }>;
  optionId?: string;
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
  /** Where it came from (src/shared/session-lineage.ts); lists put it under its parent. */
  parentSessionId?: string | null;
  origin?: SessionOrigin | null;
  depth?: number;
  runs?: number;
  parentTitle?: string;
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
  const { registerWorkspaceSessionHandlers, seedEphemeralCounterFromSessions } = await import(
    "@/ipc/handlers/workspace_session_handlers"
  );
  registerWorkspaceSessionHandlers();
  // Number this process's transports below every stored one, as the app does
  // (main.ts): every process counts its own, and the CLI started at -1 each time.
  await seedEphemeralCounterFromSessions();
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
  return withoutUnusedChats((await (await handler("sessions:list"))({}, appId)) as SessionSummary[]);
}

/**
 * A chat opened and never used ("Untitled", no messages) is not a past chat;
 * the editor listed it (QA #31). One with a title of its own stays.
 */
async function withoutUnusedChats<T extends { id: string; title: string | null }>(rows: T[]): Promise<T[]> {
  const blank = rows.filter((r) => !r.title?.trim() || /^(Untitled|New chat|New session)$/.test(r.title.trim()));
  if (!blank.length) return rows;
  const { db } = await import("@/db");
  const { sessionMessages } = await import("@/db/schema");
  const { inArray } = await import("drizzle-orm");
  const used = new Set(
    (await db.selectDistinct({ id: sessionMessages.sessionId }).from(sessionMessages).where(inArray(sessionMessages.sessionId, blank.map((r) => r.id)))).map((r) => r.id),
  );
  return rows.filter((r) => !blank.includes(r) || used.has(r.id));
}

/** Every folder's chats, newest first, with each one's folder (an editor's Past chats → All folders). */
export async function listAllSessions(): Promise<Array<SessionSummary & { folder: string; folderName: string }>> {
  const { initializeDatabase } = await import("@/db");
  initializeDatabase();
  await registerHandlers();
  return withoutUnusedChats((await (await handler("sessions:list-all"))({}, 200)) as Array<SessionSummary & { folder: string; folderName: string }>);
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

/**
 * A "◇ … finished · 21s" line, kept under the line that was last when it
 * finished. `cellId` names a note that is not a wake: "approved:<op>", the line
 * an answered approval leaves (approvalConfirmation).
 */
export type WakeNote = {
  id: string;
  afterCellId: string;
  afterMessageId: string;
  text: string;
  cellId?: string;
  /**
   * A note for the start of a turn: under that turn's message, which has no id
   * yet when the turn starts. The message count then; the note is placed under
   * the first user message after it (or after the last line before the turn,
   * for a turn with none), and not drawn until the turn has a line.
   */
  underTurnFrom?: number;
};

/** Notes placed by placeWakeNotes: never the anchor for another one. */
const isNoteCell = (id: string) => id.startsWith("wake:") || id.startsWith("approved:");

/**
 * Put each wake note after the line that was last when it finished. Anchoring
 * to the MESSAGE alone put it after that message's last line, and a reply still
 * being written keeps growing, so every note finished mid-turn sank to the
 * bottom and stacked there (owner, 2026-10-16). The message is the fallback for
 * a line that has since gone (a collapsed thought).
 */
export function placeWakeNotes(cells: readonly Cell[], notes: readonly WakeNote[]): Cell[] {
  const out = [...cells];
  for (const n of notes) {
    let at = n.afterCellId ? out.findIndex((c) => c.id === n.afterCellId) + 1 : 0;
    if (at === 0) {
      at = out.length;
      if (n.afterMessageId) {
        const prefix = `${n.afterMessageId}:`;
        for (let i = out.length - 1; i >= 0; i--) {
          if (out[i]!.id.startsWith(prefix)) {
            at = i + 1;
            break;
          }
        }
      }
    }
    while (at < out.length && isNoteCell(out[at]!.id)) at++;
    out.splice(at, 0, { kind: "notice", id: n.cellId ?? `wake:${n.id}`, level: "info", text: n.text });
  }
  return out;
}

/**
 * The running call an approval card was for, by its command or file: with
 * several calls in one step (three edits at once), "the last line" was the
 * last call, so the receipt sat under the wrong one (A2, QA 2/2). Paths compare
 * either way round: the card's may be absolute where the call's is relative.
 */
export function askingToolCell(cells: readonly Cell[], asked: { command?: string; path?: string }): string | null {
  const same = (target: string) =>
    (!!asked.command && target === asked.command) ||
    (!!asked.path && !!target && (target === asked.path || asked.path.endsWith(`/${target}`) || target.endsWith(`/${asked.path}`)));
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i]!;
    if (c.kind === "tool" && c.tool.status === "running" && same(c.tool.target)) return c.id;
  }
  return null;
}

/** The line a wake note goes under: the last one on screen that a turn's own lines are built from. */
function lastAnchorCell(cells: readonly Cell[]): string {
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i]!;
    if (c.kind === "recap" || c.kind === "footer" || isNoteCell(c.id) || c.id.includes(":turn-notice")) continue;
    return c.id;
  }
  return "";
}

/**
 * Take main's message list, keeping the thinking of replies already seen.
 *
 * When a turn ends, main strips the thinking from its in-memory copy of the
 * reply (to keep the model's next context lean); the saved copy keeps it. The
 * next turn's list then replaced ours, and every earlier turn's thoughts went
 * from the live transcript while a resumed session still had them (QA). A
 * reply whose new text is its old text minus the thinking keeps the old text.
 */
export function keepThoughts(prev: readonly ChatMessageLike[], next: readonly ChatMessageLike[]): ChatMessageLike[] {
  const before = new Map(prev.map((m) => [String(m.id), m]));
  return next.map((m) => {
    const old = before.get(String(m.id));
    if (m.role !== "assistant" || !old || old.content === m.content || !old.content.includes("think")) return { ...m };
    const plain = stripThinkBlocks(old.content).trim();
    const now = m.content.trim();
    if (plain === now) return { ...m, content: old.content };
    // A stopped turn: the same text without its thinking, plus the stop note.
    if (plain && now.startsWith(plain)) return { ...m, content: `${old.content.trimEnd()}${now.slice(plain.length)}` };
    return { ...m };
  });
}

/** Job reports that wake an idle agent (the desktop's list, useStreamChat). */
const WAKE_STATUSES = new Set(["finished", "stalled", "scheduled", "condition_met"]);

export interface TurnOptions {
  display?: string;
  images?: Array<{ path: string; mime: string; label: string }>;
  /** The answers to ask_user were just recorded: carry the task on, no new prompt. */
  continueAfterQuestions?: boolean;
  /** Sending the same message again (after Auto's consent): its `!` output was already given. */
  retry?: boolean;
  /** Machine-started: background work reported in. Main refuses one it should not run. */
  systemWake?: boolean;
  /** A message another session queued: a peer turn, not the user's own. */
  peerTurn?: boolean;
}

/** A session's message as saved (`sessions:get`). */
type SavedMessage = {
  id: string;
  role: string;
  content: string;
  status?: string | null;
  modelContent?: string | null;
  snapshotTurnId?: string | null;
  maxTokensUsed?: number | null;
};

/** How often a session looks for a turn of it running elsewhere: drafts are saved every 1.5 s. */
const FOLLOW_POLL_MS = 1_500;

export { SURFACE_NAMES } from "@/lib/peers/peer-message";
import { SURFACE_NAMES } from "@/lib/peers/peer-message";

/**
 * A session starting (new, or resumed) reads the account's MCP servers again:
 * they may have changed on the website or in another Atlarix. The CLI has no
 * window focus, so this is its moment (lib/mcp/account-connectors.ts).
 */
function clearAccountMcpServers(): void {
  void import("@/lib/mcp/account-connectors").then((m) => m.clearAccountConnectorsCache()).catch(() => {});
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

export class AgentSession extends EventEmitter {
  readonly workspaceDir: string;
  appId = 0;
  sessionId = "";
  chatId = 0;
  model: ModelChoice | undefined;
  /** The model the running (or last) turn was sent with, for its saved reply. */
  private turnRanOn: ModelChoice | undefined;
  private messages: ChatMessageLike[] = [];
  private shellRuns: ShellRun[] = [];
  // Stream ids only grow. A turn's end can be sent after the NEXT turn started
  // (Enter right as a turn finishes); without this, that late end marked the new
  // turn idle while it ran on. Ends from streams below `staleBelow` are old.
  private highestStreamId = 0;
  private staleBelow = 0;
  private shellProc: ChildProcess | null = null;
  private queue: QueuedMessage[] = [];
  /** Sub-agents running when the user stopped the turn. */
  private stoppedAgents = new WeakSet<Delegation>();
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
    // This surface saves a Plan-mode reply that is a plan (onTurnEnd), so Plan
    // mode's prompt says so (mode-prompt-bundle.ts). One surface per process.
    process.env.ATLARIX_INLINE_PLANS = "1";
    this.workspaceDir = opts.workspaceDir;
    this.model = opts.model;
    this.surface = opts.surface ?? "cli";
    this.idlePeerMessages = opts.idlePeerMessages ?? "start-turn";
    this.state = {
      cells: [],
      busy: false,
      userTurn: true,
      computerUse: false,
      phase: null,
      retrying: null,
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
      mcpSuggestions: [],
      following: null,
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
    // Finished automations in this folder, from any Atlarix: wake to act on them.
    this.startAutomationClaims();
    this.startFollowing();
    void this.refreshComputerUse();
  }

  /**
   * Re-reads the shared computer-use switch for `model` (default: the turn's
   * model) into `state.computerUse`; true when it is on.
   */
  async refreshComputerUse(model: ModelChoice | undefined = this.turnModel()): Promise<boolean> {
    let on = false;
    try {
      if (model) {
        // Whether a custom provider speaks Anthropic's format (so its Claude sees
        // screenshots) is known once the providers are loaded; the turn loads
        // them, and this ran first and said off (QA E8).
        await (await import("@/ipc/shared/language_model_helpers")).getLanguageModelProviders();
        on = (await import("@/lib/computer/lane")).computerLane(model) != null;
      }
    } catch {
      /* not knowable here: shown as off */
    }
    if (on !== this.state.computerUse) this.update({ computerUse: on });
    return on;
  }

  /**
   * A fresh session in this folder (`/new`), like Codex and Claude Code on start.
   * Only local state here: the session row is created by the FIRST message
   * (ensureSession), so opening the CLI and leaving does not add an empty
   * session to the desktop app's list.
   */
  async newSession(opts: { opening?: string } = {}): Promise<void> {
    clearAccountMcpServers();
    // The session left is not shown here any more, so it must not stay reachable
    // here: a message to it went to a chat nobody showed (QA A2, after /fork).
    // Not the one being opened, which /resume has just registered.
    const left = this.sessionId;
    if (left && left !== opts.opening) {
      void import("@/lib/peers/peers").then((m) => m.forgetLiveSession(left));
    }
    this.sessionId = "";
    this.chatId = 0;
    this.messages = [];
    this.shellRuns = [];
    this.wakeNotes.length = 0;
    this.queue = [];
    this.anchors.clear();
    this.seenUserIds.clear();
    this.persisted.clear();
    this.turnSnapshots.clear();
    this.delegations.clear();
    this.delegationCount.clear();
    this.lastStepTokens = 0;
    this.interrupted.clear();
    this.turnNotices.clear();
    this.lastTurnOwner = null;
    this.remoteSteers = [];
    this.followRevision = "";
    this.update({
      cells: [],
      approvals: [],
      pending: [],
      following: null,
      lastError: null,
      busy: false,
      userTurn: true,
      phase: null,
      retrying: null,
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

  /** Null when set; else why it waits (another surface is running the turn). */
  setMode(mode: WorkMode): string | null {
    const elsewhere = this.followingNote();
    if (elsewhere) return elsewhere;
    this.update({ mode });
    this.modeChosen = true;
    // A deliberate choice in this session, stamped on it as the desktop does,
    // so resuming it (here or in the app) comes back in the same mode. Before
    // the first message there is no row yet: ensureSession stamps it then.
    if (this.sessionId) {
      void handler("sessions:set-work-mode")
        .then((h) => h({}, this.sessionId, mode))
        .catch(() => {});
    }
    return null;
  }

  // ─── earlier sessions (/resume) ────────────────────────────────────────────

  /** This folder's sessions, newest first: the CLI's and the desktop app's. */
  async listSessions(): Promise<SessionSummary[]> {
    const rows = (await (await handler("sessions:list"))({}, this.appId)) as SessionSummary[];
    // Not chats opened and never used (an editor's New chat with no message): QA E6.
    return withoutUnusedChats(rows);
  }

  /**
   * Open an earlier session: its messages on screen, its transport filled so the
   * next turn continues it, its mode back. The desktop's own sequence
   * (allocate-transport → get → hydrate-transport).
   */
  async resume(sessionId: string): Promise<{ parent?: { id: string; title: string } }> {
    if (this.state.busy) throw new Error("Wait for this turn to finish (or esc to stop it), then resume.");
    clearAccountMcpServers();
    const { chatId } = (await (await handler("sessions:allocate-transport"))({}, sessionId)) as { chatId: number };
    const got = (await (await handler("sessions:get"))({}, sessionId)) as {
      session: SessionSummary;
      parent?: { id: string; title: string } | null;
      messages: SavedMessage[];
    };
    const rows = got.messages.map((m, i) => ({ id: i + 1, sessionRowId: m.id }));
    await (await handler("sessions:hydrate-transport"))({}, { chatId, sessionId, rows });
    await this.newSession({ opening: sessionId });
    this.sessionId = sessionId;
    this.chatId = chatId;
    void this.reportModel();
    // Reachable by its real id now (allocate-transport registered it).
    void import("@/lib/peers/peers").then((m) => m.forgetLiveSession(this.pendingPeerId()));
    this.applySaved(got.messages);
    this.startFollowing();
    const mode = got.session.workMode;
    const { getLatestPlanArtifact } = await import("@/lib/plans/plan-artifacts");
    const plan = await getLatestPlanArtifact(sessionId, "plan").catch(() => null);
    this.update({
      cells: this.cellsFor(false),
      title: got.session.title,
      ...(mode === "build" || mode === "ask" || mode === "plan" || mode === "debug" || mode === "review" ? { mode } : {}),
      planReady: plan ? { planId: plan.id, title: plan.title ?? "Plan" } : null,
    });
    if (!plan) await this.offerResumeBuild();
    // How full the context is, from the last reply's real token total, so an
    // opened chat shows its own figure before its first new turn (QA #30).
    const last = [...got.messages].reverse().find((m) => m.role === "assistant" && (m.maxTokensUsed ?? 0) > 0)?.maxTokensUsed;
    if (last) {
      await this.refreshContextWindow();
      if (this.contextWindow) {
        this.update({ contextUsed: last, contextLimit: this.contextWindow, contextPercent: Math.min(100, Math.round((last / this.contextWindow) * 100)) });
      }
    }
    return got.parent ? { parent: got.parent } : {};
  }

  /** The session's saved messages as this session's own: what resume and a follow show. */
  private applySaved(saved: SavedMessage[]): void {
    // modelContent: what the model was sent, when it differs from what you
    // typed (pastes expanded); the transcript shows the paste from it.
    this.messages = saved.map((m, i) => ({ id: i + 1, role: m.role, content: m.content, modelContent: m.modelContent ?? null }));
    this.seenUserIds.clear();
    this.persisted.clear();
    this.turnSnapshots.clear();
    this.interrupted.clear();
    for (const m of this.messages) {
      if (m.role === "user") this.seenUserIds.add(String(m.id));
      else this.persisted.add(String(m.id));
    }
    saved.forEach((m, i) => {
      if (m.snapshotTurnId) this.turnSnapshots.set(String(i + 1), m.snapshotTurnId);
    });
    // The turn being written elsewhere is saved as "interrupted" while it runs:
    // it is not, so it is not drawn as stopped.
    const live = this.state.following ? String(saved.length) : null;
    for (const id of interruptedRowIds(saved)) if (id !== live) this.interrupted.add(id);
  }

  // ─── following a turn another surface runs ─────────────────────────────────
  //
  // A session is live where its turn runs (lib/peers: runningElsewhere). While
  // another process runs one, this session re-reads it as the turn's draft
  // grows, sends what you type to that turn and stops it from here. When that
  // turn ends, one last read and the transport rebuilt from the database: the
  // next message runs here, with the whole conversation.

  private followTimer: ReturnType<typeof setInterval> | null = null;
  private followChecking = false;
  private followRevision = "";
  /** What you sent to the turn running elsewhere, shown until it appears there. */
  private remoteSteers: string[] = [];

  private startFollowing(): void {
    if (this.followTimer) return;
    this.followTimer = setInterval(() => void this.checkFollowing(), FOLLOW_POLL_MS);
    (this.followTimer as { unref?: () => void }).unref?.();
  }

  /** Exported for tests: one poll. */
  async checkFollowing(): Promise<void> {
    if (this.followChecking || this.state.busy || !this.sessionId) return;
    this.followChecking = true;
    try {
      const where = (await (await handler("sessions:running-elsewhere"))({}, this.sessionId)) as SessionState["following"];
      if (where) {
        if (this.state.following?.surface !== where.surface) this.update({ following: where });
        const rev = (await (await handler("sessions:revision"))({}, this.sessionId)) as string;
        if (rev !== this.followRevision) {
          this.followRevision = rev;
          await this.reload();
        }
      } else if (this.state.following) {
        await this.stopFollowing();
      }
    } catch {
      /* the next poll asks again */
    } finally {
      this.followChecking = false;
    }
  }

  /** Read the session again from the database: the read half of `resume`. */
  private async reload(): Promise<SavedMessage[]> {
    const got = (await (await handler("sessions:get"))({}, this.sessionId)) as { session: SessionSummary; messages: SavedMessage[] };
    this.applySaved(got.messages);
    const said = new Set(got.messages.filter((m) => m.role === "user").map((m) => m.content.trim()));
    this.remoteSteers = this.remoteSteers.filter((t) => !said.has(t));
    this.syncPending();
    this.update({ cells: this.cellsFor(false), title: got.session.title });
    return got.messages;
  }

  /** The other turn ended: read it once more, and carry on from the database here. */
  private async stopFollowing(): Promise<void> {
    this.update({ following: null });
    this.followRevision = "";
    const saved = await this.reload();
    const rows = saved.map((m, i) => ({ id: i + 1, sessionRowId: m.id }));
    await (await handler("sessions:hydrate-transport"))({}, { chatId: this.chatId, sessionId: this.sessionId, rows });
    this.remoteSteers = [];
    this.syncPending();
    // Held with Tab while it ran: it opens the next turn, here.
    const next = this.queue.shift();
    this.syncPending();
    if (next) await this.startTurn(next.text);
  }

  /** What /undo, /compact and a mode change say while another surface runs the turn. */
  followingNote(): string | null {
    const f = this.state.following;
    return f ? `Running in ${SURFACE_NAMES[f.surface]} — wait for it to finish.` : null;
  }

  /**
   * `/fork [name]`: carry on in a copy of this conversation as saved now, in a
   * new session in this folder. The original stays as it was. While another
   * surface runs a turn, the copy holds the turns that have finished.
   */
  async fork(title?: string): Promise<SessionSummary> {
    if (this.state.busy) throw new Error("Wait for this turn to finish (or esc to stop it), then fork.");
    if (!this.sessionId) throw new Error("Send a message first: there is nothing to fork yet.");
    const made = (await (await handler("sessions:fork"))({}, this.sessionId, title ? { title } : undefined)) as SessionSummary;
    await this.resume(made.id);
    return made;
  }

  /** `atlarix -c`: the newest session in this folder, if there is one. */
  async resumeLatest(): Promise<boolean> {
    // The list comes as trees; the newest chat worked in, not an automation's run.
    const [latest] = (await this.listSessions())
      .filter((s) => s.origin?.via !== "automation")
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    if (!latest) return false;
    await this.resume(latest.id);
    return true;
  }

  // ─── /undo: edit an earlier message and resend ─────────────────────────────

  /** Your messages in this session, newest first (what /undo and esc esc can go back to). */
  myMessages(): Array<{ id: number; text: string }> {
    return ownMessages(this.messages);
  }

  /** What going back to this message would discard: the replies' file snapshots and the files they touched. */
  async undoPreview(messageId: number): Promise<{ turnIds: string[]; filesChanged: string[]; createdFiles: string[]; kept: string[] }> {
    const { discardedTurnSnapshotIds } = await import("@/lib/chat/discarded-turn-snapshots");
    const snapshotById = new Map([...this.turnSnapshots].map(([k, v]) => [Number(k), v]));
    const turnIds = discardedTurnSnapshotIds(
      this.messages.map((m) => ({ id: Number(m.id), role: m.role })),
      messageId,
      snapshotById,
    );
    if (!turnIds.length) return { turnIds, filesChanged: [], createdFiles: [], kept: [] };
    const files = (await (await handler("snapshot:files-range"))({}, { chatId: this.chatId, turnIds }).catch(() => null)) as {
      filesChanged: string[];
      createdFiles: string[];
      kept?: string[];
    } | null;
    // `kept`: what restoring would leave alone, changed since (no writes).
    return { turnIds, filesChanged: files?.filesChanged ?? [], createdFiles: files?.createdFiles ?? [], kept: files?.kept ?? [] };
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
   * Put the files back as they were before this message's turn, and keep the
   * conversation as it is (Claude Code's code-only rewind, Cline's "Restore
   * Files"). The next turn is told, so the agent doesn't build on edits that
   * are gone.
   */
  async restoreFilesSince(messageId: number): Promise<{ restoredFiles: number; kept: string[] }> {
    if (this.state.busy) throw new Error("Wait for this turn to finish (or esc to stop it).");
    const { turnIds, filesChanged, createdFiles } = await this.undoPreview(messageId);
    if (!turnIds.length) return { restoredFiles: 0, kept: [] };
    const res = (await (await handler("revert:snapshot-range"))({}, { chatId: this.chatId, turnIds })) as {
      success: boolean;
      restoredFiles?: number;
      kept?: string[];
      error?: string;
    };
    if (!res.success) throw new Error(res.error ?? "Restoring the files failed; nothing was changed.");
    // A file changed after those turns was left alone (owner: no random
    // reverts); the agent hears only about what went back.
    const kept = res.kept ?? [];
    const files = [...new Set([...filesChanged, ...createdFiles])].filter((f) => !kept.includes(f));
    if (files.length) {
      this.restoredNote = `The user restored these files to how they were before an earlier message; your edits to them since are gone: ${files.join(", ")}. Read a file again before changing it.`;
    }
    return { restoredFiles: res.restoredFiles ?? files.length, kept };
  }

  /** Said to the agent with the next message after a files-only restore. */
  private restoredNote: string | null = null;

  /**
   * Replace an earlier message and carry on from there, as the app's edit does
   * (SimpleInlineChat.performEdit): everything after it leaves the conversation,
   * and with `restoreTurnIds` the files those turns changed go back first.
   */
  async resendEdited(messageId: number, text: string, restoreTurnIds: string[] | null): Promise<{ restoredFiles: number; kept: string[] }> {
    const elsewhere = this.followingNote();
    if (elsewhere) throw new Error(elsewhere);
    if (this.state.busy) throw new Error("Wait for this turn to finish (or esc to stop it).");
    let restoredFiles = 0;
    let keptFiles: string[] = [];
    if (restoreTurnIds?.length) {
      const res = (await (await handler("revert:snapshot-range"))({}, { chatId: this.chatId, turnIds: restoreTurnIds })) as {
        success: boolean;
        restoredFiles?: number;
        kept?: string[];
        error?: string;
      };
      if (!res.success) throw new Error(res.error ?? "Restoring the files failed; nothing was changed.");
      restoredFiles = res.restoredFiles ?? 0;
      keptFiles = res.kept ?? [];
    }
    // A row holding a teammate's message and your words: editing yours keeps
    // theirs (owner: undo never undoes a teammate's message).
    const before = this.messages.find((m) => Number(m.id) === messageId)?.content ?? "";
    const newContent = withTeammateMessages(before, text);
    // The title comes from the first message: a new first message is a new
    // title, as the app's edit does (SimpleInlineChat.performEdit). Asked
    // before the edit, while the order still says which message was first.
    const wasFirst = Number(this.messages.find((m) => m.role === "user")?.id) === messageId;
    await (await handler("chat:edit-message"))(this.event, { chatId: this.chatId, userMessageId: messageId, newContent });
    if (wasFirst) void this.retitleFromFirstMessage();
    const { getStreamTransport } = await import("@/lib/chat/stream-transport");
    const kept = (getStreamTransport(this.chatId)?.messages ?? []) as ChatMessageLike[];
    this.messages = kept.map((m) => ({ id: m.id, role: m.role, content: m.content, modelContent: m.modelContent ?? null }));
    const ids = new Set(this.messages.map((m) => String(m.id)));
    for (const id of [...this.turnSnapshots.keys()]) if (!ids.has(id)) this.turnSnapshots.delete(id);
    this.shellRuns = this.shellRuns.filter((r) => !r.afterMessageId || ids.has(r.afterMessageId));
    this.update({ cells: this.cellsFor(false), lastError: null, planReady: null, question: null });
    await this.startTurn("", { continueAfterQuestions: true });
    return { restoredFiles, kept: keptFiles };
  }

  // ─── /compact ──────────────────────────────────────────────────────────────

  /** Summarise the conversation so far, as the agent does when the context fills. */
  async compact(): Promise<{ ok: boolean; message: string }> {
    // Following first: a follower reads busy too, and its esc stops the OTHER surface's turn.
    const elsewhere = this.followingNote();
    if (elsewhere) return { ok: false, message: elsewhere };
    if (this.state.busy) return { ok: false, message: "Compacting waits for the turn to finish (esc stops it)." };
    if (!this.chatId || this.messages.length < 2) {
      return { ok: false, message: "Nothing to compact yet: the conversation is still short." };
    }
    const { forceCompactEphemeralChat } = await import("@/lib/tools/workspace");
    const { compactResultMessage } = await import("@/lib/context/compact-result-message");
    this.update({ busy: true, phase: "Compacting…", turnStartedAt: Date.now() });
    try {
      // Summarised by the model this session runs on, not the app's.
      const model = this.turnModel() ?? this.model;
      return compactResultMessage(
        await forceCompactEphemeralChat(this.chatId, model?.provider, {
          workspaceSessionId: this.sessionId || null,
          summarize: true,
          ...(model ? { model } : {}),
        }),
      );
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

  /**
   * A build that stopped (you pressed Esc, or it failed) with steps still to do:
   * offered again, so /build and the card's button pick it up. Without it the
   * plan sat "building" with no way on but typing "continue" (QA C4).
   */
  private async offerResumeBuild(): Promise<void> {
    if (!this.sessionId || this.state.planReady) return;
    const { getLatestPlanArtifact } = await import("@/lib/plans/plan-artifacts");
    const { parsePlanChecklist } = await import("@/lib/tasks/plan-checklist");
    const plan = await getLatestPlanArtifact(this.sessionId, "building").catch(() => null);
    if (!plan || !parsePlanChecklist(plan.content).some((s) => s.state !== "done")) return;
    this.update({ planReady: { planId: plan.id, title: plan.title ?? "Plan", resume: true } });
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
  /**
   * A yes given to the OLD Auto wording ("shared with OpenAI") is asked again
   * ONCE on free Auto, as the app's picker does: Auto now also runs on free
   * models through other providers. Recorded as asked when it opens, so it never
   * repeats; "Not now" keeps the OpenAI-only Auto that yes covered (QA 15.7.1 #6a).
   */
  async takeAutoConsentReask(): Promise<boolean> {
    const m = this.model;
    if (!m || m.provider !== "compass") return false;
    const { isCoreAutoTier, ATLARIX_AUTO_CONSENT_VERSION } = await import("@/ipc/shared/compass_constants");
    if (!isCoreAutoTier(m.name)) return false;
    const { readSettings, writeSettings } = await import("@/main/settings");
    const s = readSettings();
    const oldYes = !!s.atlarixAutoConsentAt && (s.atlarixAutoConsentVersion ?? 1) < ATLARIX_AUTO_CONSENT_VERSION;
    if (!oldYes || s.atlarixAutoConsentV2AskedAt) return false;
    writeSettings({ atlarixAutoConsentV2AskedAt: new Date().toISOString() } as never);
    return true;
  }

  /** "Not now" to free Auto's consent: the refusal is answered, so the next send asks again. */
  declineAutoConsent(): void {
    this.update({ lastError: null });
  }

  async acceptAutoConsent(): Promise<void> {
    const { writeSettings } = await import("@/main/settings");
    const { autoConsentAccepted } = await import("@/ipc/shared/compass_constants");
    writeSettings(autoConsentAccepted() as never);
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
    const { recentChangedFiles } = await import("@/lib/recap/changed-files");
    const filesChanged = this.sessionId
      ? await recentChangedFiles({ sessionId: this.sessionId, workspacePath: this.workspaceDir })
      : [];
    return generateRecap(conversationText(cells), { chatId: this.chatId, model: this.model, force: opts.force, filesChanged });
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
    void this.reportModel();
    void this.refreshComputerUse();
  }

  /** The model, as people see it, for other sessions' list_sessions (item 9). */
  private async reportModel(): Promise<void> {
    if (!this.sessionId || !this.model) return;
    const { provider, name } = this.model;
    const { loadModelOptions } = await import("./models");
    const label = (await loadModelOptions().catch(() => [])).find((o) => o.provider === provider && o.name === name)?.label;
    const { noteSessionModel } = await import("@/lib/peers/peers");
    noteSessionModel(this.sessionId, label ?? name);
  }

  /**
   * Another session set this one's mode and/or model: from the next turn (a
   * running turn keeps what it started with), with a line saying who. Main
   * already stored the mode on the session.
   */
  private applyPeerSettings(p: Record<string, unknown>): void {
    const mode = typeof p.mode === "string" ? (p.mode as WorkMode) : undefined;
    const model = p.model as { provider: string; name: string } | undefined;
    if (mode) {
      this.update({ mode });
      this.modeChosen = true;
    }
    if (model?.provider && model.name) this.setModel({ provider: model.provider, name: model.name });
    // Another session approved the plan (item 11): its build is starting, so the offer goes.
    if (p.plan === "approve") this.update({ planReady: null });
    const id = `${Date.now().toString(36)}${++interjectionSeq}`;
    this.wakeNotes.push({
      id,
      cellId: `peer-settings:${id}`,
      afterCellId: lastAnchorCell(this.state.cells),
      afterMessageId: this.messages.length ? String(this.messages.at(-1)!.id) : "",
      text: `◇ ${String(p.notice ?? "")}`,
    });
    this.update({ cells: this.cellsFor(this.state.busy) });
    this.emit("peer-settings", { mode, model, notice: String(p.notice ?? "") });
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
    if (this.state.following) {
      // To the turn running elsewhere, as your own mid-turn message there.
      const sent = (await (await handler("sessions:steer-remote"))({}, this.sessionId, text)) as { ok: boolean };
      if (sent.ok) {
        this.remoteSteers.push(text.trim());
        this.syncPending();
        return;
      }
      // That turn has ended (or cannot be reached): this one carries on, from
      // the database, and your message opens its next turn here.
      await this.stopFollowing();
      if (this.state.busy) return void (await this.steer(text));
    }
    await this.startTurn(text, opts);
  }

  /** Held until the running turn ends, then sent as the next turn. Editable until then. */
  queueNext(text: string): void {
    if (!this.state.busy && !this.state.following) {
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
    // Optimistic: draw "↳ steer" the moment Enter is pressed, then reconcile
    // with main's answer (a loaded Mac can take seconds; owner, 2026-10-31).
    this.steers = [...this.steers, { id, text: text.trim(), kind: "steer" }];
    this.syncPending();
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
    const remote = this.remoteSteers.map((text, i) => ({ id: `r${i}`, text, kind: "steer" as const }));
    this.update({ pending: [...this.steers, ...remote, ...this.queue] });
  }

  /**
   * An editor (ACP) needs the session's id up front, at `session/new`. It gets
   * one now, and the stored session is created under it at the first message,
   * like the CLI's: creating it here left an empty session (and a live-session
   * row) behind every New chat (QA, 2026-10-22). Throws when the user isn't
   * signed in, as before.
   */
  async open(id?: string): Promise<{ sessionId: string }> {
    const { requireAuthSession } = await import("@/lib/auth/require_auth_session");
    await requireAuthSession();
    this.reservedId ??= id ?? randomUUID();
    return { sessionId: this.reservedId };
  }

  /** The id `open()` gave the editor, until the session is created under it. */
  private reservedId: string | null = null;
  /** The mode was chosen here (setMode), not just the default: stored with the session. */
  private modeChosen = false;

  /** Stop hearing this process's broadcasts and leave the session list. */
  async close(): Promise<void> {
    await this.interrupt();
    if (this.automationPoll) clearInterval(this.automationPoll);
    this.automationPoll = null;
    if (this.followTimer) clearInterval(this.followTimer);
    this.followTimer = null;
    this.detachWindow?.();
    this.detachWindow = null;
    const peers = await import("@/lib/peers/peers");
    peers.forgetLiveSession(this.pendingPeerId());
    if (this.sessionId) peers.forgetLiveSession(this.sessionId);
    this.removeAllListeners();
  }

  private async ensureSession(lineage?: SessionLineage): Promise<void> {
    if (this.sessionId) return;
    // An editor thread claims its session: opened before any message, it must
    // not be handed to (or pruned by) the next session started in this folder.
    // Started by another session's message: it is that one's child.
    const opts = {
      ...(this.surface === "editor" ? { claim: true, ...(this.reservedId ? { id: this.reservedId } : {}) } : {}),
      ...(lineage ? { lineage } : {}),
    };
    const started = (await (await handler("sessions:start"))(
      {},
      this.appId,
      Object.keys(opts).length ? opts : undefined,
    )) as {
      sessionId: string;
      chatId: number;
    };
    this.sessionId = started.sessionId;
    this.chatId = started.chatId;
    this.reservedId = null;
    void this.reportModel();
    // A mode picked before the first message had no row to go on (QA E1).
    if (this.modeChosen) {
      await (await handler("sessions:set-work-mode"))({}, this.sessionId, this.state.mode).catch(() => {});
    }
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
      materialize: async (from) => {
        await this.ensureSession(
          from.sessionId && from.sessionId !== "unknown"
            ? { parentSessionId: from.sessionId, origin: { via: "peer", by: { sessionId: from.sessionId, name: from.name, surface: from.surface } } }
            : undefined,
        );
        return { sessionId: this.sessionId, chatId: this.chatId };
      },
    });
  }

  /**
   * Wake the agent for what background work reported. Not while busy (a running
   * turn picks results up at its next step), not after the user stopped the
   * turn, and one at a time.
   */
  async wakeForBackground(): Promise<void> {
    if (this.state.busy || this.userStopped || this.wakeInFlight) return;
    if (!(await this.backgroundToDeliver())) return;
    // Read what finished BEFORE the wake turn drains it.
    await this.noteWhatWoke();
    this.wakeInFlight = true;
    try {
      await this.startTurn("", { continueAfterQuestions: true, systemWake: true });
    } finally {
      this.wakeInFlight = false;
    }
  }

  /**
   * Whether a wake would have anything to deal with: a finished command or
   * sub-agent's result, a stalled job's advisory, an automation, a scheduled
   * wake. A sub-agent awaited inside the turn delivered its report there, and
   * its "finished" arriving just after the turn must not wake the agent for
   * nothing (observed: a whole turn spent saying "still nothing to do").
   */
  private async backgroundToDeliver(): Promise<boolean> {
    if (!this.chatId) return false;
    try {
      // A finished automation counts again (owner: it wakes the agent like a
      // finished command). What looped eleven times before (QA, build 2) was a
      // wake turn that never drained it; the turn now drains it, and a wake
      // that leaves its reason pending never wakes again (onTurnEnd).
      const { hasPendingBackgroundCommandResults, hasPendingStalledAdvisories } = await import("@/lib/agent/background-commands");
      const { hasPendingSubagentResults } = await import("@/lib/agents/subagent-results");
      const { hasPendingScheduledWakeupNudges } = await import("@/lib/agent/scheduled-wakeups");
      const { hasPendingAutomationResults } = await import("@/lib/agent/automation-results");
      const { hasPendingMcpConnectResults } = await import("@/lib/mcp/mcp-suggestions");
      return (
        // An MCP server it suggested, connected by the user.
        hasPendingMcpConnectResults(this.chatId) ||
        hasPendingBackgroundCommandResults(this.chatId) ||
        hasPendingSubagentResults(this.chatId) ||
        hasPendingStalledAdvisories(this.chatId) ||
        hasPendingScheduledWakeupNudges(this.chatId) ||
        // A finished automation this chat claimed (claimAutomationRuns): the
        // agent wakes to act on it (owner). The wake turn drains it, and a wake
        // that doesn't never wakes again.
        hasPendingAutomationResults(this.chatId)
      );
    } catch {
      return false;
    }
  }

  /** One line per finished piece of background work, before the wake turn it starts. */
  private async noteWhatWoke(): Promise<void> {
    if (!this.chatId) return;
    await (async () => {
      const { describePendingSubagentResults } = await import("@/lib/agents/subagent-results");
      const { describePendingBackgroundCommands } = await import("@/lib/agent/background-commands");
      const { describePendingAutomationResults } = await import("@/lib/agent/automation-results");
      const { describePendingMcpConnectResults } = await import("@/lib/mcp/mcp-suggestions");
      return [
        ...describePendingMcpConnectResults(this.chatId!),
        ...describePendingSubagentResults(this.chatId!),
        ...describePendingBackgroundCommands(this.chatId!),
        ...describePendingAutomationResults(this.chatId!),
      ];
    })()
      .then((lines) => {
        // Each finished piece once, however many reports mention it.
        const fresh = lines.filter((l) => !this.wakeNotes.some((n) => n.text === `◇ ${l}`));
        if (!fresh.length) return;
        const after = this.messages.length ? String(this.messages.at(-1)!.id) : "";
        const afterCellId = lastAnchorCell(this.state.cells);
        for (const text of fresh) this.wakeNotes.push({ id: `${Date.now().toString(36)}${++interjectionSeq}`, afterCellId, afterMessageId: after, text: `◇ ${text}` });
        this.update({ cells: this.cellsFor(this.state.busy) });
      })
      .catch(() => {});
  }

  /** The user stopped the last turn (esc); cleared by their next message. */
  private userStopped = false;
  /** A wake turn is starting, so a second report does not start another. */
  private wakeInFlight = false;

  private async startTurn(text: string, opts: TurnOptions = {}): Promise<void> {
    this.recapLine = null;
    if (!opts.systemWake) this.userStopped = false;
    this.turnWasWake = !!opts.systemWake;
    // The last turn's error stays under that turn, not gone with the banner
    // (QA: "Couldn't reach…" vanished on the next send).
    if (this.state.lastError && this.lastTurnOwner) this.addTurnNotice(this.lastTurnOwner, "error", this.state.lastError);
    this.lastTurnOwner = null;
    // The user's band and "Thinking…" show at once: ensureSession (which makes
    // the session row on a first message) must not delay them (owner, 2026-10-31).
    this.update({
      busy: true,
      userTurn: !opts.systemWake && !opts.peerTurn,
      phase: "Thinking…",
      retrying: null,
      turnStartedAt: Date.now(),
      tokensThisTurn: null,
      lastError: null,
    });
    try {
      await this.ensureSession();
    } catch (e) {
      // A new editor chat is stored at its first message, so a sign-in that
      // lapsed before it stops the turn HERE, short of the stream that reports
      // turns. Reported the same way: an auth error, not silence (QA A10).
      this.update({ busy: false, phase: null, turnStartedAt: null });
      if ((e as { code?: string }).code === "auth_required" || /ATLARIX_AUTH_REQUIRED|sign in/i.test((e as Error).message ?? "")) {
        const { trackTurnCompleted } = await import("@/main/lib/analytics");
        trackTurnCompleted({
          chatId: this.chatId,
          end: { outcome: "error", errorKind: "auth" },
          mode: this.state.mode,
          durationMs: 0,
          hadHistory: false,
          outputTokens: 0,
        });
      }
      throw e;
    }
    if (!opts.continueAfterQuestions) {
      const display = opts.display ?? text;
      if (!opts.retry) text = this.takeShellContext(text);
      if (this.restoredNote && !opts.retry) {
        // A files-only restore since the last turn: the agent hears it once.
        text = `<system-reminder>${this.restoredNote}</system-reminder>\n\n${text}`;
        this.restoredNote = null;
      }
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
    this.lastTurnStopped = false;
    // Loaded here, not at import: stream-state reads settings, which must not
    // load before the data location is chosen.
    if (!this.mainStopped) {
      void import("@/ipc/handlers/chat_stream/stream-state").then((m) => (this.mainStopped = m.isChatUserStopped));
    }
    this.steerTexts = [];
    this.steerTakenAt.clear();
    this.staleBelow = this.highestStreamId + 1;
    void this.refreshContextWindow();
    // The model this reply runs on, saved with it: the app labelled CLI replies
    // with whatever its own picker showed later (15.11.0, filming).
    this.turnRanOn = this.turnModel();
    if (!this.turnRanOn) {
      const { readSettings } = await import("@/main/settings");
      const m = readSettings().selectedModel as Partial<ModelChoice> | undefined;
      this.turnRanOn = m?.provider && m.name ? { provider: m.provider, name: m.name } : undefined;
    }
    // Said at the start of every turn it is on for, wherever it was switched on.
    if (await this.refreshComputerUse(this.turnRanOn)) {
      // A wake note's own id ("wake:…"): editors show those as a finished
      // step, and dropped this line under any other (QA E8).
      // Under the turn's own message, before its first step: it came after the
      // reply and its footer, too late to say how to stop (QA, ai-44).
      this.wakeNotes.push({
        id: `computer-use:${this.turnSeq}`,
        afterCellId: "",
        afterMessageId: "",
        underTurnFrom: this.messages.length,
        text: "◇ Computer use on. Move the mouse to stop it.",
      });
      this.update({ cells: this.cellsFor(true) });
    }
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
        ...(opts.systemWake ? { systemWake: true } : {}),
        workModeOverride: this.state.mode,
      });
    } catch (e) {
      this.update({ busy: false, phase: null, lastError: e instanceof Error ? e.message : String(e) });
    }
  }

  async refreshContextWindow(): Promise<void> {
    try {
      const { getContextWindow } = await import("@/ipc/utils/token_utils");
      const { readSettings } = await import("@/main/settings");
      const { contextWorkingWindowTokens } = await import(
        "@/lib/context/mid-loop-threshold"
      );
      const raw = await getContextWindow(this.turnModel() as never, this.chatId);
      // The context bar reports against the WORKING window (when compaction
      // fires), not the raw window — same rule as the desktop app.
      this.contextWindow = contextWorkingWindowTokens(
        raw,
        readSettings().contextWorkingWindow,
      );
    } catch {
      this.contextWindow = null;
    }
  }

  /** Re-read the context window after the working-window setting changed, and
   * re-measure the bar against it now (not just on the next turn). */
  async refreshContext(): Promise<void> {
    await this.refreshContextWindow();
    if (this.contextWindow && this.state.contextUsed != null) {
      this.update({
        contextLimit: this.contextWindow,
        contextPercent: Math.min(
          100,
          Math.round((this.state.contextUsed / this.contextWindow) * 100),
        ),
      });
    }
  }

  /**
   * What a stop means here, wherever it started: Esc, or main (computer use's
   * takeover, the app's stop shortcut), which arrives only as a userCancelled end.
   */
  private markStoppedByUser(): void {
    this.interruptRequested = true;
    // A job reporting in later must not restart what the user just stopped
    // (after a takeover: must not grab the screen again).
    this.userStopped = true;
    // Sub-agents this stop cuts off end as stopped, not failed (QA #44).
    for (const d of this.delegations.values()) if (d.status === "running") this.stoppedAgents.add(d);
    // Anything queued for after this turn would otherwise start right away.
    this.queue = [];
    this.syncPending();
    // Its cards come down: main withdraws them (endTurn), and an editor takes
    // back a card whose approval left this list (ACP $/cancel_request). They
    // stayed open after a stop, answerable into nothing (15.11.0, E7).
    if (this.state.approvals.length) this.update({ approvals: [] });
  }

  /** Esc: stop the running turn. The session stays; the next message starts a new turn. */
  async interrupt(): Promise<void> {
    if (this.state.following && !this.state.busy) {
      await (await handler("sessions:stop-remote"))({}, this.sessionId).catch(() => null);
      return;
    }
    if (!this.state.busy) return;
    this.markStoppedByUser();
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
  /** Lines kept under a turn: its error once the next turn starts, or a stop with no reply. */
  private readonly turnNotices = new Map<string, Array<{ level: "info" | "error"; text: string }>>();
  /** The message the last turn's lines belong under: its reply, else your message. */
  private lastTurnOwner: string | null = null;

  private addTurnNotice(owner: string, level: "info" | "error", text: string): void {
    this.turnNotices.set(owner, [...(this.turnNotices.get(owner) ?? []), { level, text }]);
  }

  private withFooters(cells: Cell[]): Cell[] {
    if (!this.turnFooters.size && !this.turnNotices.size) return cells;
    // After the reply's LAST line only. A message sent mid-turn sits inside the
    // reply, and a footer after each part made the turn look finished above it.
    const last = new Map<string, number>();
    cells.forEach((c, i) => last.set(c.id.split(":")[0]!, i));
    const out: Cell[] = [];
    cells.forEach((c, i) => {
      out.push(c);
      const owner = c.id.split(":")[0]!;
      if (last.get(owner) !== i) return;
      (this.turnNotices.get(owner) ?? []).forEach((n, k) => out.push({ kind: "notice", id: `${owner}:turn-notice${k}`, level: n.level, text: n.text }));
      const footer = this.turnFooters.get(owner);
      if (footer) {
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
    return this.placeWakeNotes(this.settleOldBackgroundAgents(
      withDelegations(
        placeShellRuns(
          markInterrupted(placeSteers(messages, this.anchors, { streaming }), this.interrupted),
          this.shellRuns,
        ),
        this.delegations.values(),
      ),
    ));
  }

  /**
   * A background sub-agent this session never saw run (a resumed session, or
   * one whose events were missed) has no live state to follow, and its call's
   * envelope says "running" forever. It did run; say so.
   */
  private settleOldBackgroundAgents(cells: Cell[]): Cell[] {
    const live = new Set([...this.delegations.values()].map((d) => `${d.assistantId}:t:task_${d.index}`));
    return cells.map((c) =>
      c.kind === "tool" && c.tool.status === "running" && c.tool.summary === "running in the background" && !live.has(c.id)
        ? { ...c, tool: { ...c.tool, status: "success", summary: "ran in the background" } }
        : c,
    );
  }

  /**
   * Why the agent spoke again on its own: "◇ Map src/mini finished · 72s", one
   * line per piece of background work that woke it, after the message it
   * finished behind. Without them a wake turn began with a bare step and you
   * could not tell what had happened (QA).
   */
  private readonly wakeNotes: WakeNote[] = [];

  private placeWakeNotes(cells: Cell[]): Cell[] {
    if (!this.wakeNotes.length) return cells;
    const notes: WakeNote[] = [];
    for (const n of this.wakeNotes) {
      if (n.underTurnFrom == null) {
        notes.push(n);
        continue;
      }
      const turn = this.messages.slice(n.underTurnFrom);
      const user = turn.find((m) => m.role === "user");
      if (user) notes.push({ ...n, afterCellId: `${String(user.id)}:u`, afterMessageId: String(user.id) });
      else if (turn.length && n.underTurnFrom > 0) {
        const before = String(this.messages[n.underTurnFrom - 1]!.id);
        notes.push({ ...n, afterCellId: "", afterMessageId: before });
      }
    }
    return placeWakeNotes(cells, notes);
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
      d.status = p.status === "error" ? (this.stoppedAgents.has(d) ? "interrupted" : "error") : "success";
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
    const { anchors, steerTexts } = collectAnchors({
      messages: this.messages,
      steerTexts: this.steerTexts,
      taken: this.steerTakenAt,
      seen: this.seenUserIds,
    });
    this.steerTexts = steerTexts;
    for (const [id, a] of anchors) this.anchors.set(id, a);
  }

  async answerApproval(
    operationId: string,
    approvalMode: "once" | "deny" | "always_allow" | "always_allow_file" | "always_allow_directory",
  ): Promise<void> {
    const answered = this.state.approvals.find((a) => a.operationId === operationId);
    const line = answered ? approvalConfirmation(answered, approvalMode) : null;
    // Under the line that asked: the tool call the turn is waiting on is the last one now.
    if (line) {
      this.wakeNotes.push({
        id: operationId,
        cellId: `approved:${operationId}`,
        afterCellId: askingToolCell(this.state.cells, firstPreview(answered!)) ?? lastAnchorCell(this.state.cells),
        afterMessageId: this.messages.length ? String(this.messages.at(-1)!.id) : "",
        text: line,
      });
    }
    this.update({
      approvals: this.state.approvals.filter((a) => a.operationId !== operationId),
      ...(line ? { cells: this.cellsFor(this.state.busy) } : {}),
    });
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
      // An operation decided without this card: a rule saved on another card
      // approved it (allow edits in src/), so the card is no longer a question.
      // Left on screen, it was answered again (owner, 2026-10-19).
      case "operation-status":
        if (p.status !== "pending" && p.status !== "queued") this.dropApproval(String(p.operationId ?? ""));
        return;
      // Another surface following this session pressed Stop: as Esc here.
      case "chat:remote-stop":
        void this.interrupt();
        return;
      // Another session set this one's mode and/or model (item 9).
      case "session:peer-settings":
        this.applyPeerSettings(p);
        return;
      case "chat:response:chunk": {
        if (this.state.retrying) this.update({ retrying: null });
        if (p.type === "permission-request") {
          this.addApproval(p);
          return;
        }
        if (Array.isArray(p.messages)) {
          // Copies: main runs in this process and keeps writing the live row it
          // sent. Shared, the row already held each patch's text when the patch
          // came, so the patch read as "no change": thinking and the answer
          // reached the screen and the editor only when the turn ended.
          this.messages = keepThoughts(this.messages, p.messages as ChatMessageLike[]);
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
          return;
        }
        // Background work reported in (a command or sub-agent finished, a quiet
        // one looks stuck, a scheduled wake fired): wake the agent to deal with
        // it, as the desktop does (useStreamChat). Only when idle, never after
        // the user stopped the turn, one at a time. A running turn picks results
        // up at its next step.
        // An editor starts its own turns (`idlePeerMessages: "hold"`), so there
        // it is told instead, and Atlarix's extension opens the wake turn.
        if (WAKE_STATUSES.has(String(p.status)) && (p.chatId == null || p.chatId === this.chatId)) {
          // Finished while a turn runs: the running turn takes the result at
          // its next step, so the line saying so goes in now (QA: the second
          // of two agents never got its "finished" line).
          if (this.state.busy) void this.noteWhatWoke();
          void this.backgroundToDeliver().then((yes) => {
            if (!yes) return;
            if (this.idlePeerMessages === "hold") this.emit("background-ready");
            else void this.wakeForBackground();
          });
        }
        this.emit("tasks-changed");
        return;
      case "chat:interjections":
        // Main's queue of steers changed: one was delivered, or added elsewhere.
        if (Array.isArray(p.pending)) {
          this.noteDelivered(p.pending as Array<{ id: string; text: string }>);
          this.syncPending(p.pending as Array<{ id: string; text: string }>);
        }
        return;
      case "chat:stream:phase":
        this.update({
          phase: typeof p.label === "string" ? p.label : null,
          // Shown in place of "Thinking…" until the next try gets anywhere (QA).
          retrying: p.retry === true && typeof p.label === "string" ? p.label : null,
        });
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
        else if (p.id === "revert-needs-git" && p.chatId === this.chatId && typeof p.label === "string") {
          // Once per run, under the message whose edit found no Git (QA 15.7.1 #3).
          if (!this.wakeNotes.some((n) => n.id === "revert-needs-git")) {
            const lastUser = [...this.messages].reverse().find((m) => m.role === "user");
            this.wakeNotes.push({ id: "revert-needs-git", afterCellId: "", afterMessageId: lastUser ? String(lastUser.id) : "", text: p.label });
            this.update({ cells: this.cellsFor(this.state.busy) });
          }
        }
        return;
      case "user-question-request": {
        const items = Array.isArray(p.questions) && p.questions.length
          ? (p.questions as PendingQuestion["items"])
          : [{ question: String(p.question ?? ""), options: p.options as string[] | undefined }];
        this.update({ question: { questionId: String(p.questionId ?? ""), items } });
        return;
      }
      case "mcp:suggestion": {
        if (p.chatId !== this.chatId) return;
        const sug = (p.suggestion ?? {}) as {
          id?: string;
          server?: string;
          title?: string;
          reason?: string;
          status?: unknown;
          entry?: { title?: string; verified?: boolean; publisher?: string; options?: Array<{ id: string; kind: string; supported?: boolean; inputs?: McpSuggestionCard["inputs"] }> } | null;
        };
        const id = String(sug.id ?? "");
        if (!id) return;
        const rest = (this.state.mcpSuggestions ?? []).filter((x) => x.id !== id);
        if (p.type !== "added") {
          this.update({ mcpSuggestions: rest });
          return;
        }
        const option = sug.entry?.options?.find((o) => o.kind === "web" || o.supported);
        this.update({
          mcpSuggestions: [
            ...rest,
            {
              id,
              server: String(sug.server ?? ""),
              title: String(sug.entry?.title ?? sug.title ?? sug.server ?? "MCP server"),
              reason: String(sug.reason ?? ""),
              verified: !!sug.entry?.verified,
              publisher: String(sug.entry?.publisher ?? ""),
              inputs: sug.status ? [] : (option?.inputs ?? []),
              ...(option ? { optionId: option.id } : {}),
            },
          ],
        });
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
        // Finished here: take it now rather than at the next poll.
        if (p.status && p.status !== "running") void this.claimAutomationRuns();
        return;
      case "chat:response:error":
        // A cancel reports itself as an error; it is not one. Main latches a
        // stop of its own (cancelChatStream) before that error can arrive, so
        // a takeover's error is not "The turn failed" either.
        if (this.interruptRequested) return;
        if (this.mainStopped?.(this.chatId)) {
          this.markStoppedByUser();
          return;
        }
        this.update({ lastError: String(p.error ?? p.message ?? "The turn failed.") });
        return;
      case "chat:stream:disconnected":
        // Retries to the provider ran out (it's down, or the address is wrong).
        // The desktop offers Reconnect; here the turn ends with the reason, or
        // it sat "working" forever (QA: an unreachable custom provider).
        if (this.interruptRequested) return;
        void (async () => {
          // By name, as other failures say it (QA): "Couldn't reach QA Dead Port".
          const { providerDisplayName } = await import("@/ipc/shared/language_model_helpers");
          const named = providerDisplayName(this.turnModel()?.provider);
          this.update({
            lastError: `Couldn't reach ${named ?? "the model provider"}${p.detail ? `: ${String(p.detail)}` : "."} Check it's running and the address is right, then try again.`,
          });
          await this.onTurnEnd();
        })();
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
        // A stop that started in main (computer use: the user took the mouse,
        // or the app's stop shortcut) arrives only as this end. It is the same
        // stop as Esc: main saved the partial reply, an editor must hear
        // "cancelled", and nothing may start the agent again by itself.
        if (p.userCancelled === true && !this.interruptRequested) this.markStoppedByUser();
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

  private dropApproval(operationId: string): void {
    if (!operationId || !this.state.approvals.some((a) => a.operationId === operationId)) return;
    this.update({ approvals: this.state.approvals.filter((a) => a.operationId !== operationId) });
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

  /**
   * The name stored for this session, as another process may have changed it
   * (a rename from the CLI or another editor). Shown, not written back. A
   * placeholder ("Untitled") never replaces a name.
   */
  noteStoredTitle(title: string | null | undefined): void {
    const t = title?.trim();
    if (!t || t === this.state.title || /^(untitled|new chat|new conversation)( session)?$/i.test(t)) return;
    this.update({ title: t });
  }

  async rename(title: string): Promise<void> {
    const name = title.trim();
    if (!name) throw new Error("Give the session a name: /rename <name>");
    if (!this.sessionId) throw new Error("Send a message first; then the session can be named.");
    await (await handler("sessions:rename"))({}, this.sessionId, name);
    this.update({ title: name });
  }

  /**
   * Title the session again from its (edited) first message. A title you typed
   * is kept: the handler refuses when `titleSource` is "user". The edit is
   * already saved (chat:edit-message), so the handler reads the new words.
   */
  private async retitleFromFirstMessage(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await (await handler("sessions:generate-title"))({}, this.sessionId);
    } catch {
      /* the title is a nicety */
    }
    await this.refreshTitle();
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

  /**
   * Retry naming the session while it has no real title. The title model call
   * can fail silently (a timeout, a provider refusing), and the first-message
   * path only tries once, so a session stayed "Untitled" for good and every row
   * in list_sessions looked alike (owner, 2026-10-31).
   */
  private async retryTitleIfUnnamed(): Promise<void> {
    if (!this.sessionId) return;
    await this.refreshTitle();
    const { isPlaceholderTitle } = await import("@/lib/session-title/title-text");
    if (this.state.title && !isPlaceholderTitle(this.state.title)) return;
    try {
      await (await handler("sessions:generate-title"))({}, this.sessionId);
    } catch {
      /* retried after the next turn */
    }
    await this.refreshTitle();
  }

  /** The last `chat:response:end` payload (what the reply is saved with). */
  private lastEnd: Record<string, unknown> = {};
  /** The stream whose end was handled (main repeats it). */
  private endedStreamId: number | null = null;
  /** Bumped by every turn that starts: an older turn's ending must not touch a newer turn. */
  private turnSeq = 0;
  private lastTurnStopped = false;
  /** Main's own stop latch (stream-state), loaded at the first turn. */
  private mainStopped: ((chatId: number) => boolean) | null = null;

  /**
   * The turn that just ended was stopped (here, or from another surface, which
   * lands as Esc). A stop before any output leaves no footer to say so, and an
   * editor ended that turn as a normal finish.
   */
  get turnWasStopped(): boolean {
    return this.lastTurnStopped;
  }
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
    const { buildDisplaySnapshotV1 } = await import("@/lib/chat/display-snapshot");
    const snapshot = this.turnRanOn ? buildDisplaySnapshotV1({ completedThread: [], model: this.turnRanOn }) : null;
    try {
      await (await handler("messages:add"))(
        {},
        this.sessionId,
        "assistant",
        content,
        snapshot ? JSON.stringify(snapshot) : undefined,
        Object.keys(extras).length ? extras : undefined,
      );
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
    // And a failed title call is retried after the turn, while it is unnamed.
    void this.retryTitleIfUnnamed();
    const touched = this.planTouched;
    this.planTouched = null;
    // Anything still listed as a steer either reached a step or is taken by the
    // flush below; either way it is no longer waiting on this turn.
    this.steers = [];
    const wasInterrupted = this.interruptRequested;
    this.interruptRequested = false;
    this.lastTurnStopped = wasInterrupted;
    // THIS turn's reply: after its message. The last assistant message in the
    // chat could be an earlier turn's, and a stop before any reply then marked
    // that one, or nothing at all (QA: no "Interrupted" line after a stop).
    const lastUserIdx = this.messages.map((m) => m.role).lastIndexOf("user");
    // …and one that shows something: a turn that failed or was stopped before
    // any output leaves an empty reply, and lines kept under it never drew.
    const shown = new Set(this.untimedCells(false).map((c) => c.id.split(":")[0]!));
    const lastReply = [...this.messages.slice(lastUserIdx + 1)]
      .reverse()
      .find((m) => m.role === "assistant" && shown.has(String(m.id)));
    const turnUser = !this.turnWasWake && lastUserIdx >= 0 ? String(this.messages[lastUserIdx]!.id) : null;
    if (wasInterrupted && lastReply) this.interrupted.add(String(lastReply.id));
    else if (wasInterrupted && turnUser) this.addTurnNotice(turnUser, "info", "Interrupted. Tell Atlarix what to do instead.");
    this.lastTurnOwner = lastReply ? String(lastReply.id) : turnUser;
    // Auto's top rung kept failing: offer Zenith once, under this turn.
    if (this.lastEnd.zenithOffer === true && this.lastTurnOwner) {
      this.lastEnd = { ...this.lastEnd, zenithOffer: false };
      const { ZENITH_OFFER_LINE } = await import("@/shared/billing_copy");
      this.addTurnNotice(this.lastTurnOwner, "info", `◇ ${ZENITH_OFFER_LINE.replace("Pick it in the model list", "/model Atlarix Zenith")}`);
    }
    if (lastReply && this.state.turnStartedAt) {
      const secs = Math.max(1, Math.round((Date.now() - this.state.turnStartedAt) / 1000));
      const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s` : `${secs}s`;
      const mode = { build: "Build", ask: "Explore", plan: "Plan", debug: "Debug", review: "Review" }[this.state.mode];
      this.turnFooters.set(String(lastReply.id), {
        // The model it ran on, named even when it's the default (QA, Windows:
        // "Build · 30s" for Atlarix Auto).
        text: [mode, await this.footerModelName(), took].filter(Boolean).join(" · "),
        interrupted: wasInterrupted,
      });
    }
    this.update({
      pending: [...this.queue],
      busy: false,
      phase: null,
      retrying: null,
      turnStartedAt: null,
      cells: this.cellsFor(false),
      lastError: wasInterrupted ? null : this.state.lastError,
    });
    if (touched && !wasInterrupted && this.state.mode === "plan" && !this.state.question) {
      const { getPlanArtifact } = await import("@/lib/plans/plan-artifacts");
      const plan = await getPlanArtifact(touched.planId).catch(() => null);
      if (plan?.planStatus === "plan") this.update({ planReady: touched });
    } else if (!touched && !wasInterrupted && this.state.mode === "plan" && !this.state.question && this.sessionId && lastReply) {
      // The plan was written in the reply, not saved with the plan tool: save
      // it, so it gets its card and Build it like any other (QA #43b).
      const { parseAssistantMessageParts } = await import("@/lib/chat/assistant-message-parts");
      const prose = parseAssistantMessageParts(lastReply.content, false)
        .filter((p) => p.type === "markdown")
        .map((p) => (p as { content: string }).content)
        .join("\n\n");
      const found = inlinePlan(prose);
      if (found) {
        const { createPlanArtifact } = await import("@/lib/plans/plan-artifacts");
        const row = await createPlanArtifact(this.sessionId, found.content, found.title).catch(() => null);
        if (row) this.update({ planReady: { planId: row.id, title: found.title } });
      }
    }
    if (wasInterrupted || this.state.lastError) await this.offerResumeBuild();
    if (wasInterrupted) {
      // A stopped turn opens nothing. What you typed into it that the agent never
      // got (no step came: a stop during a retry) goes back to your input box,
      // never away (QA: it was dropped; Claude Code puts it back).
      const flushed = (await Promise.resolve((await handler("chat:interject-flush"))({}, this.chatId)).catch(() => null)) as {
        text?: string | null;
      } | null;
      this.syncPending();
      // Everything typed into this turn that never showed up as a message: still
      // waiting, or taken by an attempt that failed before the stop.
      const back = this.steerTexts.filter(Boolean);
      this.steerTexts = [];
      const text = back.length ? back.join("\n") : flushed?.text?.trim();
      if (text) this.emit("unsent", text);
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
    if (next) return void (await this.startTurn(next));
    // Background work that finished during this turn's LAST step was too late to
    // go into it, and its "finished" event found the session busy, so nothing
    // would ever wake for it: the report sat undelivered and the row looked dead
    // (QA #50, reproduced: an agent done 0.3s before the turn ended).
    if (await this.backgroundToDeliver()) {
      // A wake turn that left its own reason undelivered must not wake again:
      // that loops, each turn starting with nothing but a mode reminder.
      if (this.turnWasWake) {
        void import("electron-log").then((m) => m.default.warn(`[wake] a wake turn ended with its results still pending; not waking again (chat ${this.chatId})`));
        return;
      }
      if (this.idlePeerMessages === "hold") this.emit("background-ready");
      else void this.wakeForBackground();
    }
  }

  private async footerModelName(): Promise<string | undefined> {
    let m = this.turnModel() as { provider?: string; name?: string } | undefined;
    if (!m) m = await import("@/main/settings").then((x) => x.readSettings().selectedModel as { provider?: string; name?: string }).catch(() => undefined);
    if (!m?.name) return undefined;
    if (m.provider !== "compass") return m.name;
    if (m.name === "core-auto" || m.name === "auto") return "Atlarix Auto";
    // A Core slot by its model's name, as the picker shows it, not its id ("core-4").
    const { getCompassSyntheticModels } = await import("@/ipc/shared/compass_constants");
    return getCompassSyntheticModels().find((x) => x.apiName === m!.name)?.displayName ?? m.name;
  }

  /**
   * Finished notify-the-agent automation runs in this folder that no chat has
   * taken, from any process (the app, the CLI, an editor): take them and, when
   * one is fresh, wake to act on it, as for a finished background command.
   * Polled while the session lives, and run at once when a run finishes here.
   */
  private async claimAutomationRuns(): Promise<void> {
    // Not an empty chat: there's no conversation for a wake to continue (and
    // the editor opens one on start that you may never use). A chat in use, here
    // or in another Atlarix, takes it; failing that, your first message does.
    if (this.claimingAutomations || !this.chatId || !this.messages.length) return;
    this.claimingAutomations = true;
    try {
      const { claimFinishedRuns } = await import("@/lib/automations/agent-delivery");
      const { PROCESS_OWNER } = await import("@/lib/automations/process-owner");
      const got = await claimFinishedRuns([this.appId], `${PROCESS_OWNER}:${this.sessionId ?? this.chatId}`);
      if (!got.some((g) => g.wake)) return;
      if (this.state.busy) return; // the running turn takes it at its next step, or wakes after it ends
      if (this.idlePeerMessages === "hold") this.emit("background-ready");
      else void this.wakeForBackground();
    } catch {
      // the next poll tries again
    } finally {
      this.claimingAutomations = false;
    }
  }

  private claimingAutomations = false;
  private automationPoll: ReturnType<typeof setInterval> | null = null;

  /** Start looking for finished automation runs to act on (every 15s while this session lives). */
  private startAutomationClaims(): void {
    if (this.automationPoll) return;
    this.automationPoll = setInterval(() => void this.claimAutomationRuns(), 15_000);
    (this.automationPoll as { unref?: () => void }).unref?.();
  }

  /** The turn running (or last run) was a wake for background work, not your message. */
  private turnWasWake = false;

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
    if (text && !this.state.busy) await this.startTurn(text, { peerTurn: true });
  }

  private update(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.emit("change", this.state);
  }
}

/**
 * `--provider-url` (testing against a local model, e.g. the fake one): seed
 * that endpoint as a custom provider, OpenAI-compatible unless
 * `--provider-format anthropic`. Only ever called with a scratch data folder
 * (src/cli/entry.mts), never the desktop's.
 */
/** The one id every dev endpoint shared before 15.11.1. */
const LEGACY_DEV_PROVIDER_ID = "atlarix-cli-dev";

/**
 * Each endpoint its own provider row (and so its own key). Every dev-mode
 * process shared one row in ~/.atlarix/dev-data, so a second one started on
 * another endpoint re-pointed it, and the first one's conversation went to the
 * second endpoint with the second's key (15.11.1, QA). The same endpoint
 * always gets the same row; the old shared row stays the row for the address
 * it holds, so what was saved against it (models, computer use) keeps working.
 */
async function devProviderId(
  db: ReturnType<typeof import("@/db").initializeDatabase>,
  schema: typeof import("@/db/schema"),
  baseUrl: string,
  apiFormat: "anthropic" | null,
): Promise<string> {
  const url = baseUrl.trim().replace(/\/+$/, "");
  const { eq } = await import("drizzle-orm");
  const legacy = db
    .select({ url: schema.language_model_providers.api_base_url, format: schema.language_model_providers.api_format })
    .from(schema.language_model_providers)
    .where(eq(schema.language_model_providers.id, LEGACY_DEV_PROVIDER_ID))
    .get();
  if (legacy && legacy.url.trim().replace(/\/+$/, "") === url && (legacy.format ?? null) === apiFormat) {
    return LEGACY_DEV_PROVIDER_ID;
  }
  const { createHash } = await import("node:crypto");
  return `${LEGACY_DEV_PROVIDER_ID}-${createHash("sha256").update(`${url}\0${apiFormat ?? "openai"}`).digest("hex").slice(0, 8)}`;
}

export async function seedDevProvider(opts: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  apiFormat?: "openai" | "anthropic";
}): Promise<ModelChoice> {
  const { initializeDatabase } = await import("@/db");
  const db = initializeDatabase();
  const schema = await import("@/db/schema");
  const id = await devProviderId(db, schema, opts.baseUrl, opts.apiFormat === "anthropic" ? "anthropic" : null);
  // The Anthropic format takes the key in one of two headers: ask the endpoint.
  let authHeader: "x-api-key" | "bearer" | null = null;
  if (opts.apiFormat === "anthropic") {
    const { detectAnthropicAuth } = await import("@/lib/provider-key-check");
    authHeader = (await detectAnthropicAuth(opts.baseUrl, opts.apiKey ?? "dev")).authHeader;
  }
  const wire = {
    api_format: opts.apiFormat === "anthropic" ? "anthropic" : null,
    auth_header: authHeader,
  };
  // Named by its address: with a row per endpoint, two of them listed the same
  // model twice under one name, in /model and in what sessions can set.
  let host = opts.baseUrl;
  try {
    host = new URL(opts.baseUrl).host;
  } catch {
    /* not a URL: shown as given */
  }
  const name = `Your endpoint (${host})`;
  db.insert(schema.language_model_providers)
    .values({ id, name, api_base_url: opts.baseUrl, ...wire })
    .onConflictDoUpdate({
      target: schema.language_model_providers.id,
      // The address is part of the row's identity (devProviderId): only how it
      // takes the key, and the name made from the address, can change.
      set: { name, auth_header: wire.auth_header },
    })
    .run();
  // No unique key to conflict on: onConflictDoNothing added the same row on
  // every start (QA saw 4 after 4).
  const { and, eq } = await import("drizzle-orm");
  const lm = schema.language_models;
  // Named as the catalog names it when it knows the model: replies were
  // labelled "us.anthropic.claude-haiku-4-5-20251001-v1:0" (15.11.1 QA).
  const { catalogModelName } = await import("@/lib/models_dev");
  const displayName = (await catalogModelName(opts.model)) ?? opts.model;
  const row = db
    .select({ id: lm.id, displayName: lm.displayName })
    .from(lm)
    .where(and(eq(lm.apiName, opts.model), eq(lm.customProviderId, id)))
    .get();
  if (!row) {
    db.insert(lm).values({ displayName, apiName: opts.model, customProviderId: id }).run();
  } else if (row.displayName === opts.model && displayName !== opts.model) {
    // Seeded before the catalog name was used: still its raw id.
    db.update(lm).set({ displayName }).where(eq(lm.id, row.id)).run();
  }
  const { writeSettings } = await import("@/main/settings");
  writeSettings({
    providerSettings: { [id]: { apiKey: { value: opts.apiKey ?? "dev" } } },
  } as never);
  // The key this endpoint was started with is the one it uses, from memory. The
  // stored copy can become unreadable here (the app re-saved a shared profile
  // with its keychain, 15.11.1 QA E9), and the turn then went to Atlarix Core.
  const { setPinnedProviderKey } = await import("@/ipc/shared/pinned-provider-key");
  setPinnedProviderKey(id, opts.apiKey ?? "dev", { ownKeyRun: false });
  return { provider: id, name: opts.model };
}
