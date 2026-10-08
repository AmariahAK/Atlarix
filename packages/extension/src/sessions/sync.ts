/**
 * Conversations that follow the account rather than the device.
 *
 * Straight PostgREST with the user's own JWT — no Supabase client library,
 * because this package ships no dependencies and the two tables need four verbs
 * between them. RLS on `auth.uid()` is what scopes every request; the extension
 * sends its access token and the database decides what that token can see.
 *
 * ══ THE EGRESS RULE ══
 *
 * RAW TOOL RESULTS NEVER LEAVE THE DEVICE. What syncs is what was SAID — the
 * user's messages, the assistant's replies, and compaction summaries. A tool
 * call syncs as its one-line label and nothing else.
 *
 * The reason that decides it is not size. A page read is the contents of
 * whatever the user was looking at: an inbox, a bank dashboard, a medical
 * portal. There is no version of "helpful cross-device history" that justifies
 * copying that to a server, and it being their own row does not change what it
 * is. That it is also regenerable, and also the bulk, are the two supporting
 * arguments rather than the case.
 *
 * WHERE THE MARKET SITS, checked 2026-09-13 against the BROWSER products rather
 * than the CLIs — the CLIs are the wrong comparison for this and comparing them
 * is how the first version of this comment got it backwards.
 *
 *   Claude in Chrome  — full session sync, and it is exactly this feature:
 *                       "every side panel session appears in your history" and
 *                       "start a session in the side panel and pick it up on the
 *                       web, in Claude Desktop, or on Claude Mobile". What it
 *                       retains of page content is NOT documented; the Dec-2025
 *                       arxiv survey of eight browser agents flagged that as
 *                       unknown for all of them.
 *   ChatGPT Atlas     — page content REACHES their servers, is summarised there,
 *                       and "the original web contents are deleted immediately
 *                       after summarization"; the privacy-filtered summaries go
 *                       within seven days. Memories hold "facts and insights
 *                       from your browsing, but not full page content".
 *   Perplexity Comet  — local-first: data stays on the device until a query
 *                       needs it.
 *
 * So limiting page content IS what the market does, in three different shapes.
 * This is the strict end of that spectrum: content that never leaves cannot be
 * breached, subpoenaed, or quietly retained past a stated window.
 *
 * WHAT A SYNCED CONVERSATION CARRIES, and it is deliberately NOT a browsing log.
 * Compaction markers are one of the four row types that leave the device, and an
 * earlier version of the summary template had a `## Pages and Tabs` section
 * inviting the model to transcribe what each page said. That was a hole straight
 * through this rule — and one the 200-character `tool_label` cap does not cover,
 * because a compaction row is legitimately allowed 40,000 characters.
 *
 * OWNER DECISION, 2026-09-13: the summary is about the USER's thread — what they
 * wanted, what they decided, what they now know — and `context/prompt.ts` now
 * tells it in as many words never to copy page text into itself. An ANSWER the
 * user asked for is not page content: "the Pro plan is $19 a month" is the thing
 * they wanted, and where it was written is incidental.
 *
 * `syncableRows` below is the projection, and it is a pure function on purpose
 * so a test can assert the rule directly rather than by inspecting a request.
 * The DATABASE enforces it too — `content_length_by_role` caps a `tool_label`
 * row at 200 characters, so a page snapshot is refused by the column rather than
 * by this file's good intentions. Both halves exist because either alone is a
 * rule that holds until someone writes a second caller.
 *
 * ══ WHAT THIS IS NOT ══
 *
 * Not a two-way merge. `chrome.storage.local` remains the working copy for this
 * device and the server is a shared, lossy record of what was said. Reading a
 * conversation from another device gives the model what was said there, which is
 * exactly what `recall` needs and is not enough to resume a turn from — and
 * pretending otherwise would mean resolving edit conflicts on a transcript,
 * which nobody asked for.
 */

