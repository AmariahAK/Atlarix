import {
  contentHasPlanArtifactMarker,
  splitContentByPlanMarkers,
} from "@/lib/plan-cards/plan-card-renderer";
import {
  isOnlyToolDebris,
  sanitizeMarkdownForDisplay,
  isToolJsonLine,
  splitByToolResultEnvelopes,
  parseToolResultEnvelope,
} from "@/lib/chat/answer-display";
import { inferToolNameFromEnvelopeRaw } from "@/lib/chat/infer-tool-from-envelope";
import { normalizeThinkingTags } from "@/lib/thinking/normalize-thinking-tags";
import {
  isDelegateToolName,
  delegateDisplayMetaFromToolPart,
  type DelegateHandoffMeta,
} from "@/lib/chat/delegate-handoff";

export type ToolPartStatus = "running" | "success" | "error";

export type AssistantMessagePart =
  | { type: "markdown"; content: string }
  | { type: "thought"; content: string }
  | {
      type: "tool";
      id: string;
      /** The model's tool call id, when the stored tag carries it. */
      callId?: string;
      toolName: string;
      status: ToolPartStatus;
      args?: unknown;
      resultText?: string;
      error?: string;
      handoff?: DelegateHandoffMeta;
    }
  | { type: "plan_artifact"; planId: string };

const THOUGHT_TAGS = new Set([
  "think",
  "thinking",
  "reasoning",
  "redacted_thinking",
]);

const TOOL_CALL_TAGS = new Set(["atlarix-tool-call", "atlarix-mcp-tool-call"]);
const TOOL_RESULT_TAGS = new Set([
  "atlarix-tool-result",
  "atlarix-mcp-tool-result",
]);

type RawPiece =
  | { type: "markdown"; content: string }
  | {
      type: "tag";
      tag: string;
      attributes: Record<string, string>;
      content: string;
      inProgress?: boolean;
      index: number;
    };

function parseAttributes(attributesStr: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attrPattern = /(\w+)="([^"]*)"/g;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrPattern.exec(attributesStr)) !== null) {
    attributes[attrMatch[1]] = attrMatch[2];
  }
  return attributes;
}

/** A whole tool call or result block, whatever it quotes inside. */
const TOOL_BLOCK = /<(atlarix-(?:mcp-)?tool-(?:call|result))\b[^>]*>[\s\S]*?<\/\1>/g;

const THOUGHT_OPEN_OR_CLOSE_OR_TOOL_START =
  /<(\/?)(think|thinking|reasoning|redacted_thinking)(?:\s[^>]*)?>|<atlarix-(?:mcp-)?tool-(?:call|result)\b/gi;

/**
 * A thought that is still open when the next thought or a tool block begins is
 * closed right there, not at the end of the message.
 *
 * gpt-oss (Bedrock, CLI QA 2026-10-30) writes `<reasoning>…` then calls a tool
 * without closing it, and opens another `<reasoning>` after the result. Closing
 * both at the very end made the first block swallow the tool call and result,
 * and left the second closer over as prose: a reply that read "</reasoning>".
 */
function closeThoughtsAtBoundaries(content: string): string {
  // A CLOSER alone is enough to run this pass: a chunk can carry one with its
  // opener in an earlier part, and a stray closer printed as prose is the bug.
  if (!/<\/?(?:think|thinking|reasoning|redacted_thinking)\b/i.test(content)) return content;
  let out = "";
  let cursor = 0;
  let open: string | null = null;
  const re = new RegExp(THOUGHT_OPEN_OR_CLOSE_OR_TOOL_START.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const isThought = m[2] !== undefined;
    if (isThought && m[1] === "/") {
      // A closer with NO thought open is dropped, never printed. The owner saw
      // a reply whose answer was the bare line `</redacted_thinking>`
      // (2026-10-31): the thought had already been closed at a tool call by the
      // rule below, so the model's own closer arrived orphaned — and
      // `stripUnmatchedClosers` leaves it, because counted over the whole
      // message the opener and closer look like a pair. Any closer also ends an
      // open thought whatever name it carries, re-emitted under the opener's
      // name, so a provider that opens and closes with different names pairs.
      out += content.slice(cursor, m.index) + (open ? `</${open}>` : "");
      cursor = m.index + m[0].length;
      open = null;
      continue;
    }
    if (open) {
      out += content.slice(cursor, m.index) + `</${open}>`;
      cursor = m.index;
      open = null;
    }
    if (isThought) open = m[2]!.toLowerCase();
  }
  return out + content.slice(cursor);
}

