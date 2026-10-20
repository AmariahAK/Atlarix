import { randomUUID } from "node:crypto";
import log from "electron-log";
import { db } from "../../db";
import {
  apps,
  chatSessions,
  sessionMessages,
  type SessionMessageKind,
} from "../../db/schema";
import { eq, desc, asc, sql, inArray, and } from "drizzle-orm";
import { createLoggedHandler } from "./safe_handle";
import {
  SESSION_LOAD_MESSAGE_LIMIT,
  SESSION_STORE_MESSAGE_MAX,
} from "@/constants/session_constants";
import { stripContentForTitleSource } from "../../utils/chat_naming";
import { deterministicTitle } from "@/lib/session-title/title-text";
import { generateSessionTitle } from "@/lib/session-title/generate-title";
import { broadcastToAllWindows } from "../utils/broadcast_all_windows";
import {
  parseDisplaySnapshot,
  type DisplaySnapshotV1,
} from "@/lib/chat/display-snapshot";
import type { PasteAttachmentMeta, StoredFileAttachment } from "../ipc_types";
import {
  attachmentInfoFromStoredFile,
  hydrateAttachmentStoreFromMessages,
} from "@/lib/attachment-persistence";
import {
  diagSpan,
  diagSpanSync,
  measureSessionPayloadBytes,
  sessionLoadDiagEnabled,
} from "@/lib/diag/session-load-diag";
import { requireAuthSession } from "@/lib/auth/require_auth_session";
import { noteSessionOpen } from "@/lib/peers/main-host";
import {
  forgetLiveSession,
  runningElsewhere,
  sessionsHeldElsewhere,
  steerElsewhere,
  stopElsewhere,
} from "@/lib/peers/peers";
import { isChatStreamLive, lastStreamRequest } from "./chat_stream/stream-state";
import { WorkModeSchema, type WorkMode } from "@/lib/schemas";
import {
  bindTransportToSession,
  createStreamTransport,
  deleteStreamTransport,
  getStreamTransport,
  getStreamTransportAppId,
  hydrateStreamTransport,
  isStreamTransportId,
  seedEphemeralChatCounterBelow,
  sessionForTransport,
  transportForSession,
} from "@/lib/chat/stream-transport";

const DEFAULT_SESSION_TITLES = new Set(["Untitled", "New session", "New chat"]);
const logger = log.scope("workspace_session_handlers");
const handle = createLoggedHandler(logger);

export type ChatSessionRow = {
  id: string;
  workspaceId: number;
  title: string;
  /** "auto" = generated and may be regenerated; "user" = typed, never touched. */
  titleSource: "auto" | "user";
  /**
   * The mode this session runs in, or `null` for a session written before the
   * column existed. `null` is not a default to be filled in on read — it means
   * "resolve from the global preference", which is what those sessions have
   * always done. See `chat_sessions.work_mode` in the schema.
   */
  workMode: WorkMode | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SessionMessageRow = {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  kind: SessionMessageKind;
  /**
   * "interrupted" = cut off mid-stream (partial content, "Continue" affordance).
   * "waiting" = v14.7 turn parked on a human wait (approval / `ask_user`) — not an error.
   */
  status: "complete" | "interrupted" | "waiting";
  createdAt: Date;
  displaySnapshot?: DisplaySnapshotV1 | null;
  modelContent?: string | null;
  pasteAttachments?: PasteAttachmentMeta[] | null;
  fileAttachments?: StoredFileAttachment[] | null;
  /** Shadow-git revert checkpoint id; lets revert-turn survive a restart. */
  snapshotTurnId?: string | null;
  /**
   * Provider's real total token usage for this assistant turn. The meter prefers
   * it over its own estimate; without it a restart halves the displayed context.
   */
  maxTokensUsed?: number | null;
};

export type SessionMessageExtras = {
  /**
   * Defaults to "message". `persistCompactionSummaryToSession` passes
   * "compaction_marker" so the durable summary row is identifiable by its
   * COLUMN rather than by its content — see `SessionMessageKind`.
   */
  kind?: SessionMessageKind;
  modelContent?: string | null;
  pasteAttachments?: PasteAttachmentMeta[] | null;
  fileAttachments?: StoredFileAttachment[] | null;
  snapshotTurnId?: string | null;
  /** Provider's real total token usage for this assistant turn (meter truth). */
  maxTokensUsed?: number | null;
};

function mapSession(row: typeof chatSessions.$inferSelect): ChatSessionRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    titleSource: (row.titleSource ?? "auto") as "auto" | "user",
    workMode: (row.workMode ?? null) as WorkMode | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapMessage(
  row: typeof sessionMessages.$inferSelect,
): SessionMessageRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as SessionMessageRow["role"],
    content: row.content,
    // No cast: `kind` is now the same union on both sides, so a value the type
    // does not cover is a compile error rather than something a cast waves
    // through. It was `as SessionMessageRow["kind"]`, which would have let a
    // third DB value past silently.
    kind: row.kind ?? "message",
    status: (row.status ?? "complete") as SessionMessageRow["status"],
    createdAt: row.createdAt,
    displaySnapshot: parseDisplaySnapshot(row.displaySnapshot),
    modelContent: row.modelContent ?? null,
    pasteAttachments: row.pasteAttachments ?? null,
    fileAttachments: row.fileAttachments ?? null,
    snapshotTurnId: row.snapshotTurnId ?? null,
    maxTokensUsed: row.maxTokensUsed ?? null,
  };
}

/**
 * Persist a user-message edit by DIRECT row id — every persisted message
 * carries `sessionRowId` (set at persist time, threaded through hydration;
 * since 0.4-C3 the ask_user Q→A insert carries it too). Updates the row's
 * content and deletes every row after it (chronological order). The old
 * ordinal mapping (and its 3.3 window-boundary failure class) was DELETED
 * in 0.4-C3 — this is the only edit-persistence path.
 */