import { peerSurfaceLabel, splitPeerMessages } from "@/lib/peers/peer-message";
import { GOTRUE } from "../auth/config";
import { getAccessToken } from "../auth/sign-in";
import { getSession } from "../auth/sign-in";
import type { CoreMessage } from "../core/client";
import { saidText } from "../panel/attachments";
import { isCompactionMarker, markerBody } from "../context/compact";

/** Mirrors the `role` CHECK on `conversation_messages`. */
export type SyncRole = "user" | "assistant" | "tool_label" | "compaction";

export interface SyncRow {
  role: SyncRole;
  content: string;
  seq: number;
}

/** Mirrors `content_length_by_role`. Clipped here so a write cannot be rejected. */
const MAX_LABEL_CHARS = 200;
const MAX_SAID_CHARS = 40_000;

/**
 * What a transcript looks like once the egress rule has been applied.
 *
 * A PURE FUNCTION, and that is the point: the rule is a thing a test can hold in
 * its hand, rather than something inferred from what a request happened to
 * contain on the day it was written.
 *
 * `seq` is the index in the ORIGINAL transcript, not in the output. Two devices
 * syncing the same conversation must agree on which row is which, and a position
 * that shifts when a tool result is skipped is a position that collides.
 */
export function syncableRows(
  messages: CoreMessage[],
  labelFor?: (toolCallId: string) => string | undefined,
): SyncRow[] {
  const out: SyncRow[] = [];
  messages.forEach((m, seq) => {
    if (isCompactionMarker(m)) {
      out.push({
        role: "compaction",
        content: markerBody(m.content).slice(0, MAX_SAID_CHARS),
        seq,
      });
      return;
    }
    if (m.role === "user") {
      // `saidText`, NOT `userText`. The bytes of a file the user attached are
      // exactly as private as a page the agent read, and the egress rule has no
      // exception for things the user chose.
      //
      // This line used to call `userText`, whose own comment says it collapses
      // an attachment to its name — true of an image and a PDF, never true of a
      // TEXT file, which is itself a text part and so was returned in full and
      // synced up to the 40,000-character cap. A stated rule enforced by the
      // wrong function reads exactly like a rule that holds.
      const text = saidText(m.content);
      // A TASK ANOTHER SESSION HANDED OVER syncs as who sent it, never as its
      // text: it was written on the user's machine, from their workspace, and
      // may quote code or files that were never meant to leave it.
      const peer = splitPeerMessages(text);
      if (peer) {
        const heads = peer
          .filter((s) => s.kind === "peer")
          .map((s) => `Message from ${s.from || "another session"} (${peerSurfaceLabel(s.surface)})`);
        out.push({ role: "user", content: heads.join("\n").slice(0, MAX_SAID_CHARS), seq });
        return;
      }
      if (text.trim()) {
        out.push({ role: "user", content: text.slice(0, MAX_SAID_CHARS), seq });
      }
      return;
    }
    if (m.role === "assistant") {
      if (m.content?.trim()) {
        out.push({
          role: "assistant",
          content: m.content.slice(0, MAX_SAID_CHARS),
          seq,
        });
      }
      return;
    }
    if (m.role === "tool") {
      // THE RULE, IN ONE LINE. The label, or a generic one — never `m.content`.
      const label = labelFor?.(m.tool_call_id)?.trim();
      out.push({
        role: "tool_label",
        content: (label || "Used a tool").slice(0, MAX_LABEL_CHARS),
        seq,
      });
    }
    // `system` is not a message anybody sent; it is rebuilt every turn.
  });
  return out;
}

/** A tool call id → the label the panel showed for it. */
export function labelsFrom(messages: CoreMessage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const c of m.tool_calls ?? []) {
      // The tool's name is a safe label on its own; the panel's nicer one is
      // passed in when the caller has it.
      out.set(c.id, c.function.name);
    }
  }
  return out;
}

/* ── PostgREST ────────────────────────────────────────────────────────────── */

function restUrl(path: string): string {
  return `${GOTRUE.url.replace(/\/+$/, "")}/rest/v1/${path}`;
}

