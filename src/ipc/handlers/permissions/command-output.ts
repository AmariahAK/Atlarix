/**
 * Formatting a finished command's output for the model.
 *
 * Extracted from `PermissionInterceptor` (v14.26.0), which had grown to 2,128
 * lines — 40% of the whole permission surface — with pure text handling like
 * this sitting in the same class as approval lifecycle, path containment and
 * sandbox escalation. Nothing here touches interceptor state, so it is testable
 * without constructing one; before the move it had no direct coverage at all,
 * despite being what every non-trivial command result passes through on its way
 * into the context window.
 *
 * Behaviour is unchanged from the method it replaces.
 */

/** Fallback when a run_command preview names no cap of its own. */
const DEFAULT_MAX_OUTPUT_BYTES = 80_000;
const MIN_MAX_OUTPUT_BYTES = 1024;
const MAX_MAX_OUTPUT_BYTES = 1_000_000;

/**
 * Clamp a model-supplied `max_output_bytes` into a sane range.
 *
 * Note `Number(raw) || DEFAULT` runs BEFORE the clamp, so a `0` or unparseable
 * value lands on the default rather than on the 1024 floor — a command that
 * asked for nothing gets the normal budget, not a near-empty one.
 */
export function resolveMaxOutputBytes(raw: number | undefined): number {
  return Math.min(
    MAX_MAX_OUTPUT_BYTES,
    Math.max(MIN_MAX_OUTPUT_BYTES, Number(raw) || DEFAULT_MAX_OUTPUT_BYTES),
  );
}

function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Appended after a cut. Names `max_output_bytes` deliberately — it is a
 * parameter the model can raise on its next call, so the notice is actionable
 * rather than merely informative.
 */
const TRUNCATION_NOTICE =
  "\n\n… [truncated: output exceeded max_output_bytes; pass a higher max_output_bytes or a narrower command]";

/**
 * Headroom reserved for the notice, measured rather than guessed.
 *
 * The extracted version hardcoded 80 while the notice is 105 bytes (its `…` is
 * a 3-byte U+2026), so every truncated result overshot `max_output_bytes` by 25
 * bytes — the cap silently did not hold. Found by the characterization test
 * written before this move, not by reading the code.
 */
const NOTICE_BYTES = Buffer.byteLength(TRUNCATION_NOTICE, "utf8");

/**
 * Back a byte offset up to the nearest UTF-8 rune boundary.
 *
 * Cutting a Buffer at an arbitrary offset can land inside a multibyte sequence,
 * and `toString("utf8")` then renders that partial sequence as U+FFFD — which is
 * itself 3 bytes, so the result is BOTH corrupted and larger than the cut it
 * replaced. Continuation bytes are `10xxxxxx`, so walking back while the byte at
 * the cut point is one lands on a lead byte or an ASCII byte, either of which is
 * a safe place to stop.
 */
function utf8BoundaryBefore(buf: Buffer, offset: number): number {
  let end = Math.min(offset, buf.length);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return end;
}

/**
 * Cut to a UTF-8 BYTE budget, not a character count.
 *
 * The budget is a real ceiling: the notice's own length is reserved, and the cut
 * is pulled back to a rune boundary, so the returned string never exceeds
 * `maxBytes` and never ends in a broken glyph.
 */
function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  const budget = Math.max(0, maxBytes - NOTICE_BYTES);
  const cut = buf.subarray(0, utf8BoundaryBefore(buf, budget));
  return cut.toString("utf8") + TRUNCATION_NOTICE;
}

/**
 * Format command output with smart truncation for AI context.
 *
 * Under the cap the output is passed through verbatim — the model reads a real
 * error better than any summary of one. Over the cap it is rebuilt as
 * errors → warnings → first 5 lines → last 5 lines, on the reasoning that a
 * failing command's diagnostic lines matter more than its progress spam, and
 * then byte-capped.
 *
 * The truncation notice names `max_output_bytes` deliberately: it is a parameter
 * the model can raise on the next call, so the message is actionable rather than
 * merely informative.
 */
export function formatCommandOutput(
  stdout: string,
  stderr: string,
  maxOutputBytes: number,
): string {
  const hasOut = Boolean(stdout?.trim());
  const hasErr = Boolean(stderr?.trim());
  // Only label the streams when BOTH have content — a lone stdout reaching the
  // model wrapped in ceremony is noise on every successful command.
  const combined =
    hasOut && hasErr
      ? `=== STDOUT ===\n${stdout}\n\n=== STDERR ===\n${stderr}`
      : stdout || stderr || "";

  if (!combined.trim()) return "(no output)";
  if (utf8ByteLength(combined) <= maxOutputBytes) return combined;

  const lines = combined.split("\n");
  const errors = lines.filter(
    (l) =>
      l.toLowerCase().includes("error") ||
      l.toLowerCase().includes("failed") ||
      l.includes("✗") ||
      l.includes("ERR!"),
  );
  const warnings = lines.filter(
    (l) => l.toLowerCase().includes("warn") || l.includes("⚠"),
  );

  let summary = "";
  if (errors.length > 0) {
    summary += "=== ERRORS ===\n" + errors.slice(0, 10).join("\n") + "\n\n";
  }
  if (warnings.length > 0) {
    summary += "=== WARNINGS ===\n" + warnings.slice(0, 5).join("\n") + "\n\n";
  }
  summary += "=== FIRST 5 LINES ===\n" + lines.slice(0, 5).join("\n") + "\n\n";
  summary += "=== LAST 5 LINES ===\n" + lines.slice(-5).join("\n");

  return truncateUtf8(summary, maxOutputBytes);
}