/** Minimal preprocess: close unclosed tool/thought tags so the scanner can pair them. */
function preprocessForParse(content: string): string {
  const tagNames = [
    "think",
    "thinking",
    "reasoning",
    "redacted_thinking",
    "atlarix-tool-call",
    "atlarix-tool-result",
    "atlarix-mcp-tool-call",
    "atlarix-mcp-tool-result",
  ];
  let out = closeThoughtsAtBoundaries(normalizeThinkingTags(content));
  // Thought tags are counted OUTSIDE tool calls and results only. A tool's
  // output can quote a thought tag (a session search returning an earlier
  // message), and counting that one appended a stray closer at the very end of
  // the message, which then showed as text after the reply (QA, 2026-10-12).
  const outsideTools = out.replace(TOOL_BLOCK, (m) => " ".repeat(m.length));
  for (const tagName of tagNames) {
    const counted = tagName.startsWith("atlarix-") ? out : outsideTools;
    const openTagPattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "g");
    const closeTagPattern = new RegExp(`</\\s*${tagName}\\s*>`, "g");
    const openCount = (counted.match(openTagPattern) || []).length;
    const closeCount = (counted.match(closeTagPattern) || []).length;
    const missing = openCount - closeCount;
    if (missing > 0) {
      out += Array(missing).fill(`</${tagName}>`).join("");
    }
  }
  return out;
}

function parseRawPieces(segment: string): RawPiece[] {
  const processed = preprocessForParse(segment);
  const tagNames = [
    "think",
    "thinking",
    "reasoning",
    "redacted_thinking",
    "atlarix-tool-call",
    "atlarix-tool-result",
    "atlarix-mcp-tool-call",
    "atlarix-mcp-tool-result",
    "atlarix-write",
    "atlarix-edit",
    "atlarix-read",
    "atlarix-output",
    "atlarix-command",
    "atlarix-web-search",
    "atlarix-web-search-result",
    "atlarix-code-search",
    "atlarix-code-search-result",
  ];
  const tagPattern = new RegExp(
    `<(${tagNames.join("|")})\\s*([^>]*)>([\\s\\S]*?)<\\/\\s*\\1\\s*>`,
    "gi",
  );
  const pieces: RawPiece[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(processed)) !== null) {
    const [fullMatch, tag, attributesStr, tagContent] = match;
    const startIndex = match.index;
    if (startIndex > lastIndex) {
      pieces.push({
        type: "markdown",
        content: processed.substring(lastIndex, startIndex),
      });
    }
    pieces.push({
      type: "tag",
      tag: tag.toLowerCase(),
      attributes: parseAttributes(attributesStr),
      content: tagContent,
      index: startIndex,
    });
    lastIndex = startIndex + fullMatch.length;
  }
  if (lastIndex < processed.length) {
    pieces.push({ type: "markdown", content: processed.substring(lastIndex) });
  }
  return pieces;
}

function toolStatusFromAttrs(
  attrs: Record<string, string>,
  inProgress: boolean | undefined,
  isStreaming: boolean,
): ToolPartStatus {
  if (attrs.status === "error") return "error";
  if (
    attrs.status === "complete" ||
    attrs.status === "success" ||
    attrs.status === "done"
  ) {
    return "success";
  }
  if (attrs.status === "running" || inProgress) {
    return !isStreaming && inProgress ? "error" : "running";
  }
  return "success";
}

