/**
 * What the agent remembers about the user between conversations.
 *
 * DEVICE-LOCAL, IN `storage.local`, AND NOT SYNCED — a deliberate split from
 * site grants, which live in `storage.sync` because they are a decision about
 * this person's browsing that should follow them to another machine. Memories
 * are different: `storage.sync` has a 8 KB-per-item and 100 KB-total quota that
 * this would blow through, and it replicates to every signed-in Chrome profile,
 * including a shared one. Server-side memory across devices is Phase 4's job
 * and belongs behind the account, not behind Chrome Sync.
 *
 * TREAT WHAT IS READ BACK AS UNTRUSTED. `site-grants.ts` records the reason at
 * length and it applies here identically: `storage.local` is a LevelDB
 * directory any local process running as the user can rewrite. So every read
 * validates shape and drops anything malformed rather than throwing six frames
 * away, in a prompt builder, on some later turn.
 *
 * THE CAP IS 50 AND IT IS ABOUT THE PROMPT, NOT THE DISK. Every fact is
 * injected into the system prompt of every conversation, so this store's size
 * is a per-turn token cost the user never sees and cannot easily explain. Fifty
 * one-sentence facts is a few hundred tokens; five hundred would quietly become
 * the largest thing in the prompt.
 */

import { api } from "../shared/browser-api";

const KEY = "atlarix.memory.v1";

/** Facts injected into every system prompt, so this bounds a recurring cost. */
export const MAX_FACTS = 50;

/** Long enough for a real sentence, short enough that fifty of them are cheap. */
export const MAX_FACT_LENGTH = 280;

export interface Memory {
  id: string;
  text: string;
  /** Epoch ms. Used only to decide what to evict. */
  createdAt: number;
}

interface Stored {
  facts: Memory[];
}

function isMemory(value: unknown): value is Memory {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.text === "string" &&
    m.text.length > 0 &&
    typeof m.createdAt === "number"
  );
}

/** Every remembered fact, oldest first. Never throws. */
export async function listMemories(): Promise<Memory[]> {
  try {
    const bag = await api().storage.local.get<Record<string, unknown>>(KEY);
    const raw = (bag?.[KEY] as Stored | undefined)?.facts;
    return Array.isArray(raw) ? raw.filter(isMemory) : [];
  } catch {
    return [];
  }
}

/** Compare on content, not on identity — same sentence, different spacing. */
function normalise(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export type RememberOutcome =
  | { kind: "saved"; memory: Memory; evicted?: Memory }
  | { kind: "duplicate"; memory: Memory }
  | { kind: "rejected"; reason: string };

/**
 * Save one fact.
 *
 * EVICTION IS REPORTED, NEVER SILENT. At the cap the oldest fact goes, and the
 * caller is handed what was dropped so the tool result can say which — a memory
 * store that quietly forgets is worse than one that refuses, because the user
 * finds out weeks later by being asked something they already answered.
 */
export async function remember(text: string): Promise<RememberOutcome> {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return { kind: "rejected", reason: "an empty fact is not a fact" };
  }
  if (trimmed.length > MAX_FACT_LENGTH) {
    return {
      kind: "rejected",
      reason: `a memory must be at most ${MAX_FACT_LENGTH} characters (this was ${trimmed.length}) — save the durable part, not the transcript`,
    };
  }

  const facts = await listMemories();
  const existing = facts.find((f) => normalise(f.text) === normalise(trimmed));
  if (existing) return { kind: "duplicate", memory: existing };

  const memory: Memory = {
    // `crypto.randomUUID` is available in every extension context this runs in
    // and needs no permission; the timestamp alone would collide on two facts
    // saved in the same millisecond, which a single turn can do.
    id: crypto.randomUUID(),
    text: trimmed,
    createdAt: Date.now(),
  };

  const next = [...facts, memory];
  const evicted = next.length > MAX_FACTS ? next.shift() : undefined;
  await api().storage.local.set({ [KEY]: { facts: next } satisfies Stored });
  return { kind: "saved", memory, evicted };
}

/** Drop one fact. False when there was nothing with that id. */
export async function forget(id: string): Promise<boolean> {
  const facts = await listMemories();
  const next = facts.filter((f) => f.id !== id);
  if (next.length === facts.length) return false;
  await api().storage.local.set({ [KEY]: { facts: next } satisfies Stored });
  return true;
}

export async function forgetAll(): Promise<void> {
  await api().storage.local.remove(KEY);
}
