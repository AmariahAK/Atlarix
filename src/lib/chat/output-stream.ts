/**
 * Shared helpers for streamed command output.
 *
 * These existed as private copies in two hooks and a tail-cap idiom repeated in
 * three more places. They are collected here because the delta-streaming work
 * needs one definition each — a second `stripAnsi` that handles chunk boundaries
 * differently from the first would be a silent correctness difference, not a
 * style one.
 */

/**
 * Strip ANSI SGR colour sequences.
 *
 * SGR ONLY, deliberately: cursor moves, `\r` redraws and OSC sequences are left
 * alone because the consumers here are line-oriented and a redraw is meaningful
 * liveness (see the `\r` progress-bar case in background-commands.ts).
 *
 * SAFE ACROSS CHUNKS ONLY IF THE INPUT IS WHOLE LINES. An escape sequence can be
 * split by a chunk boundary (`\x1b[3` then `2m`), and neither half matches — so
 * the colour code leaks into the text as visible garbage. It cannot be split by a
 * LINE boundary, because an SGR sequence contains no newline. That is why the
 * delta emitter flushes on line boundaries and holds a trailing partial line:
 * every consumer downstream then sees complete sequences. Cumulative delivery
 * masked this by re-sending the whole buffer each time.
 */
// eslint-disable-next-line no-control-regex -- strip ANSI SGR escape sequences
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_SGR_RE, "");
}

/**
 * Append `lines` to `buf`, keeping only the last `max`.
 *
 * Moved here from `useStreamChat` so the main-side and renderer-side buffers can
 * share one definition of "keep a tail".
 */
export function pushRing(
  buf: readonly string[],
  lines: readonly string[],
  max: number,
): string[] {
  if (max <= 0) return [];
  const next = buf.length ? [...buf, ...lines] : [...lines];
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}

/**
 * How much of a live command's output the UI keeps.
 *
 * The full output is never lost — it stays in the model's tool result
 * (`max_output_bytes`), the Terminal tab's own store (`capTerminalLines`), and
 * `background_jobs`. This bound is only for what the in-chat card holds in React
 * state, which previously grew with the command: a 50 MB build log meant 50 MB
 * retained in the renderer, per command, for as long as the card lived.
 *
 * Chars rather than lines, because the thing being protected is memory and one
 * line of a minified bundle can be megabytes.
 */
export const LIVE_OUTPUT_TAIL_CAP = 256_000;

/**
 * Append a delta to an accumulated string, keeping a bounded tail.
 *
 * Mirrors `appendSubagentOutput` (lib/tools/spawn-task.ts), including the leading
 * ellipsis so a reader can tell the head was dropped rather than never existed.
 */
export function appendCapped(
  existing: string,
  delta: string,
  cap = LIVE_OUTPUT_TAIL_CAP,
): string {
  if (!delta) return existing;
  const combined = existing + delta;
  if (combined.length <= cap) return combined;
  return `…${combined.slice(-cap)}`;
}