/**
 * Tool numbering and open calls for ONE message, shared by every batch of tags
 * in it.
 *
 * Each batch (the tags between two stretches of prose or thinking) used to get
 * its own counters, so a long turn named five different calls `run_command_0`.
 * The CLI and the editors key their cells by that name: the copies overwrote
 * each other and were re-sent on every streamed chunk, which tore replies into
 * pieces and stacked up empty thought blocks. Open calls live here too, so a
 * result that arrives after some prose still finds its call.
 */
type ToolNumbering = {
  counts: Record<string, number>;
  /** tool key → its part, for the in-place status update a result makes. */
  open: Map<string, { out: AssistantMessagePart[]; index: number }>;
  /** Call id (the tags' `call` attribute) → its open tool's key. */
  byCall: Map<string, string>;
};

function newToolNumbering(): ToolNumbering {
  return { counts: {}, open: new Map(), byCall: new Map() };
}

function rawPiecesToAssistantParts(
  raw: RawPiece[],
  isStreaming: boolean,
  hasPlanArtifactMarker: boolean,
  numbering: ToolNumbering = newToolNumbering(),
): AssistantMessagePart[] {
  const openTools = numbering.open;
  const out: AssistantMessagePart[] = [];
  const toolNameCounts = numbering.counts;
  const openToolByCall = numbering.byCall;
  let thoughtBuffer: string[] = [];

  const flushThoughts = () => {
    const text = thoughtBuffer.join("\n\n").trim();
    thoughtBuffer = [];
    if (text) out.push({ type: "thought", content: text });
  };

  const flushMarkdown = (content: string) => {
    const sanitized = sanitizeMarkdownForDisplay(content);
    if (!sanitized || isOnlyToolDebris(sanitized)) return;

    // If a markdown chunk is entirely tool-json lines (common leak mode),
    // do not render it as prose. We still keep real markdown elsewhere.
    const lines = sanitized.split("\n").filter((l) => l.trim());
    if (lines.length > 0 && lines.every((l) => isToolJsonLine(l))) return;

    out.push({ type: "markdown", content: sanitized });
  };

  for (const piece of raw) {
    if (piece.type === "markdown") {
      flushThoughts();
      flushMarkdown(piece.content);
      continue;
    }

    const tag = piece.tag;
    const attrs = piece.attributes;

    if (THOUGHT_TAGS.has(tag)) {
      const t = piece.content?.trim();
      if (t) {
        flushThoughts();
        out.push({ type: "thought", content: t });
      }
      continue;
    }

    if (TOOL_CALL_TAGS.has(tag) || TOOL_RESULT_TAGS.has(tag)) {
      flushThoughts();
      const toolName = attrs.tool || attrs.name || attrs.server || "";
      if (
        hasPlanArtifactMarker &&
        (toolName === "write_implementation_plan" ||
          toolName === "read_implementation_plan")
      ) {
        continue;
      }

      const status = toolStatusFromAttrs(attrs, false, isStreaming);
      const seqNum = toolNameCounts[toolName] || 0;
      let mapKey = `${toolName}_${seqNum}`;

      if (TOOL_CALL_TAGS.has(tag)) {
        if (!openTools.has(mapKey)) {
          toolNameCounts[toolName] = seqNum + 1;
        }
        if (attrs.call) openToolByCall.set(attrs.call, mapKey);
        const toolPart: AssistantMessagePart = {
          type: "tool",
          id: mapKey,
          ...(attrs.call ? { callId: attrs.call } : {}),
          toolName,
          status:
            status === "running"
              ? "running"
              : status === "error"
                ? "error"
                : "success",
          args: piece.content ? tryParseJson(piece.content) : undefined,
        };
        openTools.set(mapKey, { out, index: out.length });
        out.push(toolPart);
        continue;
      }

      // tool result — find ITS call: by call id when the tags carry one;
      // otherwise the OLDEST still-open call of that name. (Newest-first put
      // the first of three parallel results on the third call.)
      const byCall = attrs.call ? openToolByCall.get(attrs.call) : undefined;
      const candidates =
        byCall && openTools.has(byCall)
          ? [byCall]
          : Array.from({ length: seqNum + 1 }, (_, i) => `${toolName}_${i}`);
      for (const checkKey of candidates) {
        const slot = openTools.get(checkKey);
        if (slot != null) {
          mapKey = checkKey;
          const prev = slot.out[slot.index]!;
          if (prev.type === "tool") {
            let resultText = piece.content?.trim();
            if (toolName === "write_implementation_plan") {
              resultText = "Plan saved";
            }
            const updatedTool: Extract<AssistantMessagePart, { type: "tool" }> =
              {
                ...prev,
                status,
                error: attrs.error,
                resultText: resultText || prev.resultText,
              };
            const handoff = isDelegateToolName(toolName)
              ? (delegateDisplayMetaFromToolPart(updatedTool) ?? undefined)
              : undefined;
            // In place: a call from an earlier batch is already in the
            // message's part list, which holds this same object.
            Object.assign(prev, { ...updatedTool, handoff });
            if (status !== "running") openTools.delete(checkKey);
          }
          break;
        }
      }
      continue;
    }

    flushThoughts();
    const tagBlob = `<${tag}${
      Object.keys(attrs).length
        ? " " +
          Object.entries(attrs)
            .map(([k, v]) => `${k}="${v}"`)
            .join(" ")
        : ""
    }>${piece.content}</${tag}>`;
    flushMarkdown(tagBlob);
  }

  flushThoughts();

  if (!isStreaming) {
    for (let i = 0; i < out.length; i++) {
      const p = out[i];
      if (p.type === "tool" && p.status === "running") {
        out[i] = { ...p, status: "success" };
      }
    }
  }

  return out;
}

function tryParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str ? { raw: str } : undefined;
  }
}

function envelopeToToolPart(
  raw: string,
  isStreaming: boolean,
  hasPlanArtifactMarker: boolean,
  numbering: ToolNumbering,
): AssistantMessagePart | null {
  const toolName = inferToolNameFromEnvelopeRaw(raw);
  if (
    hasPlanArtifactMarker &&
    (toolName === "write_implementation_plan" ||
      toolName === "read_implementation_plan")
  ) {
    return null;
  }
  const parsed = parseToolResultEnvelope(raw);
  const success = parsed?.envelope.success !== false;
  // Numbered per message like every other tool, so the same envelope keeps its
  // id when the message is parsed again (a module-wide counter gave it a new id
  // on every streamed chunk, and the CLI/ACP re-sent it as a new step).
  const key = `envelope_${toolName}`;
  const n = numbering.counts[key] ?? 0;
  numbering.counts[key] = n + 1;
  const id = `${key}_${n}`;
  const part: Extract<AssistantMessagePart, { type: "tool" }> = {
    type: "tool",
    id,
    toolName,
    status: success ? "success" : "error",
    resultText: raw,
    error:
      parsed?.envelope.success === false &&
      typeof parsed.envelope.error === "string"
        ? parsed.envelope.error
        : undefined,
  };
  const handoff = isDelegateToolName(toolName)
    ? (delegateDisplayMetaFromToolPart(part) ?? undefined)
    : undefined;
  return { ...part, handoff };
}

