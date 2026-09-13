/**
 * `recall` — looking behind a summary, and into earlier conversations.
 *
 * WHY IT EXISTS. Compaction is lossy on purpose: a summary of forty turns is not
 * forty turns. Without this tool a model that needs a figure from turn six has
 * exactly two moves, and both are bad — guess, or ask the user to repeat
 * something they already said. The turns are still on this device; they were
 * simply unreachable, because every other tool in this extension reads a web
 * page and a conversation is not one.
 *
 * THE MARKET DOES NOT DO THIS. Checked 2026-09-13 against Claude Code, Codex
 * CLI, OpenCode and Amp: all four compact, none of them tells the model the
 * detail is recoverable or gives it a way to go and get it. That is the gap this
 * fills, and it is why the recovery hint is attached to every marker rather than
 * left to the system prompt — a hint on the summary itself is read at the moment
 * it is needed.
 *
 * ONE TOOL, TWO MODES — NOT TWO TOOLS. "Search this conversation" and "search an
 * earlier one" are the same query at a different scope. Two tools would mean two
 * descriptions to keep true, two labels, and a capability question for the model
 * to get wrong. `mode` mirrors the find-then-read pairing it already knows.
 *
 * COMPACTION MARKERS ARE EXCLUDED FROM BOTH MODES IDENTICALLY, and that is
 * load-bearing rather than tidy. `search` reports a turn number and `read` pages
 * by offset; if one skipped markers and the other did not, "turn 7" would mean a
 * different row in each, and the read-around-a-hit workflow the description
 * promises would land in the wrong place. Returning a marker is also worse than
 * returning nothing: the model is trying to see behind a summary, and a summary
 * is what it would get.
 *
 * BOUNDED, BECAUSE A RECALL THAT RE-INFLATES THE CONTEXT DEFEATS ITS OWN PURPOSE.
 * This runs after compaction, in a conversation that has just been cut down. A
 * search that returned whole page reads would undo the work that made the call
 * necessary.
 */

import { readArchive, type ArchiveEntry } from "../sessions/archive";
import { listSessions } from "../sessions/store";
import {
  listRemoteConversations,
  readRemoteConversation,
  type RemoteConversation,
  type RemoteMessage,
} from "../sessions/sync";

/** Hits returned by one search. */
const DEFAULT_MAX_HITS = 12;
const MAX_HITS_CEILING = 40;
/** Characters of surrounding text shown per hit. */
const SNIPPET_CHARS = 220;
/** Turns returned per `read` page. */
const DEFAULT_READ_LIMIT = 8;
const MAX_READ_LIMIT = 30;
/** Characters per turn in `read` mode — the same bounding argument. */
const READ_TURN_CHARS = 600;
/** Conversations considered when resolving a title fragment. */
const SESSION_LOOKUP_CAP = 20;

export interface RecallArgs {
  query?: string;
  mode?: "search" | "read";
  /**
   * `"this"` (the default), `"all"`, or part of an earlier conversation's title.
   */
  conversation?: string;
  offset?: number;
  limit?: number;
}

export interface RecallContext {
  currentSessionId: string;
  currentTitle?: string;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  const n = Math.floor(Number(value ?? fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), max);
}

/** Collapse an entry to one line around the first match. */
function snippetAround(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return flat.slice(0, SNIPPET_CHARS);
  const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
  const out = flat.slice(start, start + SNIPPET_CHARS);
  return (
    (start > 0 ? "…" : "") + out + (start + SNIPPET_CHARS < flat.length ? "…" : "")
  );
}

/** `conversation · turn N · role` — the address a model can read back. */
function hitPath(title: string, turn: number, entry: ArchiveEntry): string {
  const who = entry.role === "tool" ? `${entry.tool ?? "tool"} result` : entry.role;
  return `${title} · turn ${turn} · ${who}`;
}

interface Target {
  id: string;
  title: string;
  /** Synced from another device: readable, and labelled as such. */
  remote?: boolean;
}

/**
 * Where the history comes from. Injected so a test can drive both halves without
 * a network, and so the local path is exercised with the remote one absent —
 * which is what happens for a signed-out or offline user.
 */
export interface RecallSources {
  listRemote?: () => Promise<RemoteConversation[]>;
  readRemote?: (id: string) => Promise<RemoteMessage[]>;
}

/**
 * A synced conversation, in the shape the local archive uses.
 *
 * A `tool_label` row becomes a `tool` entry whose text IS the label — because
 * that is all that ever left the device. Presenting it as though it were the
 * result would be the egress rule holding in storage and leaking in the read.
 */
function fromRemote(rows: RemoteMessage[]): ArchiveEntry[] {
  return rows.map((r) => ({
    role: r.role === "tool_label" ? ("tool" as const) : r.role === "compaction" ? ("assistant" as const) : r.role,
    text: r.role === "tool_label" ? `(${r.content} — result not synced)` : r.content,
    at: 0,
    ...(r.role === "tool_label" ? { tool: r.content, clipped: true } : {}),
  }));
}

/**
 * Which conversations a call may look at.
 *
 * DEFAULTS TO THE CURRENT ONE, which is the opposite of the desktop's original
 * mistake: there, the "current session" parameter was never actually injected,
 * so a model that correctly omitted it was told there was nothing to search and
 * its only way forward was the WIDER scope. A recall tool whose fallback is
 * everything is a recall tool that leaks between conversations.
 */
