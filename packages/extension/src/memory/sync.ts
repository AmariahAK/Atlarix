/**
 * Notes, across a user's devices — and to the launchpad, where they can read
 * and edit them.
 *
 * WHY NOTES MAY LEAVE THE DEVICE WHEN PAGE CONTENT MAY NOT. The egress rule is
 * about what the agent READ, not about what the user IS. Notes are the second
 * category, which is exactly the one that is supposed to sync — and the one
 * whose value depends on syncing, since a memory that only exists on one laptop
 * is a memory the product appears to lose. The four layers that keep page
 * content OUT of a note are in `egress.ts` and the migration; this file assumes
 * they held.
 *
 * ONE WRITE PATH, AND IT IS AN RPC. `save_extension_note` performs a
 * compare-and-swap on `rev`. The launchpad calls the same function — its
 * `types.ts` makes a direct client write a compile error by design, so it needs
 * one anyway, and TWO write paths would mean the CAS holds on one of them.
 * That is the same failure class as a policy without a grant: correct-looking
 * and silently ineffective.
 *
 * `Prefer: resolution=merge-duplicates`, which `sessions/sync.ts` uses, is NOT
 * usable here: it is an unconditional overwrite and cannot express a CAS. A
 * transcript has one writer and is append-only; a note has two writers editing
 * the same field.
 *
 * ══ TRANSPORT FAILURE IS SILENT. SEMANTIC REJECTION IS NOT. ══
 *
 * This is the one place the extension's silent-failure convention must not
 * apply wholesale, and the reason is worth stating so nobody "fixes" it back.
 * `pushConversation` returns false quietly because the local copy is
 * authoritative and the server is a lossy record of a transcript nobody edits.
 * A note has two editors and the server is the shared truth, so "your write did
 * not land" is information the user needs.
 *
 * So: offline, an expired token, a 500 — still silent, still `false`, still
 * nothing in front of someone mid-sentence. A `stale` rejection is different
 * and is reported, because something the user or the model actually wrote is
 * about to be lost otherwise.
 */

import { GOTRUE } from "../auth/config";
import { getAccessToken } from "../auth/sign-in";
import {
  DESCRIPTION_MAX,
  NOTE_MAX_BYTES,
  TITLE_MAX,
  byteLength,
} from "./limits";
import {
  deleteNote,
  listNotes,
  markNoteSynced,
  readNote,
  saveNote,
  type Note,
  type NoteMeta,
} from "./notes";

/** Mirrors the row `extension_notes` returns. */
export interface RemoteNote {
  name: string;
  title: string;
  description: string;
  type: string;
  body: string;
  rev: number;
  deleted_at: string | null;
  updated_at: string;
}

function restUrl(path: string): string {
  return `${GOTRUE.url.replace(/\/+$/, "")}/rest/v1/${path}`;
}