export async function persistEditedSessionMessageById(
  sessionRowId: string,
  newContent: string,
  /**
   * W2 (v14.8.11): regenerated model-facing content for the edited row
   * (edited prose with attachment stubs re-expanded). Always written —
   * leaving the column untouched would keep the PRE-edit prose, which
   * dispatch prefers over `content`, silently undoing the user's edit for
   * the model after a reload. Null when the edited message has no model
   * variant.
   */
  newModelContent?: string | null,
): Promise<"updated" | "not_found"> {
  const target = await db.query.sessionMessages.findFirst({
    where: eq(sessionMessages.id, sessionRowId),
  });
  if (!target) return "not_found";

  const allRows = await db
    .select({ id: sessionMessages.id })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, target.sessionId))
    // `created_at` defaults to `unixepoch()` — WHOLE SECONDS — so any two rows
    // written in the same second tie, and a tie here decides which rows get
    // DELETED by the rewind below. The old tiebreak was `asc(id)`, and `id` is a
    // random UUID: deterministic, but unrelated to insertion order, so an
    // assistant reply written in the same second as the message being edited
    // could sort BEFORE it and survive the rewind — a stale answer left under an
    // edited question. SQLite's `rowid` is the actual insertion order.
    .orderBy(asc(sessionMessages.createdAt), sql`rowid asc`);
  const targetPos = allRows.findIndex((r) => r.id === sessionRowId);
  const deleteIds = allRows.slice(targetPos + 1).map((r) => r.id);

  await db
    .update(sessionMessages)
    .set({ content: newContent, modelContent: newModelContent ?? null })
    .where(eq(sessionMessages.id, sessionRowId));
  if (deleteIds.length > 0) {
    await db
      .delete(sessionMessages)
      .where(inArray(sessionMessages.id, deleteIds));
  }
  await db
    .update(chatSessions)
    .set({ updatedAt: new Date() })
    .where(eq(chatSessions.id, target.sessionId));
  return "updated";
}

/**
 * Which rows the trim may delete, oldest-first, given the whole ordered list.
 *
 * Exported for testing (same convention as `pickSessionReuse`), because the real
 * gate is `SESSION_STORE_MESSAGE_MAX = 100_000` — a test that seeded past it
 * would be measuring the DB, not the decision.
 *
 * NEVER TRIMS A COMPACTION MARKER. A marker is one of the oldest rows by
 * construction — it summarises everything before it — so oldest-first deletion
 * comes for it first, and losing it is silently expensive: the next reload finds
 * no marker, re-sends the entire history, and re-overflows the context the
 * marker exists to keep inside its budget. Markers are a handful of rows per
 * session, so exempting them cannot meaningfully defeat the cap.
 */
export function selectTrimmableMessageIds(
  rows: Array<{ id: string; kind?: string | null }>,
  max: number,
): string[] {
  if (rows.length <= max) return [];
  const excess = rows.length - max;
  return rows
    .filter((r) => r.kind !== "compaction_marker")
    .slice(0, excess)
    .map((r) => r.id);
}

async function trimSessionMessagesIfNeeded(sessionId: string): Promise<void> {
  const rows = await db
    .select({ id: sessionMessages.id, kind: sessionMessages.kind })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    // Same second-granularity tie as above, and here the order picks which rows
    // are DELETED as excess — an undefined tie can drop a newer message and keep
    // an older one. `rowid` is insertion order.
    .orderBy(asc(sessionMessages.createdAt), sql`rowid asc`);

  const idsToDelete = selectTrimmableMessageIds(
    rows,
    SESSION_STORE_MESSAGE_MAX,
  );
  if (idsToDelete.length > 0) {
    await db
      .delete(sessionMessages)
      .where(inArray(sessionMessages.id, idsToDelete));
  }
}

/**
 * Main-side session-message insert. The `messages:add` IPC handler delegates
 * here; background agents (v12 2.3) call it directly because there is no
 * renderer to fire `messages:add` on `chat:response:end`.
 */
export async function addSessionMessageDirect(
  sessionId: string,
  role: "user" | "assistant" | "tool",
  content: string,
  displaySnapshot?: string,
  extras?: SessionMessageExtras,
): Promise<SessionMessageRow> {
  if (!["user", "assistant", "tool"].includes(role)) {
    throw new Error(`Invalid message role: ${role}`);
  }
  if (displaySnapshot != null && !parseDisplaySnapshot(displaySnapshot)) {
    throw new Error("Invalid display snapshot payload");
  }
  const now = new Date();
  const id = randomUUID();
  const [message] = await db
    .insert(sessionMessages)
    .values({
      id,
      sessionId,
      role,
      content,
      displaySnapshot: displaySnapshot ?? null,
      modelContent: extras?.modelContent ?? null,
      pasteAttachments: extras?.pasteAttachments ?? null,
      fileAttachments: extras?.fileAttachments ?? null,
      snapshotTurnId: extras?.snapshotTurnId ?? null,
      maxTokensUsed: extras?.maxTokensUsed ?? null,
      createdAt: now,
    })
    .returning();
  await db
    .update(chatSessions)
    .set({ updatedAt: now })
    .where(eq(chatSessions.id, sessionId));
  await trimSessionMessagesIfNeeded(sessionId);
  return mapMessage(message);
}

/**
 * Crash-safe partial-output persistence. While an assistant turn streams, the
 * main process upserts the accumulated text into a single "interrupted" row per
 * stream (see `partialDraftRowByChatId` in chat_stream_handlers). If the app is
 * killed / suspended / the stream is aborted, that row survives and the session
 * renders it with a Continue affordance. On clean completion the draft is
 * deleted — the renderer persists the authoritative finished message instead.
 */
export async function upsertInterruptedAssistantDraft(
  existingRowId: string | null,
  sessionId: string,
  content: string,
  /** A stopped turn's finished steps, so a reopened chat still has them. */
  modelContent?: string,
): Promise<string> {
  const now = new Date();
  if (existingRowId) {
    await db
      .update(sessionMessages)
      .set({ content, status: "interrupted", ...(modelContent ? { modelContent } : {}) })
      .where(eq(sessionMessages.id, existingRowId));
    await db
      .update(chatSessions)
      .set({ updatedAt: now })
      .where(eq(chatSessions.id, sessionId));
    return existingRowId;
  }
  const id = randomUUID();
  await db.insert(sessionMessages).values({
    id,
    sessionId,
    role: "assistant",
    content,
    status: "interrupted",
    ...(modelContent ? { modelContent } : {}),
    createdAt: now,
  });
  await db
    .update(chatSessions)
    .set({ updatedAt: now })
    .where(eq(chatSessions.id, sessionId));
  await trimSessionMessagesIfNeeded(sessionId);
  return id;
}

/** Remove an interrupted draft row once the turn completes (or is superseded). */
export async function deleteInterruptedAssistantDraft(
  rowId: string,
): Promise<void> {
  await db.delete(sessionMessages).where(eq(sessionMessages.id, rowId));
}

/** Promote an interrupted row to a normal history message (used by "Continue"). */
export async function markSessionMessageComplete(rowId: string): Promise<void> {
  await db
    .update(sessionMessages)
    .set({ status: "complete" })
    .where(eq(sessionMessages.id, rowId));
}

/**
 * v14.7: mark an assistant row as PARKED on a human wait (pending approval /
 * `ask_user`) — distinct from "interrupted" so reopen renders the wait/question
 * affordance, not the error/Continue UI.
 */
