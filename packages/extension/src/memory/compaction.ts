/**
 * Whether the notes store is getting full, and what to say about it.
 *
 * PURE — no `chrome.storage`, no clock, no I/O. That is what lets a test hold
 * the thresholds in its hand rather than driving a fake storage area to reach
 * them, and it is why the desktop's equivalent (`planMemoryCompaction`) is pure
 * too. The signature is deliberately recognisable as that function's sibling.
 *
 * THE OUTPUT IS A FLAG, NOT A LESSON. The desktop's first version of this
 * explained itself in the prompt and cost 147 tokens on every single turn for
 * advice that was relevant on almost none of them. What survives is a clause
 * short enough to ride the header line it already pays for.
 *
 * WHERE THIS DIVERGES FROM THE DESKTOP, and why it has to: there, nothing is
 * ever refused — the filesystem has room and compaction is a nudge. Here the
 * store is a slice of a ~10 MB quota shared with transcripts and archives, so
 * a write CAN be refused. What must never be refused is the TURN.
 */

import {
  MAX_NOTES,
  NOTES_NUDGE_COUNT,
  NOTES_TOTAL_MAX_BYTES,
  NOTE_MAX_BYTES,
  NOTE_NUDGE_RATIO,
} from "./limits";
import type { NoteMeta } from "./notes";

export interface NotesState {
  notes: NoteMeta[];
  /**
   * The write about to happen, if any.
   *
   * COUNTS AS PROGRESS ON THIS VERY CALL — the desktop's `pendingWrite` idea,
   * and the thing that makes a full store recoverable. A rewrite that SHRINKS a
   * note must succeed even at the cap, or the only way out of "full" is
   * deleting something, and the model will delete the wrong thing.
   */
  pendingWrite?: { name: string; bytes: number };
}

export interface NotesPlan {
  totalBytes: number;
  noteCount: number;
  /** True once the store is at a hard limit. */
  full: boolean;
  /** The largest notes, for a merge suggestion. */
  targets: NoteMeta[];
  /** A terse clause for the prompt header, or "" when there is nothing to say. */
  flag: string;
}

/** Totals with the pending write applied — an update replaces, it does not add. */
function projected(state: NotesState): { bytes: number; count: number } {
  const pending = state.pendingWrite;
  let bytes = 0;
  let count = 0;
  let replaced = false;
  for (const n of state.notes) {
    if (pending && n.name === pending.name) {
      bytes += pending.bytes;
      replaced = true;
    } else {
      bytes += n.bytes;
    }
    count += 1;
  }
  if (pending && !replaced) {
    bytes += pending.bytes;
    count += 1;
  }
  return { bytes, count };
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Returns null when there is nothing worth saying — which is the common case,
 * and the reason the header costs nothing until it matters.
 */
export function planNotesCompaction(state: NotesState): NotesPlan | null {
  const { bytes, count } = projected(state);
  const full = count > MAX_NOTES || bytes > NOTES_TOTAL_MAX_BYTES;
  const nearing =
    count >= NOTES_NUDGE_COUNT || bytes >= NOTES_TOTAL_MAX_BYTES * NOTE_NUDGE_RATIO;
  if (!full && !nearing) return null;

  const targets = [...state.notes].sort((a, b) => b.bytes - a.bytes).slice(0, 3);
  const names = targets.map((t) => `${t.name}.md`).join(", ");
  const flag = full
    ? `FULL: merge ${names}`
    : `getting full — consider merging ${names}`;

  return { totalBytes: bytes, noteCount: count, full, targets, flag };
}

export type WriteVerdict =
  | { ok: true; nudge?: string }
  | { ok: false; reason: string };

/**
 * May this write proceed, and what should the model be told either way?
 *
 * THE REFUSAL NAMES THE NOTE AND THE OVERAGE, both required: "a limit it cannot
 * see is a limit it will hit and not understand", and a model told only "too
 * big" will retry at the same size or give up on the note entirely.
 *
 * A FULL STORE STILL TAKES A REWRITE. That is the ChatGPT behaviour the owner
 * asked for — say you are full, keep working — and it is also the only escape
 * hatch: at 30 notes, merging two into one is a write that must succeed while
 * full, because it is the thing that fixes being full.
 */
export function checkWrite(
  state: NotesState,
  write: { name: string; bytes: number },
): WriteVerdict {
  if (write.bytes > NOTE_MAX_BYTES) {
    const over = write.bytes - NOTE_MAX_BYTES;
    return {
      ok: false,
      reason:
        `Not saved — ${write.name}.md would be ${kb(write.bytes)}, which is ` +
        `${kb(over)} over the ${kb(NOTE_MAX_BYTES)} limit for one note. Cut ` +
        `${kb(over)} and write it again.`,
    };
  }

  const before = projected({ notes: state.notes });
  const after = projected({ ...state, pendingWrite: write });
  const isNew = !state.notes.some((n) => n.name === write.name);
  const shrinks = after.bytes <= before.bytes;

  // A rewrite that does not grow the store is ALWAYS allowed, full or not.
  if (!isNew && shrinks) return { ok: true, nudge: nudgeFor(state, write) };

  if (after.count > MAX_NOTES) {
    const targets = [...state.notes]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 3)
      .map((t) => `${t.name}.md (${kb(t.bytes)})`)
      .join(", ");
    return {
      ok: false,
      reason:
        `Not saved — you have ${state.notes.length} notes, which is the limit ` +
        `of ${MAX_NOTES}. Merge two of these and try again: ${targets}. ` +
        `Rewriting a note you already have still works.`,
    };
  }

  if (after.bytes > NOTES_TOTAL_MAX_BYTES) {
    const over = after.bytes - NOTES_TOTAL_MAX_BYTES;
    return {
      ok: false,
      reason:
        `Not saved — that would put your notes ${kb(over)} over the ` +
        `${kb(NOTES_TOTAL_MAX_BYTES)} total. Shorten this one, or merge two ` +
        `existing notes first.`,
    };
  }

  return { ok: true, nudge: nudgeFor(state, write) };
}

/** Said on a SUCCESSFUL write that is getting close. Refinement, not failure. */
function nudgeFor(
  state: NotesState,
  write: { name: string; bytes: number },
): string | undefined {
  if (write.bytes >= NOTE_MAX_BYTES * NOTE_NUDGE_RATIO) {
    return (
      `${write.name}.md is now ${kb(write.bytes)} of the ` +
      `${kb(NOTE_MAX_BYTES)} limit — tighten it the next time you touch it.`
    );
  }
  const plan = planNotesCompaction({ ...state, pendingWrite: write });
  return plan?.flag ? `Your notes are ${plan.flag}.` : undefined;
}
