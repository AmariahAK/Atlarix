/**
 * Tolerant extractor for INCOMPLETE tool-call argument JSON streamed live.
 *
 * The AI SDK streams `tool-input-delta` chunks — the raw arguments JSON building
 * up character by character. We must NOT `JSON.parse` it (it's truncated mid-
 * string most of the time). Instead we scan for the fields a live preview needs
 * (`path`, `content`/`new_content`, `operation`), tolerating a truncated tail.
 * Returns null when nothing usable is present yet, so the caller can fall back
 * to the existing "Writing…" skeleton with zero risk.
 */

export interface PartialToolArgs {
  path?: string;
  content?: string;
  operation?: string;
}

/** Unescape a JSON string fragment that may be truncated (best-effort). */
function unescapeJsonFragment(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = s[i + 1];
    if (next === undefined) break; // dangling backslash at the truncated end
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case '"':
        out += '"';
        break;
      case "\\":
        out += "\\";
        break;
      case "/":
        out += "/";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "u": {
        const hex = s.slice(i + 2, i + 6);
        if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          return out; // truncated \u escape — stop cleanly
        }
        break;
      }
      default:
        out += next;
    }
    i += 1; // consumed the escaped char
  }
  return out;
}

/**
 * Read the string value for `"key": "<value>"` starting anywhere in `text`.
 * Scans respecting backslash escapes; tolerates a value with no closing quote
 * yet (truncated). Returns null if the key isn't present.
 */
function readStringValue(text: string, key: string): string | null {
  const opener = new RegExp(`"${key}"\\s*:\\s*"`);
  const m = opener.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  let raw = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      raw += ch + (text[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === '"') break; // closing quote → value complete
    raw += ch;
    i += 1;
  }
  return unescapeJsonFragment(raw);
}

/**
 * Best-effort partial args for the live preview. Supported for the string-heavy
 * writes: `edit_file` (write/replace ops) and `plan` (the markdown body of a
 * `write`). Everything else returns null so the UI keeps today's skeleton.
 */
export function extractPartialToolArgs(
  toolName: string,
  argsTextSoFar: string,
): PartialToolArgs | null {
  if (!argsTextSoFar) return null;

  if (toolName === "edit_file") {
    const result: PartialToolArgs = {};

    const path = readStringValue(argsTextSoFar, "path");
    if (path) result.path = path;

    const op = argsTextSoFar.match(
      /"operation"\s*:\s*"(write|replace|insert|delete|section)"/,
    );
    if (op) result.operation = op[1];

    // write → `content`; replace/insert/section → `new_content`. The `"content"`
    // pattern requires a quote immediately before it, so it never matches inside
    // `"new_content"`.
    const content =
      readStringValue(argsTextSoFar, "content") ??
      readStringValue(argsTextSoFar, "new_content");
    if (content) result.content = content;

    if (!result.path && !result.content) return null;
    return result;
  }

  if (toolName === "plan") {
    // The plan lives in SQLite (no file path); a `write` streams its markdown
    // body in `content`. Surface that so the plan builds up live instead of
    // sitting on a false "Reconnecting…". Other plan ops carry no body → null.
    const content = readStringValue(argsTextSoFar, "content");
    if (!content) return null;
    const title = readStringValue(argsTextSoFar, "title");
    return { path: title ?? "Plan", content, operation: "write" };
  }

  return null;
}