export async function markSessionMessageWaiting(rowId: string): Promise<void> {
  await db
    .update(sessionMessages)
    .set({ status: "waiting" })
    .where(eq(sessionMessages.id, rowId));
}

export async function persistWorkspaceSessionUserMessage(
  sessionId: string,
  content: string,
  extras?: SessionMessageExtras,
): Promise<SessionMessageRow> {
  const now = new Date();
  const id = randomUUID();
  const [message] = await db
    .insert(sessionMessages)
    .values({
      id,
      sessionId,
      role: "user",
      content,
      kind: extras?.kind ?? "message",
      modelContent: extras?.modelContent ?? null,
      pasteAttachments: extras?.pasteAttachments ?? null,
      fileAttachments: extras?.fileAttachments ?? null,
      createdAt: now,
    })
    .returning();
  await db
    .update(chatSessions)
    .set({ updatedAt: now })
    .where(eq(chatSessions.id, sessionId));
  await trimSessionMessagesIfNeeded(sessionId);
  return mapMessage(message);
}

/**
 * Resolve workspace session id for an ephemeral transport chat.
 * Uses DB stream_chat_id, then binds an unmapped transport to the latest session for the workspace.
 */
export async function resolveOrBindWorkspaceSessionForStream(input: {
  workspaceSessionId?: string | null;
  chatId: number;
  workspaceAppId?: number | null;
}): Promise<string> {
  const provided = input.workspaceSessionId?.trim();
  if (provided) return provided;

  // The session this process's transport last ran a turn of, before the shared
  // column. A transport id is this PROCESS's (every process counts from -1), and
  // `stream_chat_id` is overwritten by whichever process opened the session
  // last: once another surface opened it to follow a turn running here, the
  // lookup below found nothing for this process's id, and a message typed
  // mid-turn (or a plan, or a compaction marker) went to no session (live
  // sessions, 2026-10-20).
  const running = lastStreamRequest.get(input.chatId)?.workspaceSessionId?.trim();
  if (running) return running;

  if (!isStreamTransportId(input.chatId)) {
    throw new Error(
      "workspaceSessionId is required for workspace chat streams",
    );
  }

  // The session THIS process bound the transport to; the shared column cannot
  // say (another process's transport may carry the same number).
  const bound = sessionForTransport(input.chatId);
  if (bound) return bound;

  const appId = input.workspaceAppId ?? getStreamTransportAppId(input.chatId);
  if (appId == null || !getStreamTransport(input.chatId)) {
    throw new Error(
      "workspaceSessionId is required for workspace chat streams",
    );
  }

  const latest = await db.query.chatSessions.findFirst({
    where: eq(chatSessions.workspaceId, appId),
    orderBy: [desc(chatSessions.updatedAt)],
  });

  // Not one this process has a transport for, nor one another process holds.
  if (latest && transportForSession(latest.id) == null && !sessionsHeldElsewhere().has(latest.id)) {
    await persistSessionStreamChatId(latest.id, input.chatId);
    logger.warn(
      `Bound transport chat ${input.chatId} to session ${latest.id} (workspace ${appId})`,
    );
    return latest.id;
  }

  const session = await insertWorkspaceSession(appId);
  await persistSessionStreamChatId(session.id, input.chatId);
  logger.info(
    `Created session ${session.id} for transport chat ${input.chatId} (workspace ${appId})`,
  );
  return session.id;
}

/** Create session row + ephemeral transport (shared by IPC and import). */
/**
 * Pure reuse/prune decision for workspace open / New chat (v10.1):
 * given the workspace's sessions (most-recent first) with message counts,
 * pick the newest default-titled EMPTY session to reuse and mark the other
 * empties for deletion. Sessions with messages or custom titles are never
 * touched. Extracted for unit testing.
 */
/** One transport message, joined from a DB row plus the renderer's numeric id. */
export type TransportRowRef = { id: number; sessionRowId?: string | null };

/**
 * Join the renderer's ordered `{id, sessionRowId}` refs against main's own message
 * rows — the whole point of `sessions:hydrate-transport`.
 *
 * ORDER comes from `refs`, never from the row array: the refs are what the renderer
 * actually rendered, and a transport in a different order than the screen would
 * mis-target edits and reverts (both key on the numeric id's position).
 *
 * A ref with no matching row is DROPPED rather than hydrated as an empty message. A
 * blank message in the transport would be sent to the model as real history.
 *
 * Exported for testing (same convention as `pickSessionReuse`) so the join contract
 * is pinned without standing up a database.
 */
export function joinTransportRows(
  rows: SessionMessageRow[],
  refs: TransportRowRef[],
): {
  id: number;
  sessionRowId: string;
  role: SessionMessageRow["role"];
  content: string;
  /**
   * Carried so the dispatch slice can recognise a compaction marker by its
   * COLUMN. Dropping a field here is the same mistake `maxTokensUsed` records
   * below — the row knows, and everything downstream stops knowing.
   */
  kind: SessionMessageKind;
  displaySnapshot: DisplaySnapshotV1 | null;
  modelContent: string | null;
  pasteAttachments: PasteAttachmentMeta[] | null;
  fileAttachments: StoredFileAttachment[] | null;
  attachments: ReturnType<typeof attachmentInfoFromStoredFile>[] | null;
  maxTokensUsed: number | null;
}[] {
  const byRowId = new Map(rows.map((r) => [r.id, r]));
  return refs.flatMap((ref) => {
    const row = ref.sessionRowId ? byRowId.get(ref.sessionRowId) : undefined;
    if (!row) return [];
    return [
      {
        id: ref.id,
        sessionRowId: row.id,
        role: row.role,
        content: row.content ?? "",
        kind: row.kind ?? "message",
        displaySnapshot: row.displaySnapshot ?? null,
        modelContent: row.modelContent ?? null,
        pasteAttachments: row.pasteAttachments ?? null,
        fileAttachments: row.fileAttachments ?? null,
        attachments:
          row.fileAttachments?.map(attachmentInfoFromStoredFile) ?? null,
        // The provider's real token total. Dropping it downgrades the context
        // meter to a client estimate that reads about half — the exact regression
        // the old renderer round trip carried a comment about.
        maxTokensUsed: row.maxTokensUsed ?? null,
      },
    ];
  });
}

export function pickSessionReuse(
  rows: { id: string; title: string; messageCount: number }[],
): { reuseId: string | null; pruneIds: string[] } {
  const empties = rows.filter(
    (r) => Number(r.messageCount) === 0 && DEFAULT_SESSION_TITLES.has(r.title),
  );
  if (empties.length === 0) return { reuseId: null, pruneIds: [] };
  return {
    reuseId: empties[0].id,
    pruneIds: empties.slice(1).map((r) => r.id),
  };
}

