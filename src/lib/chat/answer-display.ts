/** Strip hallucinated Atlarix tool XML from a streaming text-delta (no trim). */
export function stripHallucinatedAtlarixToolTagsFromDelta(text: string): string {
  if (!text) return "";
  let out = text;
  out = out.replace(/<\/?atlarix-tool_calls\b[^>]*>/gi, "");
  out = out.replace(/<\/?atlarix-(?:tool|mcp)-[\w-]*[^>]*>/gi, "");
  out = out.replace(/<atlarix-tool[_-][\w-]*(?:\s[^>]*)?$/gi, "");
  return out;
}

/** Remove orphan tool XML fragments and JSON tails leaked into markdown. */
export function stripOrphanToolTagFragments(content: string): string {
  if (!content) return "";
  let out = content;
  out = out.replace(/<\/?atlarix-(?:tool|mcp)-[\w-]*[^>]*>/gi, "");
  out = out.replace(/<\/?atlarix-mcp-tool-[\w-]*[^>]*>/gi, "");
  out = out.replace(
    /[,\s]*"message"\s*:\s*"[^"]*"\s*\}\s*,\s*"cost"\s*:\s*\d+[^<]*$/gi,
    "",
  );
  out = out.replace(/[,\s]*"_truncatedOutput"\s*:\s*(?:true|false)\s*\}?/gi, "");
  out = out.replace(/\}\s*<\/atlarix-tool-result>\s*/gi, "");
  out = out.replace(/\{[^{}]*"message"\s*:\s*"[^"]*"[^{}]*\}/gi, "");
  // v14.8.10 Fix L: orphan result TAILS without a leading `{` — a model echoing
  // a fragment of a tool result (observed: `","message":"Plan created."}` next
  // to the plan card). Anchored to known result keys + a closing `}` so real
  // prose mentioning the word "message" is untouched.
  out = out.replace(
    /"?,?\s*"(?:message|planId|planStatus|marker|contentPreview)"\s*:\s*"[^"]*"[^{}\n]*\}/gi,
    "",
  );
  out = stripMultilineToolJsonEnvelopes(out);
  out = stripToolJsonLinesFromMarkdown(out);
  out = out.replace(/\n{2,}/g, "\n");
  return out.trim();
}

/** True if a single line looks like tool args or tool result JSON. */
export function isToolJsonLine(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return false;
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    if (!o || typeof o !== "object") return false;
    if ("success" in o && ("result" in o || "error" in o || "message" in o)) return true;
    if ("focus_path" in o || "max_depth" in o) return true;
    if ("path" in o && typeof o.path === "string" && !("content" in o)) {
      const keys = Object.keys(o);
      if (keys.length <= 4) return true;
    }
    if ("mode" in o && ("query" in o || "path" in o)) return true;
    if ("requested_mode" in o && "resolved_mode" in o) return true;
    if ("tool" in o && "status" in o && Object.keys(o).length <= 5) return true;
  } catch {
    return false;
  }
  return false;
}

/** Remove line-by-line tool JSON leaked into markdown segments. */
export function stripToolJsonLinesFromMarkdown(content: string): string {
  if (!content) return "";
  const lines = content.split("\n");
  const kept = lines.filter((line) => !isToolJsonLine(line));
  return kept.join("\n");
}

/** Balanced `{ ... }` end index, or null if unclosed. */
function findJsonObjectEnd(text: string, start: number): number | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\" && inString) {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/** True when parsed object looks like ToolRegistry `{ success, result?, cost? }`. */
export function isToolResultEnvelopeObject(o: Record<string, unknown>): boolean {
  if (!("success" in o)) return false;
  return (
    "result" in o ||
    "error" in o ||
    "message" in o ||
    "cost" in o
  );
}

/** Parse a substring as a tool result envelope, if applicable. */
export function parseToolResultEnvelope(
  text: string,
): { raw: string; envelope: Record<string, unknown> } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  const end = findJsonObjectEnd(trimmed, 0);
  if (end == null) return null;
  const slice = trimmed.slice(0, end);
  try {
    const o = JSON.parse(slice) as Record<string, unknown>;
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    if (!isToolResultEnvelopeObject(o)) return null;
    return { raw: slice, envelope: o };
  } catch {
    return null;
  }
}

/** Remove multi-line `{ "success": true, "result": ... }` blobs from markdown. */
export function stripMultilineToolJsonEnvelopes(content: string): string {
  if (!content) return "";
  let out = "";
  let i = 0;
  while (i < content.length) {
    const brace = content.indexOf("{", i);
    if (brace === -1) {
      out += content.slice(i);
      break;
    }
    out += content.slice(i, brace);
    const end = findJsonObjectEnd(content, brace);
    if (end == null) {
      out += content.slice(brace);
      break;
    }
    const slice = content.slice(brace, end);
    const parsed = parseToolResultEnvelope(slice);
    if (parsed) {
      i = end;
      continue;
    }
    out += "{";
    i = brace + 1;
  }
  return out;
}

