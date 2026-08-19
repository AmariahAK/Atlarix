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

const TOOL_CALL_TAGS = new Set([
  "atlarix-tool-call",
  "atlarix-mcp-tool-call",
]);
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
  let out = normalizeThinkingTags(content);
  for (const tagName of tagNames) {
    const openTagPattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "g");
    const closeTagPattern = new RegExp(`</${tagName}>`, "g");
    const openCount = (out.match(openTagPattern) || []).length;
    const closeCount = (out.match(closeTagPattern) || []).length;
    const missing = openCount - closeCount;
    if (missing > 0) {
      out += Array(missing)
        .fill(`</${tagName}>`)
        .join("");
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
    `<(${tagNames.join("|")})\\s*([^>]*)>([\\s\\S]*?)<\\/\\1>`,
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

function rawPiecesToAssistantParts(
  raw: RawPiece[],
  isStreaming: boolean,
  hasPlanArtifactMarker: boolean,
): AssistantMessagePart[] {
  const out: AssistantMessagePart[] = [];
  const toolNameCounts: Record<string, number> = {};
  /** tool id -> index in `out` for in-place status updates */
  const openToolIndex = new Map<string, number>();
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
        if (!openToolIndex.has(mapKey)) {
          toolNameCounts[toolName] = seqNum + 1;
        }
        const toolPart: AssistantMessagePart = {
          type: "tool",
          id: mapKey,
          toolName,
          status:
            status === "running"
              ? "running"
              : status === "error"
                ? "error"
                : "success",
          args: piece.content ? tryParseJson(piece.content) : undefined,
        };
        openToolIndex.set(mapKey, out.length);
        out.push(toolPart);
        continue;
      }

      // tool result — find matching open call
      for (let i = seqNum; i >= 0; i--) {
        const checkKey = `${toolName}_${i}`;
        const idx = openToolIndex.get(checkKey);
        if (idx != null) {
          mapKey = checkKey;
          const prev = out[idx];
          if (prev.type === "tool") {
            let resultText = piece.content?.trim();
            if (toolName === "write_implementation_plan") {
              resultText = "Plan saved";
            }
            const updatedTool: Extract<AssistantMessagePart, { type: "tool" }> = {
              ...prev,
              status,
              error: attrs.error,
              resultText: resultText || prev.resultText,
            };
            const handoff = isDelegateToolName(toolName)
              ? delegateDisplayMetaFromToolPart(updatedTool) ?? undefined
              : undefined;
            out[idx] = {
              ...updatedTool,
              handoff,
            };
            if (status !== "running") openToolIndex.delete(checkKey);
          }
          break;
        }
      }
      continue;
    }

    flushThoughts();
    const tagBlob = `<${tag}${Object.keys(attrs).length ? " " + Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ") : ""}>${piece.content}</${tag}>`;
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

let envelopeSeq = 0;

function envelopeToToolPart(
  raw: string,
  isStreaming: boolean,
  hasPlanArtifactMarker: boolean,
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
  const id = `envelope_${toolName}_${envelopeSeq++}`;
  const part: Extract<AssistantMessagePart, { type: "tool" }> = {
    type: "tool",
    id,
    toolName,
    status: success ? "success" : "error",
    resultText: raw,
    error:
      parsed?.envelope.success === false && typeof parsed.envelope.error === "string"
        ? parsed.envelope.error
        : undefined,
  };
  const handoff = isDelegateToolName(toolName)
    ? delegateDisplayMetaFromToolPart(part) ?? undefined
    : undefined;
  return { ...part, handoff };
}

function parseSegmentContent(
  segment: string,
  isStreaming: boolean,
  hasPlanArtifactMarker: boolean,
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
      const key = `${p.toolName}\0${p.resultText ?? ""}\0${p.status}`;
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
export function parseAssistantMessageParts(
  raw: string,
  isStreaming: boolean,
): AssistantMessagePart[] {
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
  envelopeSeq = 0;
  const hasMarker = contentHasPlanArtifactMarker(raw);
  const segments = splitContentByPlanMarkers(raw);
  const parts: AssistantMessagePart[] = [];
  const seenPlanIds = new Set<string>();

  for (const seg of segments) {
    if (seg.type === "plan-artifact") {
      if (!seenPlanIds.has(seg.planId)) {
        seenPlanIds.add(seg.planId);
        parts.push({ type: "plan_artifact", planId: seg.planId });
      }
      continue;
    }
    parts.push(...parseSegmentContent(seg.content, isStreaming, hasMarker));
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
    return { before: parseAssistantMessageParts(content, isStreaming), after: [] };
  }
  if (offset <= 0) {
    return { before: [], after: parseAssistantMessageParts(content, isStreaming) };
  }
  if (offset >= content.length) {
    return { before: parseAssistantMessageParts(content, isStreaming), after: [] };
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
    merged.push(p);
  }
  return merged;
}