/**
 * Sessions for this workspace (most recent first) with their message counts.
 *
 * THIS QUERY RETURNED 0 FOR EVERY SESSION. It was a `sql` template correlated
 * subquery, and drizzle rendered both sides of its WHERE unqualified:
 *
 *   select count(*) from "session_messages" where "session_id" = "id"
 *
 * Inside that subquery BOTH names resolve against `session_messages`, which has
 * its own `id` column — so it compared each message's `session_id` to that same
 * message's `id`. Those never match. The subquery was never correlated with the
 * outer row at all, and the count was structurally always zero.
 *
 * What that cost: `pickSessionReuse` treats `messageCount === 0` plus a default
 * title as "safe to reuse or DELETE", so every default-titled session looked
 * empty. A workspace with two or more "Untitled" sessions holding real
 * conversations had all but the newest passed to `delete(chatSessions)`, which
 * cascades to `session_messages`. Only the title check limited the blast radius.
 * Observed 2026-08-31 as a session that came back blank; the caller's re-verify
 * guard is what caught it, and that guard stays regardless of this fix.
 *
 * A LEFT JOIN with GROUP BY instead of a raw template: in a join drizzle
 * qualifies the columns itself, so the bug is not expressible.
 */
async function listSessionsWithMessageCounts(
  workspaceId: number,
): Promise<{ id: string; title: string; messageCount: number }[]> {
  return db
    .select({
      id: chatSessions.id,
      title: chatSessions.title,
      messageCount: sql<number>`count(${sessionMessages.id})`,
    })
    .from(chatSessions)
    .leftJoin(sessionMessages, eq(sessionMessages.sessionId, chatSessions.id))
    .where(eq(chatSessions.workspaceId, workspaceId))
    .groupBy(chatSessions.id)
    .orderBy(desc(chatSessions.updatedAt));
}

/**
 * Startup: seed the ephemeral transport counter below the most-negative
 * persisted `streamChatId` so newly created transports can never collide with a
 * persisted session's id (which would make `allocateSessionTransport` reuse one
 * live transport for two sessions — the cross-session pending-question leak).
 * Best-effort; safe to call before any transport is created.
 */
export async function seedEphemeralCounterFromSessions(): Promise<void> {
  try {
    const [row] = await db
      .select({ min: sql<number | null>`min(${chatSessions.streamChatId})` })
      .from(chatSessions);
    const min = row?.min;
    if (typeof min === "number" && min < 0) {
      seedEphemeralChatCounterBelow(min);
    }
  } catch (e) {
    logger.warn("seedEphemeralCounterFromSessions failed (non-fatal)", e);
  }
}

/**
 * Is this session REALLY safe to reuse or delete? Read the row itself, not an
 * aggregate computed alongside forty others.
 *
 * Two conditions, and THEY ARE NOT SYMMETRIC — `purpose` decides which apply:
 *
 *  · `count(*)` for this one id — closes any staleness between
 *    `listSessionsWithMessageCounts` and the decision. Applies to BOTH, and it is
 *    the authoritative one now that the aggregate's uncorrelated-subquery bug is
 *    fixed.
 *  · `updatedAt === createdAt` — belt-and-braces for a session whose rows are
 *    somehow invisible to the count. Applies to PRUNE ONLY.
 *
 * The asymmetry is the whole correction. Prune runs `delete(chatSessions)`, which
 * cascades: a false accept destroys a conversation, so a timestamp that merely
 * *hints* at content is worth refusing on. Reuse is non-destructive — the worst a
 * false accept does is hand back an empty row someone had also touched — while a
 * false REFUSAL costs a new "Untitled" on every single start, forever, because
 * nothing ever un-drifts a timestamp.
 *
 * Applying it to both is what shipped in v14.38.4's fix, and it turned one bug
 * into another: see `persistSessionStreamChatId` for the bookkeeping write that
 * guaranteed the drift.
 */
async function verifyTrulyEmptySession(
  sessionId: string,
  purpose: "reuse" | "prune",
): Promise<{
  row: typeof chatSessions.$inferSelect | undefined;
  empty: boolean;
  reason: string;
}> {
  const [row] = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  if (!row) return { row: undefined, empty: false, reason: "row is gone" };

  const [counted] = await db
    .select({ n: sql<number>`count(*)` })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId));
  const messageCount = Number(counted?.n ?? 0);
  if (messageCount > 0) {
    return {
      row,
      empty: false,
      reason: `re-count found ${messageCount} message(s)`,
    };
  }

  if (purpose === "prune") {
    const created = row.createdAt?.getTime?.() ?? 0;
    const updated = row.updatedAt?.getTime?.() ?? 0;
    if (updated !== created) {
      return {
        row,
        empty: false,
        reason: `updatedAt (${new Date(updated).toISOString()}) !== createdAt (${new Date(created).toISOString()}) — the session has been written to`,
      };
    }
  }

  if (!DEFAULT_SESSION_TITLES.has(row.title)) {
    return {
      row,
      empty: false,
      reason: `title "${row.title}" is not a default`,
    };
  }

  return { row, empty: true, reason: "empty" };
}

/** Sessions this process's editor threads (ACP) hold; never reused or pruned. */
const claimedSessions = new Set<string>();