/** Split text into markdown spans and bare tool JSON envelopes (in order). */
export function splitByToolResultEnvelopes(
  content: string,
): Array<{ kind: "markdown"; text: string } | { kind: "envelope"; raw: string }> {
  if (!content) return [];
  const out: Array<
    { kind: "markdown"; text: string } | { kind: "envelope"; raw: string }
  > = [];
  let i = 0;
  while (i < content.length) {
    const brace = content.indexOf("{", i);
    if (brace === -1) {
      const tail = content.slice(i);
      if (tail.trim()) out.push({ kind: "markdown", text: tail });
      break;
    }
    if (brace > i) {
      const mid = content.slice(i, brace);
      if (mid.trim()) out.push({ kind: "markdown", text: mid });
    }
    const end = findJsonObjectEnd(content, brace);
    if (end == null) {
      out.push({ kind: "markdown", text: content.slice(brace) });
      break;
    }
    const slice = content.slice(brace, end);
    const parsed = parseToolResultEnvelope(slice);
    if (parsed) {
      out.push({ kind: "envelope", raw: parsed.raw });
      i = end;
    } else {
      out.push({ kind: "markdown", text: "{" });
      i = brace + 1;
    }
  }
  return out;
}

/** True when visible text is only whitespace or tool JSON debris. */
export function isOnlyToolDebris(content: string): boolean {
  const stripped = stripMultilineToolJsonEnvelopes(
    stripToolJsonLinesFromMarkdown(stripOrphanToolTagFragments(content)),
  ).trim();
  if (!stripped) return true;
  if (/^[\s\]},":\d._-]+$/.test(stripped)) return true;
  if (/^"?,?\s*"message"\s*:/.test(stripped)) return true;
  if (/^\{\s*"success"\s*:/.test(stripped)) return true;
  const lines = stripped.split("\n").filter((l) => l.trim());
  if (lines.length > 0 && lines.every((l) => isToolJsonLine(l))) return true;
  return false;
}

/**
 * B1: agent tool names a model might MIS-EMIT as text (`<read_file>{…}</read_file>`)
 * on native-FC providers instead of issuing a real tool call. Such leaks render
 * as raw XML+JSON in the bubble. We strip them for ALL tools (not just ask_user)
 * — but ONLY when the tag wraps a JSON object, so legit prose/code that happens
 * to mention a tag name is never touched. Single common words (task/plan/grep/
 * glob) are intentionally excluded as extra prose-safety; they're caught only by
 * the JSON-body gate via the multi-word names anyway.
 */
const TEXT_EMITTED_TOOL_TAG_NAMES = [
  "ask_user",
  "read_file",
  "edit_file",
  "run_command",
  "web_search",
  "read_url",
  "mcp_call",
  "list_available_mcps",
  "read_attachment",
  "list_attachments",
  "compress_context",
  "background_jobs",
  "browser_navigate",
  "browser_inspect",
  "browser_interact",
] as const;

/**
 * Remove JSON-bodied tool-call blocks a model emitted as TEXT (the TODO:1488
 * native-FC leak). Only strips `<name ...>{…}</name>` where the body is a JSON
 * object — prose like "the <read_file> tool" (no JSON body) is preserved.
 */
export function stripTextEmittedToolCallBlocks(content: string): string {
  if (!content) return "";
  let out = content;
  for (const name of TEXT_EMITTED_TOOL_TAG_NAMES) {
    // <name ...> [whitespace] { ...balanced-ish... } [whitespace] </name>
    const block = new RegExp(
      `<${name}(?:\\s[^>]*)?>\\s*\\{[\\s\\S]*?\\}\\s*</${name}>`,
      "gi",
    );
    out = out.replace(block, "");
    // Streaming tail: an opener that begins a JSON body but isn't closed yet.
    const openTail = new RegExp(`<${name}(?:\\s[^>]*)?>\\s*\\{[\\s\\S]*$`, "i");
    out = out.replace(openTail, "");
  }
  return out;
}

const STRIP_TAG_NAMES = [
  "think",
  "thinking",
  "reasoning",
  "redacted_thinking",
  "atlarix-tool-call",
  "atlarix-tool-result",
  "atlarix-mcp-tool-call",
  "atlarix-mcp-tool-result",
] as const;

function stripTagBlocks(
  content: string,
  tagName: string,
  unclosed: "drop-open-only" | "drop-through-eof" = "drop-open-only",
): string {
  const open = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "gi");
  const close = new RegExp(`</${tagName}>`, "gi");
  let out = content;
  let safety = 0;
  while (safety++ < 500) {
    open.lastIndex = 0;
    const m = open.exec(out);
    if (!m || m.index == null) break;
    close.lastIndex = m.index + m[0].length;
    const end = close.exec(out);
    if (!end || end.index == null) {
      if (unclosed === "drop-through-eof") {
        out = out.slice(0, m.index);
        break;
      }
      out = out.slice(0, m.index) + out.slice(m.index + m[0].length);
      continue;
    }
    const closeEnd = end.index + end[0].length;
    out = out.slice(0, m.index) + out.slice(closeEnd);
  }
  return out;
}

/**
 * Visible answer markdown after removing thinking/tool XML blocks only.
 * Does not run stripAssistantPlanForDisplay (plan markers and short intros remain).
 */
export function extractVisibleAnswerMarkdown(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  let out = raw
    .replace(/<thinking(\s[^>]*)?>/gi, (_m, attrs = "") => `<redacted_thinking${attrs}>`)
    .replace(/<\/thinking>/gi, "</think>");
  for (const tag of STRIP_TAG_NAMES) {
    out = stripTagBlocks(out, tag, "drop-through-eof");
  }
  out = stripTextEmittedToolCallBlocks(out);
  out = stripOrphanToolTagFragments(out);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Sanitize markdown segments shown in the chat bubble. */
export function sanitizeMarkdownForDisplay(content: string): string {
  if (!content) return "";
  return stripMultilineToolJsonEnvelopes(
    stripOrphanToolTagFragments(stripTextEmittedToolCallBlocks(content)),
  ).trim();
}
