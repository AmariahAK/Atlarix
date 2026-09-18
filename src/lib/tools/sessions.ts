/**
 * `session_search` — reading behind the compaction boundary.
 *
 * WHY THIS TOOL EXISTS
 * --------------------
 * Compaction is lossy on purpose: a summary of forty turns is not forty turns.
 * Until now the agent's only recourse for something that had been summarized away
 * was the advice in `droppedHistoryNotice` — "re-read the relevant files or ask
 * the user" — which is the harness admitting it has no recall path and handing the
 * cost to the person who was already waiting. The full transcript was never gone;
 * it sits in `session_messages` for the UI's scrollback. It was simply unreachable
 * by any tool: `grep` is bundled ripgrep over FILES, and a conversation is rows.
 *
 * ONE TOOL, TWO MODES — NOT TWO TOOLS
 * -----------------------------------
 * "Search this conversation's earlier turns" and "search a previous conversation"
 * are the same query at a different scope. Shipping them separately would mean two
 * descriptions to keep true, two `LABELS`/`DONE_LABELS` entries, two expand-view
 * branches, and a capability question ("which one can see the current session?")
 * for the model to get wrong. `mode` mirrors the `grep` → `read_file` pairing the
 * model already knows: search for hits, then read around one.
 *
 * WHY `LIKE` AND NOT FTS5
 * -----------------------
 * FTS5 was deliberately torn out in the retrieval teardown (v14.9.0, 2026-07-10)
 * along with BM25 and the symbol tagger, because an index that must be maintained
 * drifts from the thing it indexes. Re-introducing one for sessions would rebuild
 * exactly that surface for a corpus measured in thousands of rows, where a scan is
 * already fast.
 * No index, no migration, no new dependency.
 *
 * ISOLATION IS STRUCTURAL, AND SO IS DELETION
 * -------------------------------------------
 * Every query is filtered by the harness-injected `workspaceId` BEFORE it can
 * reach a message: sessions are looked up by workspace, and messages only by a
 * session id already proven to belong to it (the search re-asserts it in the JOIN
 * as well). A workspace cannot name another workspace's session, and there is no
 * code path that takes a session id from the model without that check.
 *
 * The current-conversation id is injected too, and is NOT in the schema — see
 * `resolveCurrentSessionId` for why that matters beyond tidiness.
 *
 * A DELETED session is therefore unfindable twice over. `session_messages.session_id`
 * is `ON DELETE CASCADE` against `chat_sessions.id` and the connection sets
 * `foreign_keys = ON`, so deleting a conversation removes its messages outright.
 * And because every lookup resolves a live `chat_sessions` row first, an orphaned
 * message row would still be unreachable if that cascade ever failed to fire.
 * Both halves are tested — the second with foreign keys deliberately disabled —
 * because either one alone would be a leak. See
 * `src/__tests__/session-search-scoping.test.ts` and
 * `tests/agent-evals/session-search.eval.test.ts`.
 */

import log from "electron-log";
import { and, asc, desc, eq, like, ne, notLike, sql } from "drizzle-orm";
import { db } from "../../db";
import { chatSessions, sessionMessages } from "../../db/schema";
import {
  ToolRegistry,
  createParameters,
  stringParam,
  numberParam,
  enumParam,
} from "./registry";

const logger = log.scope("session-search");

/** Hits returned by one search. Bounded so a search cannot re-inflate context. */
const DEFAULT_MAX_HITS = 20;
const MAX_HITS_CEILING = 100;
/** Characters of surrounding message text shown per hit in `search` mode. */
const SNIPPET_CHARS = 220;
/** Messages returned per `read` page — self-paginated like `read_file`. */
const DEFAULT_READ_LIMIT = 10;
const MAX_READ_LIMIT = 50;
/** Sessions considered when resolving a `session` title fragment. */
const SESSION_LOOKUP_CAP = 50;

type SessionRef = { id: string; title: string; createdAt: Date };

/**
 * Compaction markers are not conversation, and this tool reads conversation.
 *
 * A `[COMPACTION MARKER] gen=N … [END COMPACTION]` row is harness bookkeeping —
 * a summary the compactor wrote so a reload need not re-send the whole history.
 * Returning it here is worse than noise: the model asked to recover a specific
 * fact, and a summary is the lossy thing it is trying to look behind.
 *
 * EXCLUDED IDENTICALLY IN BOTH MODES, and that is load-bearing. `search` numbers
 * its hits with `ROW_NUMBER()` and `read` pages by `offset`; if one excluded
 * markers and the other did not, "turn 7" would mean different rows in each and
 * the read-around-a-hit workflow the tool description promises would land in the
 * wrong place.
 *
 * The `content` clause carries rows written before the `kind` column. SQLite's
 * LIKE gives `[` no special meaning (that is SQL Server), so the literal matches.
 */