function parseSegmentContent(
  segment: string,
  isStreaming: boolean,
  hasPlanArtifactMarker: boolean,
  numbering: ToolNumbering = newToolNumbering(),
): AssistantMessagePart[] {
  const parts: AssistantMessagePart[] = [];
  const rawPieces = parseRawPieces(segment);
  const tagBatch: RawPiece[] = [];

  const flushTagBatch = () => {
    if (tagBatch.length === 0) return;
    parts.push(
      ...rawPiecesToAssistantParts(
        tagBatch,
        isStreaming,
        hasPlanArtifactMarker,
        numbering,
      ),
    );
    tagBatch.length = 0;
  };

  for (const piece of rawPieces) {
    if (piece.type === "tag") {
      tagBatch.push(piece);
      continue;
    }

    // Newlines between consecutive tool tags are emitted as whitespace markdown — keep one batch.
    if (!piece.content.trim()) {
      continue;
    }

    flushTagBatch();

    const chunks = splitByToolResultEnvelopes(piece.content);
    for (const chunk of chunks) {
      if (chunk.kind === "envelope") {
        const tool = envelopeToToolPart(
          chunk.raw,
          isStreaming,
          hasPlanArtifactMarker,
          numbering,
        );
        if (tool) parts.push(tool);
        continue;
      }
      if (!chunk.text.trim()) continue;
      parts.push(
        ...rawPiecesToAssistantParts(
          [{ type: "markdown", content: chunk.text }],
          isStreaming,
          hasPlanArtifactMarker,
          numbering,
        ),
      );
    }
  }
  flushTagBatch();
  return parts;
}

function dedupeConsecutiveTools(
  parts: AssistantMessagePart[],
): AssistantMessagePart[] {
  const out: AssistantMessagePart[] = [];
  let lastKey: string | null = null;

  for (const p of parts) {
    if (p.type === "tool") {
      // Which call it is, too: parallel calls of one tool (four sub-agents) are
      // alike while running (same name, no result yet, "running"), and all but
      // the first vanished until each finished (video session).
      const key = `${p.toolName}\0${p.callId ?? JSON.stringify(p.args ?? null)}\0${p.resultText ?? ""}\0${p.status}`;
      if (key === lastKey) continue;
      lastKey = key;
    } else {
      lastKey = null;
    }
    out.push(p);
  }
  return out;
}

/** Ordered assistant message parts (OpenCode-style single stream). */
/**
 * While streaming, a chunk can end partway through a tag (`<thin`, `<atlarix-tool-c`).
 * Parsed as is, that fragment is prose for a moment and goes out as reply text
 * the editor cannot take back. Hold it until its `>` arrives.
 */
const TRAILING_PARTIAL_TAG = /<\/?(?:[A-Za-z][\w-]*(?:\s[^<>]*)?)?$/;

export function parseAssistantMessageParts(
  raw: string,
  isStreaming: boolean,
): AssistantMessagePart[] {
  if (isStreaming && raw) {
    raw = raw.replace(TRAILING_PARTIAL_TAG, "");
    // A hidden comment (the plan marker) still being written: hold it back too,
    // or "<!-- atlarix-plan-artifact:0006e76b-24c6-4e3" reached the editor as text
    // and stayed there (QA #38).
    const open = raw.lastIndexOf("<!--");
    if (open >= 0 && raw.indexOf("-->", open) < 0) raw = raw.slice(0, open);
    else raw = raw.replace(/<!?-?$/, "");
  }
  if (!raw) return [];
  // Fast path for pure prose. Every structural form parseSegmentContent looks
  // for starts with a sentinel char: tags/thoughts/plan-markers with `<`, tool
  // envelopes with `{`. When neither appears, the only transform the full path
  // applies is flushMarkdown's sanitize — so replicate exactly that and skip the
  // per-flush tag/envelope/plan-marker regex sweep. This is the common long-
  // answer case that drove the O(len)×20Hz streaming cost. Parity: the full path
  // yields exactly one sanitized markdown part here, matching completion render.
  if (!raw.includes("<") && !raw.includes("{")) {
    const sanitized = sanitizeMarkdownForDisplay(raw);
    if (!sanitized || isOnlyToolDebris(sanitized)) return [];
    const lines = sanitized.split("\n").filter((l) => l.trim());
    if (lines.length > 0 && lines.every((l) => isToolJsonLine(l))) return [];
    return [{ type: "markdown", content: sanitized }];
  }
  const hasMarker = contentHasPlanArtifactMarker(raw);
  const segments = splitContentByPlanMarkers(raw);
  const parts: AssistantMessagePart[] = [];
  const seenPlanIds = new Set<string>();
  // One numbering for the whole message: every tool call gets its own id.
  const numbering = newToolNumbering();

  for (const seg of segments) {
    if (seg.type === "plan-artifact") {
      if (!seenPlanIds.has(seg.planId)) {
        seenPlanIds.add(seg.planId);
        parts.push({ type: "plan_artifact", planId: seg.planId });
      }
      continue;
    }
    parts.push(...parseSegmentContent(seg.content, isStreaming, hasMarker, numbering));
  }

  return dedupeConsecutiveTools(mergeAdjacentMarkdown(parts));
}

