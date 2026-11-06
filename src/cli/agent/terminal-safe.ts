/**
 * Text the CLI draws, made safe for the terminal.
 *
 * opentui writes a cell's characters to the terminal as they are: an ESC in a
 * peer session's message, a command's output, a file or the model's reply was a
 * live escape sequence in the user's terminal (verified 2026-11-06: the bytes
 * `\x1b]0;…\x07` reached stdout). That can retitle the tab, write the clipboard
 * (OSC 52, where allowed), plant a link (OSC 8), or move the cursor and redraw
 * what an approval card says it will run. Every control character is drawn as a
 * visible symbol instead (␛, ␇, …); a carriage return becomes a newline, so it
 * can't overwrite the line it ends. Newlines and tabs stay.
 */

// eslint-disable-next-line no-control-regex -- finding them is the point
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
// eslint-disable-next-line no-control-regex -- finding them is the point
const CONTROL_ALL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

function symbolFor(c: string): string {
  const code = c.charCodeAt(0);
  if (code === 0x0d) return "\n";
  if (code < 0x20) return String.fromCharCode(0x2400 + code); // Control Pictures: ␛ ␇ ␈ …
  if (code === 0x7f) return "␡"; // ␡
  return "�"; // C1 (8-bit CSI, OSC, ST…)
}

export function terminalSafe(text: string): string {
  if (!CONTROL.test(text)) return text;
  return text.replace(/\r\n/g, "\n").replace(CONTROL_ALL, symbolFor);
}

/**
 * Every string in `value` made terminal-safe, copy-on-write: an object or array
 * with nothing to change comes back as the SAME object, so the transcript's
 * memoised rows stay valid and a clean update costs only the scan.
 */
export function terminalSafeDeep<T>(value: T): T {
  if (typeof value === "string") return terminalSafe(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      const safe = terminalSafeDeep(v);
      if (safe !== v) (out ??= value.slice())[i] = safe;
    }
    return (out ?? value) as T;
  }
  // Plain records only: a Map, Set, Date or class instance is left as it is.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const safe = terminalSafeDeep(v);
    if (safe !== v) (out ??= { ...(value as Record<string, unknown>) })[k] = safe;
  }
  return (out ?? value) as T;
}