const EXCLUDE_MARKERS_SQL = sql`m.kind != 'compaction_marker' AND m.content NOT LIKE '[COMPACTION MARKER]%'`;

const notACompactionMarker = () =>
  and(
    ne(sessionMessages.kind, "compaction_marker"),
    notLike(sessionMessages.content, "[COMPACTION MARKER]%"),
  );

/**
 * Which session is "the current one", from what the HARNESS injected.
 *
 * Not from the model. The first version of this tool took a `chatId` parameter
 * documented as "(auto-provided)" — and nothing provided it. `execArgs.chatId` is
 * set only for `stream_terminal_output` (`ask-branch.ts`, `build-branch.ts`); what
 * every tool actually receives is `workspaceSessionId` and `_chatSessionId`. So a
 * model that did the right thing and omitted `session` was told "No current
 * session to search", and its only way forward was `session:"all"`. The default
 * was unreachable and the WIDER scope was the fallback — the wrong way round for
 * a tool that reads conversation history.
 *
 * Two shapes, because the two call sites inject differently:
 *   - a turn injects `workspaceSessionId` (the uuid) — used directly, no lookup
 *   - a sub-agent injects only `_chatSessionId` (the numeric transport id), which
 *     `resolveOrBindWorkspaceSessionForStream` maps to a session
 *
 * Neither name is in the tool schema, so the model cannot supply either. That is
 * what keeps `isReadOnly: true` honest: `resolveOrBindWorkspaceSessionForStream`
 * can BIND or CREATE a session row, and a model-supplied id must never reach it.
 */
async function resolveCurrentSessionId(args: {
  workspaceSessionId?: string;
  _chatSessionId?: number;
}): Promise<string | null> {
  const provided = args.workspaceSessionId?.trim();
  if (provided) return provided;
  if (args._chatSessionId == null) return null;
  const { resolveOrBindWorkspaceSessionForStream } = await import(
    "@/ipc/handlers/workspace_session_handlers"
  );
  try {
    return await resolveOrBindWorkspaceSessionForStream({
      chatId: args._chatSessionId,
    });
  } catch {
    // An ephemeral chat that was never persisted has no session to resolve.
    return null;
  }
}

/**
 * Resolve the `session` argument to concrete sessions, ALWAYS inside `workspaceId`.
 *
 * - omitted        → the current session only (resolved from what the harness injected)
 * - "all"          → every session in this workspace, newest first
 * - a session id   → that session, but only if it belongs to this workspace
 * - anything else  → sessions whose title contains it (case-insensitive)
 */
async function resolveSessions(
  workspaceId: number,
  current: { workspaceSessionId?: string; _chatSessionId?: number },
  session: string | undefined,
): Promise<{ sessions: SessionRef[]; error?: string }> {
  const pick = (rows: Array<typeof chatSessions.$inferSelect>): SessionRef[] =>
    rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.createdAt }));

  if (!session || session.trim() === "" || session === "current") {
    const sessionId = await resolveCurrentSessionId(current);
    if (!sessionId) {
      return {
        sessions: [],
        error:
          "This conversation has not been persisted yet, so it has no searchable history. " +
          'Pass `session` to name an earlier one, or "all".',
      };
    }
    // Re-read through the workspace filter: never trust an id straight into a
    // message query, even one we just resolved ourselves.
    const rows = await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.id, sessionId),
          eq(chatSessions.workspaceId, workspaceId),
        ),
      );
    return { sessions: pick(rows) };
  }

  const trimmed = session.trim();

  if (trimmed === "all") {
    const rows = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.workspaceId, workspaceId))
      .orderBy(desc(chatSessions.updatedAt))
      .limit(SESSION_LOOKUP_CAP);
    return { sessions: pick(rows) };
  }

  const byId = await db
    .select()
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.id, trimmed),
        eq(chatSessions.workspaceId, workspaceId),
      ),
    );
  if (byId.length > 0) return { sessions: pick(byId) };

  const byTitle = await db
    .select()
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.workspaceId, workspaceId),
        like(sql`lower(${chatSessions.title})`, `%${trimmed.toLowerCase()}%`),
      ),
    )
    .orderBy(desc(chatSessions.updatedAt))
    .limit(SESSION_LOOKUP_CAP);
  if (byTitle.length === 0) {
    return {
      sessions: [],
      error: `No session in this workspace matches "${trimmed}". Use \`session: "all"\` to search every session, or omit it for the current one.`,
    };
  }
  return { sessions: pick(byTitle) };
}