/**
 * Split a message's content into the parts emitted BEFORE and AFTER a given
 * character offset, parsing each side independently.
 *
 * Used for native function-calling sub-agent rounds: the `task` call is an IPC
 * activity event with no marker in the assistant text, so the prose before and
 * after the call is concatenated. Snapshotting `content.length` at the moment
 * the round first appears yields the seam (= length of the pre-call prose);
 * slicing there lets the UI render pre-call prose → sub-agent panel → the
 * continuation, instead of dumping all prose before the panel.
 */
export function splitContentPartsAtOffset(
  content: string,
  offset: number | null | undefined,
  isStreaming: boolean,
): { before: AssistantMessagePart[]; after: AssistantMessagePart[] } {
  if (offset == null || !Number.isFinite(offset)) {
    return {
      before: parseAssistantMessageParts(content, isStreaming),
      after: [],
    };
  }
  if (offset <= 0) {
    return {
      before: [],
      after: parseAssistantMessageParts(content, isStreaming),
    };
  }
  if (offset >= content.length) {
    return {
      before: parseAssistantMessageParts(content, isStreaming),
      after: [],
    };
  }
  return {
    before: parseAssistantMessageParts(content.slice(0, offset), isStreaming),
    after: parseAssistantMessageParts(content.slice(offset), isStreaming),
  };
}

function mergeAdjacentMarkdown(
  parts: AssistantMessagePart[],
): AssistantMessagePart[] {
  const merged: AssistantMessagePart[] = [];
  for (const p of parts) {
    if (p.type === "markdown" && merged.length > 0) {
      const last = merged[merged.length - 1];
      if (last.type === "markdown") {
        merged[merged.length - 1] = {
          type: "markdown",
          content: `${last.content}\n\n${p.content}`.trim(),
        };
        continue;
      }
    }
    // Thinking that arrives as several blocks with nothing between them is one
    // stretch of thought: one block, not a stack of them.
    if (p.type === "thought" && merged.length > 0) {
      const last = merged[merged.length - 1];
      if (last.type === "thought") {
        merged[merged.length - 1] = {
          type: "thought",
          content: `${last.content}\n\n${p.content}`.trim(),
        };
        continue;
      }
    }
    merged.push(p);
  }
  return merged;
}

/**
 * What the agent said at the end, as plain markdown: the prose after its last
 * tool call (all of its prose when that is empty). For places that show the
 * answer alone, like the cloud agent's pull request description, which got
 * the raw tool-call envelopes when it was given the stored message.
 */
export function finalAnswerText(raw: string): string {
  const parts = parseAssistantMessageParts(raw, false);
  const prose = (ps: AssistantMessagePart[]) =>
    ps
      .filter((p): p is Extract<AssistantMessagePart, { type: "markdown" }> => p.type === "markdown")
      .map((p) => p.content.trim())
      .filter(Boolean)
      .join("\n\n");
  const lastTool = parts.map((p) => p.type).lastIndexOf("tool");
  return prose(parts.slice(lastTool + 1)) || prose(parts);
}