export async function startWorkspaceSession(
  workspaceId: number,
  opts: { claim?: boolean } = {},
): Promise<{
  sessionId: string;
  chatId: number;
  session: ChatSessionRow;
}> {
  // v10.1 fix: every app reopen created a fresh "Untitled" session, cluttering
  // the sidebar with empties. Reuse the most recent session when it's still
  // default-titled with zero messages, and prune any other stale empties.
  //
  // v14.39.1: every candidate is RE-VERIFIED against the row itself before it is
  // reused or deleted. Observed 2026-08-31: a session holding a 60-char user
  // message and a 76,003-char completed assistant turn was logged as
  // "Reusing empty session" on the next launch, handed to a fresh transport, and
  // rendered as an empty pane.
  //
  // The cause is now known and fixed — `listSessionsWithMessageCounts` returned 0
  // for every session, always (see that function). The guard STAYS anyway, and not
  // out of superstition: the failure mode of trusting that count is
  // `delete(chatSessions)` cascading to a real conversation. A count is cheap to
  // get wrong and expensive to be wrong about, so it is checked twice — and the
  // guard is what surfaced the bug in the first place, by logging what the
  // decision actually saw.
  let session: ChatSessionRow | null = null;
  try {
    // An empty session someone has OPEN is not stale: an editor thread holds
    // its session before the first message, and reusing it would put two
    // threads on one session, pruning it would delete it under them.
    const held = sessionsHeldElsewhere();
    const rows = (await listSessionsWithMessageCounts(workspaceId)).filter(
      (r) => !held.has(r.id) && !claimedSessions.has(r.id),
    );
    const { reuseId, pruneIds } = pickSessionReuse(rows);
    if (rows.length > 0) {
      // The decision's inputs, so a recurrence explains itself instead of needing
      // DB forensics after the fact.
      logger.log(
        `[session-reuse] workspace ${workspaceId} candidates: ` +
          rows
            .map(
              (r) =>
                `${r.id.slice(0, 8)}(msgs=${String(r.messageCount)},"${r.title}")`,
            )
            .join(" ") +
          ` → reuse=${reuseId ? reuseId.slice(0, 8) : "none"} prune=[${pruneIds
            .map((p) => p.slice(0, 8))
            .join(",")}]`,
      );
    }
    if (reuseId) {
      const verified = await verifyTrulyEmptySession(reuseId, "reuse");
      if (verified.row && verified.empty) {
        session = mapSession(verified.row);
        logger.log(
          `Reusing empty session ${session.id} for workspace ${workspaceId}`,
        );
      } else if (verified.row) {
        logger.warn(
          `[session-reuse] REFUSED reuse of ${reuseId}: ${verified.reason}. ` +
            `A new session is created instead. The aggregate said empty and the row disagrees — ` +
            `if you are seeing this, the count query is the thing to investigate.`,
        );
      }
    }
    // Verify each prune target independently. One that turns out non-empty is
    // skipped, not deleted — better a stale sidebar row than a deleted conversation.
    const safeToPrune: string[] = [];
    for (const id of pruneIds) {
      const verified = await verifyTrulyEmptySession(id, "prune");
      if (verified.row && verified.empty) safeToPrune.push(id);
      else if (verified.row) {
        logger.warn(
          `[session-reuse] REFUSED prune of ${id}: ${verified.reason}. Kept.`,
        );
      }
    }
    if (safeToPrune.length > 0) {
      await db
        .delete(chatSessions)
        .where(inArray(chatSessions.id, safeToPrune));
      logger.log(
        `Pruned ${safeToPrune.length} stale empty session(s) for workspace ${workspaceId}`,
      );
    }
  } catch (e) {
    logger.warn("Empty-session reuse check failed; creating a new session:", e);
  }

  if (!session) {
    session = await insertWorkspaceSession(workspaceId);
  }
  if (opts.claim) claimedSessions.add(session.id);
  const chatId = createStreamTransport(workspaceId);
  await persistSessionStreamChatId(session.id, chatId);
  return { sessionId: session.id, chatId, session };
}

async function insertWorkspaceSession(
  workspaceId: number,
): Promise<ChatSessionRow> {
  const now = new Date();
  const id = randomUUID();
  const [row] = await db
    .insert(chatSessions)
    .values({
      id,
      workspaceId,
      title: "Untitled",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return mapSession(row);
}

/**
 * Bind in-memory stream transport to a persisted session (optional column).
 *
 * DOES NOT TOUCH `updatedAt`, and that is the point. Which transport a session is
 * attached to is bookkeeping about the UI, not something that happened in the
 * conversation — the row is byte-identical to a user reading the sidebar.
 *
 * It used to bump it, and that quietly broke empty-session reuse for good.
 * `startWorkspaceSession` binds on EVERY start, including to the empty session it
 * has just decided to reuse, so one reuse left `updatedAt !== createdAt` forever
 * after; `verifyTrulyEmptySession` then refused that row and every start minted
 * another "Untitled" that could never be reused or pruned either. Observed
 * 2026-09-01: session cdf6f368, zero messages, 11,783 seconds of drift.
 */
async function persistSessionStreamChatId(
  sessionId: string,
  chatId: number,
): Promise<void> {
  bindTransportToSession(chatId, sessionId);
  await db
    .update(chatSessions)
    .set({ streamChatId: chatId })
    .where(eq(chatSessions.id, sessionId));
}

/**
 * Delete a session row (messages cascade) and the in-memory transport state
 * bound to it. v12 (TODO 2.4): the DB delete alone leaked the ephemeral chat,
 * partial responses, last stream request and ask_user state.
 */
async function deleteSessionAndTransport(sessionId: string): Promise<number | null> {
  // This process's transport for it, never the stored id: that may be another
  // process's number, and the same number here is some other session's chat.
  const streamChatId = transportForSession(sessionId) ?? null;
  await db.delete(chatSessions).where(eq(chatSessions.id, sessionId));
  forgetLiveSession(sessionId);
  if (streamChatId != null && isStreamTransportId(streamChatId)) {
    deleteStreamTransport(streamChatId);
    const { clearChatStreamStateForChat } = await import(
      "./chat_stream_handlers"
    );
    clearChatStreamStateForChat(streamChatId);
  }
  return streamChatId;
}

/** See the `sessions:prune-if-empty` handler. Exported for the eval. */
export async function pruneSessionIfEmpty(
  sessionId: string,
): Promise<{ pruned: boolean; streamChatId: number | null }> {
  const check = await verifyTrulyEmptySession(sessionId, "prune");
  if (!check.empty || !check.row) {
    return { pruned: false, streamChatId: null };
  }
  const streamChatId = await deleteSessionAndTransport(sessionId);
  logger.info(
    `[session-prune] left empty session ${sessionId.slice(0, 8)} removed`,
  );
  return { pruned: true, streamChatId };
}

/**
 * Write an AUTO title only if the session still holds `expected` and nobody
 * claimed it. A user rename (titleSource "user"), a delete, or another title
 * landing first all make this a no-op — so a slow model can never overwrite a
 * name the user typed while it was thinking. `updatedAt` is left alone: naming
 * a session is not activity, and must not reorder the sidebar.
 */
async function setAutoTitleIfUnchanged(
  sessionId: string,
  title: string,
  expected: string,
): Promise<boolean> {
  const changed = await db
    .update(chatSessions)
    .set({ title, titleSource: "auto" })
    .where(
      and(
        eq(chatSessions.id, sessionId),
        eq(chatSessions.title, expected),
        eq(chatSessions.titleSource, "auto"),
      ),
    )
    .returning({ id: chatSessions.id });
  if (changed.length === 0) return false;
  broadcastToAllWindows("sessions:title-updated", { sessionId, title });
  return true;
}

/**
 * Name a session from its FIRST user message, the moment it is saved.
 *
 * The universal pattern (opencode, Codex CLI, Claude Code): runs in the
 * background, parallel to the turn, never awaited by it; the user's own words
 * appear at once as the placeholder; a generated title replaces it only if it
 * is a real title and the session is still ours to name. Once per session —
 * a session that already has a non-default title is left alone.
 *
 * Because the placeholder lands before the model is even asked, a turn that
 * errors still leaves a named session — which is what used to strand
 * "Untitled" rows after every failed first turn.
 */
export async function titleSessionFromFirstMessage(
  sessionId: string,
  rawUserText: string,
  opts: { chatId?: number | null } = {},
): Promise<void> {
  // The headless CLI has no sidebar to show a title in; a benchmark run should
  // not pay for one.
  if (process.env.ATLARIX_HEADLESS === "1") return;
  try {
    const text = stripContentForTitleSource(rawUserText, "user");
    if (!text) return;
    const session = await db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, sessionId),
    });
    if (!session || session.titleSource === "user") return;
    let current = session.title.trim();
    if (!DEFAULT_SESSION_TITLES.has(current)) return;
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(sessionMessages)
      .where(
        and(
          eq(sessionMessages.sessionId, sessionId),
          eq(sessionMessages.role, "user"),
        ),
      );
    if (Number(n) > 1) return;

    const placeholder = deterministicTitle(text);
    if (placeholder && placeholder !== current) {
      if (
        await setAutoTitleIfUnchanged(sessionId, placeholder, session.title)
      ) {
        current = placeholder;
      } else {
        return; // renamed or deleted under us
      }
    }

    const generated = await generateSessionTitle(text, opts);
    if (generated && generated !== current) {
      await setAutoTitleIfUnchanged(sessionId, generated, current);
    }
  } catch (err) {
    logger.warn("titleSessionFromFirstMessage failed:", err);
  }
}