async function restHeaders(): Promise<Record<string, string> | null> {
  const token = await getAccessToken();
  if (!token) return null;
  return {
    apikey: GOTRUE.anonKey,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/**
 * What a note looks like once it is safe to send.
 *
 * PURE, for the reason `syncableRows` is pure: a test asserts the rule directly
 * rather than by inspecting a request. Every field is clipped to the DB's own
 * limit so a write can never be REJECTED for a length — both halves exist
 * because either alone holds only until someone writes a second caller.
 *
 * A DELETE NEVER COMES THROUGH HERE. `delete_extension_note` tombstones the row
 * and clears the body server-side, with a CHECK enforcing that a tombstone keeps
 * no text — so this function only ever describes a note that still exists.
 */
export function noteRowFor(note: Note): Record<string, unknown> {
  return {
    name: note.name,
    title: note.title.slice(0, TITLE_MAX),
    description: note.description.slice(0, DESCRIPTION_MAX),
    type: note.type,
    body: clipToBytes(note.body, NOTE_MAX_BYTES),
    rev: note.rev,
  };
}

/** Trim to a BYTE budget without splitting a character in half. */
function clipToBytes(s: string, max: number): string {
  if (byteLength(s) <= max) return s;
  let out = s;
  while (out.length > 0 && byteLength(out) > max) {
    out = out.slice(0, Math.max(0, Math.floor(out.length * 0.9)));
  }
  return out;
}

export type PushOutcome =
  | { kind: "ok"; rev: number }
  /** The server has a newer version. Something written is about to be lost. */
  | { kind: "stale"; remote: RemoteNote }
  /** Offline, signed out, refused. Silent by design — the local copy stands. */
  | { kind: "failed" };

/** Push one note. Never throws. */
export async function pushNote(name: string): Promise<PushOutcome> {
  try {
    const note = await readNote(name);
    if (!note) return { kind: "failed" };
    const headers = await restHeaders();
    if (!headers) return { kind: "failed" };

    const res = await fetch(restUrl("rpc/save_extension_note"), {
      method: "POST",
      headers,
      body: JSON.stringify({ p_input: noteRowFor(note) }),
    });
    if (!res.ok) return { kind: "failed" };

    const out = (await res.json()) as {
      ok?: boolean;
      reason?: string;
      rev?: number;
      note?: RemoteNote;
    };
    if (out.ok && typeof out.rev === "number") {
      // Record what the server confirmed, so `rev > syncedRev` stays an exact
      // "this device has unpushed edits" test.
      await markNoteSynced(note.name, note.rev, out.rev);
      return { kind: "ok", rev: out.rev };
    }
    if (out.reason === "stale" && out.note) {
      return { kind: "stale", remote: out.note };
    }
    return { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

/** Every note on the account. `[]` on any failure — never throws. */
export async function pullNotes(): Promise<RemoteNote[]> {
  try {
    const headers = await restHeaders();
    if (!headers) return [];
    const res = await fetch(
      restUrl(
        "extension_notes?select=name,title,description,type,body,rev,deleted_at,updated_at&order=updated_at.desc",
      ),
      { headers },
    );
    if (!res.ok) return [];
    const rows: unknown = await res.json();
    return Array.isArray(rows) ? (rows as RemoteNote[]) : [];
  } catch {
    return [];
  }
}

export type Reconciliation =
  | { action: "take-remote"; remote: RemoteNote }
  | { action: "push-local"; name: string }
  | { action: "conflict"; name: string; siblingName: string; remote: RemoteNote }
  | { action: "delete-local"; name: string }
  | { action: "none" };

/**
 * What to do about one note, given both copies.
 *
 * PURE so the table below is a test rather than a description. `rev >
 * syncedRev` means "this device has edits the server has not seen" — exact, and
 * needing no body hash, because `rev` only ever increments on a local write.
 *
 * THE CONFLICT CASE KEEPS BOTH. Remote lands as a sibling note rather than
 * overwriting, which costs a note slot and shows up in the index — and that is
 * the point: it is visible, the model or the user merges it, and nobody's
 * writing is thrown away. Silent last-write-wins on something a person typed is
 * the one failure this store cannot afford.
 */
export function reconcileNote(
  local: NoteMeta | undefined,
  remote: RemoteNote | undefined,
): Reconciliation {
  if (!remote) {
    if (!local) return { action: "none" };
    return local.rev > local.syncedRev
      ? { action: "push-local", name: local.name }
      : { action: "none" };
  }

  if (!local) {
    return remote.deleted_at
      ? { action: "none" }
      : { action: "take-remote", remote };
  }

  const dirty = local.rev > local.syncedRev;

  if (remote.deleted_at) {
    // A tombstone loses to a local edit: the user wrote something here after
    // the delete, and honouring the delete would discard it.
    return dirty
      ? { action: "push-local", name: local.name }
      : { action: "delete-local", name: local.name };
  }

  if (remote.rev > local.syncedRev && dirty) {
    return {
      action: "conflict",
      name: local.name,
      siblingName: siblingNameFor(local.name),
      remote,
    };
  }
  if (remote.rev > local.rev) return { action: "take-remote", remote };
  if (dirty) return { action: "push-local", name: local.name };
  return { action: "none" };
}

/** `preferences` → `preferences-from-web`, bounded so it stays a legal name. */
export function siblingNameFor(name: string): string {
  return `${name}-from-web`.slice(0, 32).replace(/-+$/, "");
}

/**
 * Reconcile everything, applying what is safe to apply.
 *
 * Returns the names that CONFLICTED, so the caller can tell the model — the
 * only actor in the loop that can merge prose.
 */
export async function syncNotes(): Promise<{ conflicts: string[] }> {
  const conflicts: string[] = [];
  try {
    const remote = await pullNotes();
    const byName = new Map(remote.map((r) => [r.name, r]));
    const local = await listNotes();
    const names = new Set([
      ...local.map((n) => n.name),
      ...remote.map((r) => r.name),
    ]);

    for (const name of names) {
      const plan = reconcileNote(
        local.find((n) => n.name === name),
        byName.get(name),
      );
      switch (plan.action) {
        case "take-remote":
          await applyRemote(plan.remote);
          break;
        case "push-local":
          await pushNote(plan.name);
          break;
        case "delete-local":
          await deleteNote(plan.name);
          break;
        case "conflict":
          await applyRemote({ ...plan.remote, name: plan.siblingName });
          conflicts.push(plan.name);
          await pushNote(plan.name);
          break;
        case "none":
          break;
      }
    }
  } catch {
    // Sync is a convenience alongside a local store that already works.
  }
  return { conflicts };
}

async function applyRemote(remote: RemoteNote): Promise<void> {
  const written = await saveNote({
    name: remote.name,
    title: remote.title,
    description: remote.description,
    type: (remote.type as Note["type"]) ?? "user",
    body: remote.body,
  });
  // Clean on arrival: this copy came FROM the server, so it has no unpushed
  // edits and must not be pushed straight back.
  await markNoteSynced(remote.name, written.rev, remote.rev);
}