/** Collapse a message to a single line around the first match. */
function snippetAround(content: string, needle: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return flat.slice(0, SNIPPET_CHARS);
  const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
  const out = flat.slice(start, start + SNIPPET_CHARS);
  return (
    (start > 0 ? "…" : "") +
    out +
    (start + SNIPPET_CHARS < flat.length ? "…" : "")
  );
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  let i = h.indexOf(n);
  while (i !== -1) {
    count++;
    i = h.indexOf(n, i + n.length);
  }
  return count;
}

/** `session · turn N · role` — the "path" a match_list row displays. */
function hitPath(sessionTitle: string, turn: number, role: string): string {
  return `${sessionTitle} · turn ${turn} · ${role}`;
}

export type SessionSearchArgs = {
  query?: string;
  session?: string;
  mode?: "search" | "read";
  turn?: number;
  offset?: number;
  limit?: number;
  // Harness-injected, never model-facing. See `resolveCurrentSessionId`.
  workspaceId?: number;
  workspaceSessionId?: string;
  _chatSessionId?: number;
};

export async function executeSessionSearch(args: SessionSearchArgs) {
  const workspaceId = args.workspaceId;
  if (workspaceId == null) {
    return {
      success: false,
      error: "session_search needs an open workspace.",
    };
  }

  const mode = args.mode === "read" ? "read" : "search";
  const { sessions, error } = await resolveSessions(
    workspaceId,
    {
      workspaceSessionId: args.workspaceSessionId,
      _chatSessionId: args._chatSessionId,
    },
    args.session,
  );
  if (error) return { success: false, error };
  if (sessions.length === 0) {
    return {
      success: true,
      result: "No sessions to search.",
      ui: { groups: [] },
    };
  }

  // ── READ: a page of consecutive messages from ONE session.
  if (mode === "read") {
    const target = sessions[0]!;
    const limit = Math.min(
      Math.max(args.limit ?? DEFAULT_READ_LIMIT, 1),
      MAX_READ_LIMIT,
    );
    const offset = Math.max(args.offset ?? 0, 0);
    const rows = await db
      .select()
      .from(sessionMessages)
      .where(
        and(eq(sessionMessages.sessionId, target.id), notACompactionMarker()),
      )
      .orderBy(asc(sessionMessages.createdAt))
      .limit(limit)
      .offset(offset);
    const [{ total } = { total: 0 }] = await db
      .select({ total: sql<number>`count(*)` })
      .from(sessionMessages)
      .where(
        and(eq(sessionMessages.sessionId, target.id), notACompactionMarker()),
      );

    if (rows.length === 0) {
      return {
        success: true,
        result: `No messages at offset ${offset} in "${target.title}" (${total} total).`,
        ui: { groups: [] },
      };
    }

    const body = rows
      .map((r, i) => `— turn ${offset + i + 1} · ${r.role} —\n${r.content}`)
      .join("\n\n");
    const shown = offset + rows.length;
    const more =
      shown < total
        ? `\n\n[${total - shown} earlier/later message(s) not shown — call again with offset: ${shown}]`
        : "";
    return {
      success: true,
      result: `Session "${target.title}" · messages ${offset + 1}–${shown} of ${total}\n\n${body}${more}`,
      ui: {
        groups: [
          {
            file: `${target.title} · turns ${offset + 1}–${shown}`,
            matchCount: rows.length,
          },
        ],
      },
    };
  }

  // ── SEARCH: substring hits across the resolved sessions.
  const query = (args.query ?? "").trim();
  if (!query) {
    return {
      success: false,
      error: "session_search needs a `query` in search mode.",
    };
  }
  const maxHits = Math.min(
    Math.max(args.limit ?? DEFAULT_MAX_HITS, 1),
    MAX_HITS_CEILING,
  );

  const groups: Array<{ file: string; matchCount: number }> = [];
  const lines: string[] = [];

  /*
   * ONE query, filtered and limited in SQL.
   *
   * The first version of this selected every message of every resolved session
   * and filtered in JS. With `session: "all"` that is up to 50 sessions' full
   * transcripts pulled into memory to answer one substring question — the sort
   * of load that only shows up on somebody's real workspace, months in.
   *
   * `ROW_NUMBER() OVER (PARTITION BY session_id ...)` is what makes filtering in
   * SQL possible at all: the turn number is POSITIONAL within the session, so
   * before this it had to be derived by indexing an ordered array in JS. The
   * window function computes it without returning the non-matching rows.
   *
   * Isolation is unchanged and still structural: `sessionIds` came from a
   * workspace-filtered query on `chat_sessions`, and the JOIN re-asserts it, so
   * a row whose session is gone or foreign cannot appear even if one of the two
   * were somehow wrong.
   *
   * `LIKE` is parameterized by drizzle (`sql` interpolates values as binds, not
   * text), so the model's query string cannot alter the statement. Its `%`/`_`
   * do act as wildcards, which is a reasonable reading of "search" and is stated
   * in the tool description.
   */
  const sessionIds = sessions.map((s) => s.id);
  const titleById = new Map(sessions.map((s) => [s.id, s.title]));
  const needle = `%${query.toLowerCase()}%`;

  const hits = await db.all<{
    session_id: string;
    role: string;
    content: string;
    turn: number;
  }>(sql`
        SELECT session_id, role, content, turn FROM (
          SELECT m.session_id AS session_id,
                 m.role       AS role,
                 m.content    AS content,
                 ROW_NUMBER() OVER (
                   PARTITION BY m.session_id
                   ORDER BY m.created_at ASC, m.id ASC
                 ) AS turn
          FROM ${sessionMessages} m
          JOIN ${chatSessions} s ON s.id = m.session_id
          WHERE s.workspace_id = ${workspaceId}
            AND m.session_id IN ${sessionIds}
            AND ${EXCLUDE_MARKERS_SQL}
        )
        WHERE lower(content) LIKE ${needle}
        ORDER BY session_id, turn
        LIMIT ${maxHits}
    `);

  for (const h of hits) {
    const path = hitPath(
      titleById.get(h.session_id) ?? h.session_id,
      h.turn,
      h.role,
    );
    groups.push({
      file: path,
      matchCount: countOccurrences(h.content ?? "", query),
    });
    lines.push(`${path}\n  ${snippetAround(h.content ?? "", query)}`);
  }
  const totalHits = hits.length;

  if (totalHits === 0) {
    const scope =
      sessions.length === 1
        ? `"${sessions[0]!.title}"`
        : `${sessions.length} sessions`;
    return {
      success: true,
      result: `No messages matching "${query}" in ${scope}.`,
      ui: { groups: [] },
    };
  }

  const capped =
    totalHits >= maxHits
      ? `\n\n[stopped at ${maxHits} hits — narrow the query, or raise \`limit\`]`
      : "";
  logger.info(
    `session_search "${query}" → ${totalHits} hit(s) across ${sessions.length} session(s)`,
  );
  return {
    success: true,
    result: `${totalHits} match(es) for "${query}"\n\n${lines.join("\n\n")}${capped}\n\nUse mode:"read" with an offset to see full turns around a hit.`,
    ui: { groups },
  };
}