export function registerWorkspaceSessionHandlers(): void {
  handle("sessions:list", async (_event, workspaceId: number) => {
    const rows = await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.workspaceId, workspaceId),
          // Automation-run transcripts (kind="background") live in the
          // automations feed, not the workspace session list.
          eq(chatSessions.kind, "normal"),
        ),
      )
      .orderBy(desc(chatSessions.updatedAt));
    return rows.map((r) => mapSession(r));
  });

  /**
   * Every folder's chats, newest first, each with its folder (an editor's Past
   * chats → All folders). Capped: the list is for finding a recent chat.
   */
  handle("sessions:list-all", async (_event, limit = 200) => {
    const rows = await db
      .select({ session: chatSessions, folder: apps.path, folderName: apps.name })
      .from(chatSessions)
      .innerJoin(apps, eq(apps.id, chatSessions.workspaceId))
      .where(eq(chatSessions.kind, "normal"))
      .orderBy(desc(chatSessions.updatedAt))
      .limit(Math.min(Math.max(1, Number(limit) || 200), 500));
    return rows.map((r) => ({ ...mapSession(r.session), folder: r.folder, folderName: r.folderName }));
  });

  handle(
    "sessions:resolve-for-transport",
    async (_event, payload: { chatId: number; workspaceId?: number }) => {
      return resolveOrBindWorkspaceSessionForStream({
        chatId: payload.chatId,
        workspaceAppId: payload.workspaceId,
      });
    },
  );

  handle(
    "sessions:snapshot-turn-ids",
    async (_event, payload: { chatId: number }) => {
      // Bug 6: rehydrate the revert-turn affordance on ANY load path (relaunch /
      // openWorkspaceFolder), not just manual session-list selection. Resolve the
      // chat's bound session READ-ONLY (no binding side effects), then return the
      // persisted per-assistant snapshot_turn_id rows so the renderer can rebuild
      // turnSnapshotTurnIdByMessageId via buildRevertSnapshotMap. Cheap targeted
      // query — not a full session message load.
      const sessionId = sessionForTransport(payload.chatId);
      const session = sessionId
        ? await db.query.chatSessions.findFirst({ where: eq(chatSessions.id, sessionId) })
        : undefined;
      if (!session) return [];
      const rows = await db
        .select({
          id: sessionMessages.id,
          snapshotTurnId: sessionMessages.snapshotTurnId,
        })
        .from(sessionMessages)
        .where(
          and(
            eq(sessionMessages.sessionId, session.id),
            eq(sessionMessages.role, "assistant"),
          ),
        )
        .all();
      const out = rows
        .filter((r) => !!r.snapshotTurnId)
        .map((r) => ({
          rowId: r.id,
          snapshotTurnId: r.snapshotTurnId as string,
        }));
      if (process.env.ATLARIX_DIAG_146 === "1") {
        logger.info(
          `[DIAG_146] snapshot-turn-ids chat=${payload.chatId} session=${session.id} assistantRows=${rows.length} withSnapshot=${out.length}`,
        );
      }
      return out;
    },
  );

  handle("sessions:start", async (_event, workspaceId: number, opts?: { claim?: boolean }) => {
    // Defense-in-depth: a workspace session may only be started by a signed-in
    // user (the UI gates selection too, but never trust the renderer).
    await requireAuthSession();
    const started = await startWorkspaceSession(workspaceId, { claim: opts?.claim === true });
    logger.info(
      `sessions:start workspace=${workspaceId} session=${started.sessionId} transport=${started.chatId}`,
    );
    void noteSessionOpen(started.sessionId, started.chatId);
    return started;
  });

  handle("sessions:allocate-transport", async (_event, sessionId: string) => {
    const session = await db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, sessionId),
    });
    if (!session) throw new Error("Session not found");

    // Reused only if THIS process bound it to this session: the stored id may
    // be another process's, and the same number here another session's chat.
    const stored = transportForSession(sessionId);
    if (stored != null && getStreamTransport(stored)?.appId === session.workspaceId) {
      void noteSessionOpen(sessionId, stored);
      return { chatId: stored };
    }

    const chatId = createStreamTransport(session.workspaceId);
    await persistSessionStreamChatId(sessionId, chatId);
    void noteSessionOpen(sessionId, chatId);
    return { chatId };
  });

  // ─── Live sessions across surfaces ─────────────────────────────────────────
  //
  // A session is LIVE WHERE ITS TURN RUNS. While another process runs a turn of
  // it, every other surface showing it follows: re-reads it as the turn's draft
  // grows (`revision`), sends what the user types to that turn (`steer-remote`)
  // and stops it (`stop-remote`). No owner and no locks: when that turn ends,
  // either surface may start the next.

  /** The surface running a turn of this session right now, or null. */
  handle("sessions:running-elsewhere", async (_event, sessionId: string) => {
    const row = runningElsewhere(sessionId);
    return row ? { surface: row.surface, name: row.name } : null;
  });

  /**
   * A cheap token that changes whenever the session's messages do: rows added,
   * a draft growing, a draft finishing. A follower polls it and re-reads the
   * session only when it moves.
   */
  handle("sessions:revision", async (_event, sessionId: string) => {
    const [r] = await db
      .select({
        n: sql<number>`count(*)`,
        chars: sql<number>`coalesce(sum(length(${sessionMessages.content})), 0) + coalesce(sum(length(${sessionMessages.modelContent})), 0)`,
        open: sql<number>`coalesce(sum(${sessionMessages.status} != 'complete'), 0)`,
      })
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId));
    return `${r?.n ?? 0}.${r?.chars ?? 0}.${r?.open ?? 0}`;
  });

  /** The user's words for the turn running elsewhere; `{ok:false, error:"not running"}` once it has ended. */
  handle("sessions:steer-remote", async (_event, sessionId: string, text: string) =>
    steerElsewhere(sessionId, String(text ?? "")),
  );

  /** Stop the turn running elsewhere. */
  handle("sessions:stop-remote", async (_event, sessionId: string) => stopElsewhere(sessionId));

  /**
   * `/fork`: the conversation as saved now, as a new session in the same folder,
   * named "<title> (fork)" (or what the user named it). The original is untouched.
   *
   * Every column but the ids is copied, so a turn's native tool history
   * (`modelContent`), its attachments, its frozen tool UI and its plan rows come
   * along, and `snapshotTurnId` with them: `/undo` in the fork restores files,
   * since snapshots are found by workspace and turn (performFullRevert). A turn
   * still being written (the last row, interrupted, while the source runs) is
   * left out: it is not finished, and the fork must not carry half of it.
   */
  handle(
    "sessions:fork",
    async (_event, sessionId: string, opts?: { title?: string }) => {
      const source = await db.query.chatSessions.findFirst({
        where: eq(chatSessions.id, sessionId),
      });
      if (!source) throw new Error("Session not found");
      const rows = await db
        .select()
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, sessionId))
        .orderBy(asc(sessionMessages.createdAt), sql`rowid asc`);
      const last = rows.at(-1);
      const running =
        runningElsewhere(sessionId) != null ||
        isChatStreamLive(transportForSession(sessionId) ?? 0);
      const copied = last && running && last.status === "interrupted" ? rows.slice(0, -1) : rows;

      const fork = await insertWorkspaceSession(source.workspaceId);
      const named = opts?.title?.trim();
      const [row] = await db
        .update(chatSessions)
        .set({
          title: named || `${source.title?.trim() || "Untitled"} (fork)`,
          titleSource: named ? "user" : "auto",
          workMode: source.workMode,
        })
        .where(eq(chatSessions.id, fork.id))
        .returning();
      try {
        // In chunks: one statement binds every column of every row, and a long
        // session passes SQLite's limit on bound values.
        for (let i = 0; i < copied.length; i += 200) {
          await db.insert(sessionMessages).values(
            copied.slice(i, i + 200).map(({ id: _id, sessionId: _from, ...rest }) => ({
              ...rest,
              id: randomUUID(),
              sessionId: fork.id,
            })),
          );
        }
      } catch (e) {
        // Never leave half a fork behind.
        await db.delete(chatSessions).where(eq(chatSessions.id, fork.id));
        throw e;
      }
      return mapSession(row ?? fork);
    },
  );

  /** App → CLI handoff: open the user's terminal on this session (lib/peers). */
  handle("sessions:continue-in-terminal", async (_event, sessionId: string) => {
    const session = await db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, sessionId),
    });
    if (!session) return { ok: false, error: "Session not found" };
    const workspace = session.workspaceId
      ? await db.query.apps.findFirst({ where: eq(apps.id, session.workspaceId) })
      : undefined;
    const { continueInTerminal } = await import("@/lib/peers/continue-in-terminal");
    return continueInTerminal(sessionId, workspace?.path ?? "");
  });

  /** App → editor handoff: the same session in Atlarix's extension (lib/peers/open-in-editor). */
  handle("sessions:open-in-editor", async (_event, sessionId: string, editor: string) => {
    const session = await db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, sessionId),
    });
    if (!session) return { ok: false, error: "Session not found" };
    const workspace = session.workspaceId
      ? await db.query.apps.findFirst({ where: eq(apps.id, session.workspaceId) })
      : undefined;
    const { openInEditor } = await import("@/lib/peers/open-in-editor");
    return openInEditor(sessionId, workspace?.path ?? "", editor);
  });

  handle("sessions:create", async (_event, workspaceId: number) => {
    await requireAuthSession();
    return insertWorkspaceSession(workspaceId);
  });

  handle(
    "sessions:rename",
    async (_event, sessionId: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) {
        throw new Error("Title cannot be empty");
      }
      const [row] = await db
        .update(chatSessions)
        // A hand-typed name is the user's and must never be regenerated over.
        .set({ title: trimmed, titleSource: "user", updatedAt: new Date() })
        .where(eq(chatSessions.id, sessionId))
        .returning();
      if (!row) throw new Error("Session not found");
      // Other sessions address this one by name: keep the registry's current.
      const local = transportForSession(sessionId);
      if (local != null) void noteSessionOpen(sessionId, local);
      return mapSession(row);
    },
  );

  /**
   * Stamp the session's work mode.
   *
   * Called when the user picks a mode while this session is active — a
   * deliberate choice, which is the only thing that should write here. Opening a
   * session must NOT call this: a legacy session would then acquire whatever the
   * global preference happened to be at that moment, which is a mode nobody
   * chose for it.
   */
  handle(
    "sessions:set-work-mode",
    async (_event, sessionId: string, workMode: WorkMode) => {
      const parsed = WorkModeSchema.safeParse(workMode);
      if (!parsed.success) {
        throw new Error(`Invalid work mode: ${String(workMode)}`);
      }
      const [row] = await db
        .update(chatSessions)
        .set({ workMode: parsed.data, updatedAt: new Date() })
        .where(eq(chatSessions.id, sessionId))
        .returning();
      if (!row) throw new Error("Session not found");
      return mapSession(row);
    },
  );

  handle("sessions:delete", async (_event, sessionId: string) => {
    const streamChatId = await deleteSessionAndTransport(sessionId);
    // Returned so the renderer can clear its per-chat atoms for this transport.
    return { ok: true, streamChatId };
  });

  /**
   * Delete a session the user is LEAVING, but only if it is truly empty.
   *
   * Switching to an older session used to leave the fresh "Untitled" behind,
   * and it sat in the list until the next "New conversation" happened to reuse
   * or prune it. The same guard that protects reuse decides here —
   * `verifyTrulyEmptySession(…, "prune")`: zero messages on a fresh re-count, a
   * default title, and never written to. Anything else is refused, because a
   * wrong "empty" here deletes a conversation.
   */
  handle("sessions:prune-if-empty", async (_event, sessionId: string) =>
    pruneSessionIfEmpty(sessionId),
  );

  handle(
    "sessions:get",
    async (_event, sessionId: string, opts?: { limit?: number }) => {
      const session = await db.query.chatSessions.findFirst({
        where: eq(chatSessions.id, sessionId),
      });
      if (!session) throw new Error("Session not found");

      const limit = opts?.limit ?? SESSION_LOAD_MESSAGE_LIMIT;
      const [countRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, sessionId));
      const totalCount = Number(countRow?.count ?? 0);

      // better-sqlite3 is SYNCHRONOUS: this read blocks the main process for its
      // whole duration, which is why it is timed separately from the mapping below.
      const recent = await diagSpan(
        "main: select session_messages",
        () =>
          db
            .select()
            .from(sessionMessages)
            .where(eq(sessionMessages.sessionId, sessionId))
            // DESC + `.limit()` takes the NEWEST `limit` rows, then the caller
            // reverses. Without a tiebreak the newest-N cut AND the final display
            // order are both undefined among rows sharing a second (`created_at`
            // is `unixepoch()`, whole seconds) — which is how a session could
            // reload showing the assistant's reply ABOVE the question it answers.
            // Caught by `stream-transport-contract.eval` flaking under load;
            // `rowid` is SQLite's insertion order, so it breaks the tie correctly.
            .orderBy(desc(sessionMessages.createdAt), sql`rowid desc`)
            .limit(limit),
        {
          sink: (line) => logger.info(line),
          count: (r) => r.length,
          bytes: (r) => measureSessionPayloadBytes(r).total,
        },
      );
      const rows = [...recent].reverse();

      // `mapMessage` runs parseDisplaySnapshot per row — a JSON.parse of the whole
      // rendered thread for every assistant turn, all on the main thread.
      const messages = diagSpanSync(
        "main: mapMessage + parseDisplaySnapshot",
        () => rows.map(mapMessage).filter((m) => m.kind !== "plan"),
        { sink: (line) => logger.info(line), count: (m) => m.length },
      );
      hydrateAttachmentStoreFromMessages(
        messages,
        transportForSession(session.id),
        session.id,
      );
      if (sessionLoadDiagEnabled()) {
        const b = measureSessionPayloadBytes(messages);
        logger.info(
          `[diag:session-load] main: payload to renderer — total ${(b.total / 1_048_576).toFixed(2)} MB ` +
            `(content ${(b.content / 1_048_576).toFixed(2)}, modelContent ${(b.modelContent / 1_048_576).toFixed(2)}, ` +
            `displaySnapshot ${(b.displaySnapshot / 1_048_576).toFixed(2)}) across ${messages.length} messages`,
        );
      }
      return {
        session: mapSession(session),
        messages,
        truncated: totalCount > limit,
        totalCount,
      };
    },
  );

  /**
   * Hydrate a chat's in-memory transport from MAIN's own session rows.
   *
   * Replaces the renderer round trip: `sessions:get` shipped `content`,
   * `modelContent` and `displaySnapshot` to the renderer, which mapped them to UI
   * messages and then sent every one of those bytes straight BACK to main via
   * `chat:hydrate-ephemeral-messages` — 4.5 MB re-serialized, in both directions,
   * for data main had just read out of SQLite.
   *
   * Only the renderer can supply the numeric display ids (they are allocated in the
   * renderer and the whole edit/revert path keys on them), so that is all it sends:
   * an ordered list of `{id, sessionRowId}`. Everything else is joined from the DB
   * here. Order comes from the renderer's array, not from a re-query, so the
   * transport can never disagree with what is on screen.
   */
  handle(
    "sessions:hydrate-transport",
    async (
      _event,
      payload: {
        chatId: number;
        sessionId: string;
        rows: { id: number; sessionRowId?: string | null }[];
      },
    ) => {
      if (!isStreamTransportId(payload.chatId)) return { hydrated: 0 };
      const dbRows = await db
        .select()
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, payload.sessionId));

      const messages = joinTransportRows(dbRows.map(mapMessage), payload.rows);

      hydrateAttachmentStoreFromMessages(
        messages,
        payload.chatId,
        payload.sessionId,
      );
      hydrateStreamTransport(payload.chatId, messages);
      if (sessionLoadDiagEnabled()) {
        const b = measureSessionPayloadBytes(messages);
        logger.info(
          `[diag:session-load] main: hydrated transport from own rows — ${messages.length} messages, ` +
            `${(b.total / 1_048_576).toFixed(2)} MB never crossed IPC`,
        );
      }
      return { hydrated: messages.length };
    },
  );

  handle(
    "messages:add",
    async (
      _event,
      sessionId: string,
      role: "user" | "assistant" | "tool",
      content: string,
      displaySnapshot?: string,
      extras?: SessionMessageExtras,
    ) =>
      addSessionMessageDirect(
        sessionId,
        role,
        content,
        displaySnapshot,
        extras,
      ),
  );

  handle("messages:mark-complete", async (_event, rowId: string) => {
    await markSessionMessageComplete(rowId);
    return { ok: true };
  });

  /**
   * Re-title from the first user message ON REQUEST — the first prompt was
   * edited, so the title derived from it is stale. Ordinary naming happens in
   * `titleSessionFromFirstMessage`, the moment the first message is saved.
   */
  handle("sessions:generate-title", async (_event, sessionId: string) => {
    const session = await db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, sessionId),
    });
    if (!session) throw new Error("Session not found");
    const currentTitle = session.title;
    if (session.titleSource === "user") return { title: currentTitle };

    const rows = await db
      .select()
      .from(sessionMessages)
      .where(
        and(
          eq(sessionMessages.sessionId, sessionId),
          eq(sessionMessages.role, "user"),
        ),
      )
      .orderBy(asc(sessionMessages.createdAt));
    // The first user message that still says something ONCE STRIPPED — a
    // session opened by pasting an attachment strips its first message to "".
    const text =
      rows
        .map((m) => stripContentForTitleSource(m.content ?? "", "user").trim())
        .find((t) => t.length > 0) ?? "";
    if (!text) return { title: currentTitle };

    const next =
      (await generateSessionTitle(text, {
        chatId: transportForSession(session.id) ?? null,
      })) ?? deterministicTitle(text);
    if (
      next &&
      next !== currentTitle &&
      (await setAutoTitleIfUnchanged(sessionId, next, currentTitle))
    ) {
      return { title: next };
    }
    return { title: currentTitle };
  });
}
