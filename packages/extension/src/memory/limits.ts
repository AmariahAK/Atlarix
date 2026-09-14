/**
 * What bounds the notes store, and what each bound is actually protecting.
 *
 * TWO DIFFERENT BUDGETS LIVE HERE AND THEY MUST NOT BE CONFUSED. `MAX_NOTES`
 * and the three length caps are a PROMPT budget: the index has one line per
 * note and rides every round of every turn, so raising them raises a recurring
 * token cost nobody sees. `NOTES_TOTAL_MAX_BYTES` and `NOTE_MAX_BYTES` are a
 * DISK budget against `chrome.storage.local`. A change to one is not a licence
 * to change the other.
 *
 * The old store said the same thing about `MAX_FACTS = 50` and it was the most
 * useful sentence in the file, so it is repeated rather than inherited.
 */

/**
 * The most one note may hold. The owner's figure.
 *
 * ~6,500 tokens if it were ever pasted whole — more than this extension's
 * ENTIRE per-round overhead (~4,100), which is why a body is never injected and
 * why `prompt.test.ts` has a test whose only job is to prove it.
 */
export const NOTE_MAX_BYTES = 26 * 1024;

/** Where refinement starts. Below this a write is silent; above it, it says so. */
export const NOTE_NUDGE_RATIO = 0.8;

/**
 * How many notes may exist.
 *
 * THIS IS THE NUMBER THAT COSTS MONEY. At the length caps below, a worst-case
 * index line is ~185 characters ≈ 46 tokens, so 30 notes is ~1,390 tokens per
 * round and a realistic dozen is ~550. For comparison the old store's typical
 * cost was ~375 and its worst case ~3,500. **This is a win at the tail and a
 * small loss on average** — bought for capability and for making the cost
 * knowable, not for making it smaller. Do not raise it expecting it to be free.
 */
export const MAX_NOTES = 30;

/** Where the index starts asking for merges rather than refusing writes. */
export const NOTES_NUDGE_COUNT = 24;

/**
 * The whole store's ceiling.
 *
 * `chrome.storage.local` is ~10 MB for EVERYTHING, and most of it is already
 * committed: `sessions/archive.ts` budgets 20 sessions × 200,000 chars of
 * archive, plus the live transcripts. 512 KB is ~5% of the total and roughly
 * 20× what this store will realistically hold.
 *
 * NOTE THE TOTAL BINDS BEFORE THE COUNT — 30 × 26 KB is 780 KB, well over this.
 * That is deliberate: the per-note cap shapes one note, the total bounds the
 * store, and when a user hits a wall it should be obvious which wall it was.
 */
export const NOTES_TOTAL_MAX_BYTES = 512 * 1024;

/** Slug, title, description. These three are what make the index's worst case knowable. */
export const NAME_MAX = 32;
export const TITLE_MAX = 48;
export const DESCRIPTION_MAX = 96;

/**
 * UTF-8 byte length.
 *
 * `TextEncoder`, NEVER `Buffer.byteLength`. `no-node-globals.test.ts` exists
 * because jsdom-under-vitest leaves `Buffer` defined, so the Node version would
 * pass the whole suite and then fail in Chrome, where `Buffer` does not exist.
 */
const encoder = new TextEncoder();
export function byteLength(s: string): number {
  return encoder.encode(s).length;
}