async function resolveTargets(
  ctx: RecallContext,
  requested: string | undefined,
  sources: RecallSources,
): Promise<{ targets: Target[]; error?: string }> {
  const current: Target = {
    id: ctx.currentSessionId,
    title: ctx.currentTitle?.trim() || "this conversation",
  };
  const asked = requested?.trim();
  if (!asked || asked.toLowerCase() === "this") return { targets: [current] };

  const sessions = (await listSessions()).slice(0, SESSION_LOOKUP_CAP);
  const local: Target[] = sessions
    .filter((s) => s.id !== current.id)
    .map((s) => ({ id: s.id, title: s.title }));

  // Conversations from this account's OTHER devices — the ones with no local
  // archive at all. A conversation that exists in both places is read locally,
  // because the local archive has excerpts of tool results and the synced copy
  // deliberately does not.
  const known = new Set([current.id, ...local.map((t) => t.id)]);
  const listRemote = sources.listRemote ?? listRemoteConversations;
  const remote: Target[] = (await listRemote())
    .filter((c) => !known.has(c.id))
    .map((c) => ({ id: c.id, title: c.title, remote: true }));

  if (asked.toLowerCase() === "all") {
    return { targets: [current, ...local, ...remote] };
  }

  const all = [current, ...local, ...remote];
  const byId = all.find((s) => s.id === asked);
  if (byId) return { targets: [byId] };

  const needle = asked.toLowerCase();
  const byTitle = all.filter((s) => s.title.toLowerCase().includes(needle));
  if (byTitle.length === 0) {
    return {
      targets: [],
      error:
        `No earlier conversation matches "${asked}". ` +
        `Use conversation:"all" to search every conversation on this device, ` +
        `or leave it out to search only this one.`,
    };
  }
  // The MATCHES THEMSELVES, not rebuilt copies of them. Mapping to
  // `{id, title}` here dropped the `remote` flag, so a synced conversation
  // found by title was then read from a local archive that does not exist —
  // and the tool answered "nothing is recorded" about a conversation it had
  // just located by name.
  return { targets: byTitle };
}

/**
 * Search or read the conversation archive.
 *
 * Returns text for the model. Never throws — a `recall` that fails is a round
 * the model has to recover from, and it recovers better from a sentence saying
 * what went wrong than from an exception ending its turn.
 */
export async function executeRecall(
  args: RecallArgs,
  ctx: RecallContext,
  sources: RecallSources = {},
): Promise<string> {
  const mode = args.mode === "read" ? "read" : "search";
  const { targets, error } = await resolveTargets(ctx, args.conversation, sources);
  const entriesOf = async (target: Target): Promise<ArchiveEntry[]> =>
    target.remote
      ? fromRemote(await (sources.readRemote ?? readRemoteConversation)(target.id))
      : await readArchive(target.id);
  if (error) return error;
  if (targets.length === 0) return "There is nothing recorded to search yet.";

  if (mode === "read") {
    const target = targets[0];
    const entries = await entriesOf(target);
    if (entries.length === 0) {
      return `Nothing is recorded for "${target.title}" yet.`;
    }
    const limit = clamp(args.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
    const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
    const page = entries.slice(offset, offset + limit);
    if (page.length === 0) {
      return `No turns at offset ${offset} in "${target.title}" — it has ${entries.length}.`;
    }
    const lines = page.map((e, i) => {
      const turn = offset + i + 1;
      const text = e.text.replace(/\s+/g, " ").trim();
      const body =
        text.length > READ_TURN_CHARS
          ? `${text.slice(0, READ_TURN_CHARS)}…`
          : text;
      return `${hitPath(target.title, turn, e)}\n${body}`;
    });
    const shown = offset + page.length;
    return (
      `${target.title} — turns ${offset + 1}-${shown} of ${entries.length}\n\n` +
      lines.join("\n\n") +
      (shown < entries.length
        ? `\n\nMore: call recall again with offset ${shown}.`
        : "")
    );
  }

  const query = args.query?.trim();
  if (!query) {
    return "recall needs a query in search mode — a phrase that would appear in what was said.";
  }

  const max = clamp(args.limit, DEFAULT_MAX_HITS, MAX_HITS_CEILING);
  const hits: string[] = [];
  let total = 0;

  for (const target of targets) {
    const entries = await entriesOf(target);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry.text.toLowerCase().includes(query.toLowerCase())) continue;
      total += 1;
      if (hits.length >= max) continue;
      hits.push(
        `${hitPath(target.title, i + 1, entry)}\n${snippetAround(entry.text, query)}` +
          (entry.clipped ? "\n(excerpt — the full result was not kept)" : ""),
      );
    }
  }

  if (total === 0) {
    const where =
      targets.length === 1
        ? `"${targets[0].title}"`
        : `${targets.length} conversations`;
    return (
      `No match for "${query}" in ${where}. ` +
      `Earlier tool results are kept only as excerpts, so something read from a page ` +
      `may not be searchable — read the page again if you need it.`
    );
  }

  return (
    `${total} match${total === 1 ? "" : "es"} for "${query}"` +
    (total > hits.length ? ` (showing ${hits.length})` : "") +
    `\n\n${hits.join("\n\n")}`
  );
}