async function restHeaders(
  extra: Record<string, string> = {},
): Promise<Record<string, string> | null> {
  const token = await getAccessToken();
  if (!token) return null;
  return {
    apikey: GOTRUE.anonKey,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

/** The signed-in user's id, which every row must carry for RLS to accept it. */
async function currentUserId(): Promise<string | null> {
  return (await getSession())?.user?.id ?? null;
}

export interface RemoteConversation {
  id: string;
  title: string;
  updatedAt: number;
}

export interface RemoteMessage {
  role: SyncRole;
  content: string;
  seq: number;
}

/**
 * Push a conversation's sayable content.
 *
 * FAILS SILENTLY AND RETURNS FALSE. Sync is a convenience running alongside a
 * conversation that is already saved locally and already on screen; an offline
 * laptop, an expired token or a Supabase blip must not put an error in front of
 * someone who is mid-sentence. The local copy is the one that matters.
 *
 * The upsert is keyed on `(conversation_id, seq)`, so re-syncing a conversation
 * after another round replaces the rows it already wrote rather than doubling
 * them — which is also what makes calling this after every turn safe.
 */
export async function pushConversation(params: {
  id: string;
  title: string;
  messages: CoreMessage[];
  labelFor?: (toolCallId: string) => string | undefined;
}): Promise<boolean> {
  try {
    const userId = await currentUserId();
    const headers = await restHeaders({ Prefer: "resolution=merge-duplicates" });
    if (!userId || !headers) return false;

    const meta = await fetch(restUrl("conversations"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: params.id,
        user_id: userId,
        title: params.title.slice(0, 200),
        surface: "extension",
        updated_at: new Date().toISOString(),
      }),
    });
    if (!meta.ok) return false;

    const rows = syncableRows(params.messages, params.labelFor);
    if (rows.length === 0) return true;

    const res = await fetch(
      restUrl("conversation_messages?on_conflict=conversation_id,seq"),
      {
        method: "POST",
        headers,
        body: JSON.stringify(
          rows.map((r) => ({
            conversation_id: params.id,
            user_id: userId,
            role: r.role,
            content: r.content,
            seq: r.seq,
          })),
        ),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Conversations on the account, newest first. Empty on any failure. */
export async function listRemoteConversations(
  limit = 20,
): Promise<RemoteConversation[]> {
  try {
    const headers = await restHeaders();
    if (!headers) return [];
    const res = await fetch(
      restUrl(
        `conversations?select=id,title,updated_at&order=updated_at.desc&limit=${limit}`,
      ),
      { headers },
    );
    if (!res.ok) return [];
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return [];
    return body
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map((r) => ({
        id: String(r.id ?? ""),
        title: String(r.title ?? ""),
        updatedAt: Date.parse(String(r.updated_at ?? "")) || 0,
      }))
      .filter((r) => r.id);
  } catch {
    return [];
  }
}

/** One conversation's synced content, in order. Empty on any failure. */
export async function readRemoteConversation(
  id: string,
): Promise<RemoteMessage[]> {
  try {
    const headers = await restHeaders();
    if (!headers) return [];
    const res = await fetch(
      restUrl(
        `conversation_messages?select=role,content,seq&conversation_id=eq.${encodeURIComponent(id)}&order=seq.asc`,
      ),
      { headers },
    );
    if (!res.ok) return [];
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return [];
    return body
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map((r) => ({
        role: String(r.role ?? "user") as SyncRole,
        content: String(r.content ?? ""),
        seq: Number(r.seq ?? 0),
      }));
  } catch {
    return [];
  }
}

/** Remove a conversation from the account. Messages cascade. */
export async function deleteRemoteConversation(id: string): Promise<void> {
  try {
    const headers = await restHeaders();
    if (!headers) return;
    await fetch(
      restUrl(`conversations?id=eq.${encodeURIComponent(id)}`),
      { method: "DELETE", headers },
    );
  } catch {
    // The local copy is already gone, which is what the user asked for.
  }
}