ToolRegistry.register({
  name: "session_search",
  requiresWorkspace: true,
  isReadOnly: true,
  allowInAskMode: true,
  description:
    "Search or re-read the transcript of this conversation (or an earlier one in this workspace) — including turns that compaction has already summarized away. " +
    "Use it to recover a SPECIFIC fact you know was stated: an exact path the user gave, a decision made twenty turns ago, an error message you saw before. " +
    "Do NOT use it to re-read the conversation in bulk — the summary in your context is deliberately shorter than the history, and pulling the history back defeats it. " +
    'mode:"search" lists matching turns with snippets; mode:"read" pages full turns from one session (offset/limit).',
  parameters: createParameters(
    {
      query: stringParam(
        "Substring to find (case-insensitive). Required in search mode.",
      ),
      session: stringParam(
        'Which session: omit for the CURRENT conversation, "all" for every session in this workspace, or a session id / part of a session title.',
      ),
      mode: enumParam(
        "search (default) lists matching turns; read pages full turns from one session.",
        "search",
        ["search", "read"],
      ),
      offset: numberParam(
        "read mode: how many messages to skip from the start of the session.",
        0,
        0,
      ),
      limit: numberParam(
        "search mode: max hits (default 20, max 100). read mode: messages per page (default 10, max 50).",
      ),
      // `workspaceSessionId` / `_chatSessionId` are injected by the harness and
      // deliberately absent here: they select which conversation is read, and
      // `resolveOrBindWorkspaceSessionForStream` can bind or create a session row.
      // `workspaceId` is injected by the turn runner and NOT advertised.
      // Every query is still filtered by it — see the note at the top of
      // this file; that scoping is unaffected by dropping it from the schema.
    },
    [],
  ),
  handler: async (rawArgs: unknown) => {
    try {
      return await executeSessionSearch(rawArgs as SessionSearchArgs);
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});
