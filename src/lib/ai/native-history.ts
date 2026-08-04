/**
 * v12 0.2 — native tool-call history helpers.
 *
 * The agent loop used to flatten every round's tool exchange into prose
 * (stripToolCallXML + synthetic "Here are the results…" user messages),
 * breaking prompt caching and starving weak models of native
 * tool_use/tool_result blocks. These helpers let the loop carry the AI SDK's
 * native ModelMessage[] forward instead:
 *
 * - in-turn: the build loop folds each round's native response messages into
 *   the next iteration's history (hasNativeToolParts gates the fold);
 * - between turns: the turn's native messages persist on the assistant
 *   message's `modelContent` as a versioned JSON envelope and are spliced
 *   back into the dispatch history on the next turn;
 * - compaction/token-estimation paths still assume `content: string`, so
 *   native messages degrade to prose ONLY when compaction actually fires
 *   (flattenNativeForCompaction) and token estimates account for array
 *   content + media (estimateModelMessageTokens).
 */

import type { ModelMessage } from "ai";
import { estimateTokens } from "@/ipc/utils/token_utils";
import { providerSupportsToolMedia } from "./tool-model-output";

// ─── Versioned envelope (assistant modelContent) ────────────────────────────

const ENVELOPE_PREFIX = '{"v":1,"kind":"native-history"';

export interface NativeHistoryEnvelope {
  v: 1;
  kind: "native-history";
  /** THIS turn's native messages (assistant + tool roles, all rounds, in order). */
  messages: ModelMessage[];
  /** Provider the turn ran on — lets reload re-gate media on provider shift. */
  producedBy?: { builtinProviderId?: string };
}

export function serializeNativeHistory(
  messages: ModelMessage[],
  producedBy?: { builtinProviderId?: string },
): string {
  if (!messages.length) return "";
  const envelope: NativeHistoryEnvelope = {
    v: 1,
    kind: "native-history",
    messages,
    ...(producedBy ? { producedBy } : {}),
  };
  try {
    return JSON.stringify(envelope);
  } catch {
    return "";
  }
}

/**
 * Cheap prefix check BEFORE JSON.parse — user messages use `modelContent` for
 * rich-input strings; this disambiguates so they are never mis-parsed.
 */
export function isNativeHistoryEnvelope(s: string | null | undefined): boolean {
  return typeof s === "string" && s.startsWith(ENVELOPE_PREFIX);
}

export function parseNativeHistory(
  modelContent: string | null | undefined,
): NativeHistoryEnvelope | null {
  if (!isNativeHistoryEnvelope(modelContent)) return null;
  try {
    const parsed = JSON.parse(modelContent!) as NativeHistoryEnvelope;
    if (parsed.v !== 1 || parsed.kind !== "native-history") return null;
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// ─── Native-part detection ──────────────────────────────────────────────────

type AnyPart = { type?: string; [key: string]: unknown };

function contentParts(m: ModelMessage): AnyPart[] {
  return Array.isArray(m.content) ? (m.content as unknown as AnyPart[]) : [];
}

/** True when the messages contain native tool traffic (tool role / tool-call parts). */
export function hasNativeToolParts(messages: ModelMessage[]): boolean {
  return messages.some(
    (m) =>
      m.role === "tool" ||
      contentParts(m).some(
        (p) => p?.type === "tool-call" || p?.type === "tool-result",
      ),
  );
}

// ─── Token estimation for array-content messages ────────────────────────────

/** Flat per-image estimate (Anthropic charges ~1.6k tokens for ≤1568px). */
const MEDIA_PART_TOKEN_ESTIMATE = 1_600;

export function estimateModelMessageTokens(m: ModelMessage): number {
  if (typeof m.content === "string") return estimateTokens(m.content);
  let total = 0;
  for (const part of contentParts(m)) {
    switch (part?.type) {
      case "text":
        total += estimateTokens(String(part.text ?? ""));
        break;
      case "tool-call":
        total += estimateTokens(
          `${String(part.toolName ?? "")}${safeJson(part.input ?? part.args)}`,
        );
        break;
      case "tool-result": {
        const output = (part as { output?: unknown }).output;
        total += estimateOutputTokens(output);
        break;
      }
      case "media":
      case "image":
      case "file":
        total += MEDIA_PART_TOKEN_ESTIMATE;
        break;
      default:
        total += estimateTokens(safeJson(part));
    }
  }
  return total;
}

export function estimateModelMessagesTokens(messages: ModelMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateModelMessageTokens(m), 0);
}

// ─── Per-tool attribution (context meter) ───────────────────────────────────

/**
 * Which display bucket a tool's traffic belongs to.
 *
 * Anything unlisted falls into `otherToolOutput` — that is deliberate. A new
 * tool must never silently vanish from the meter, and "other" is the honest
 * answer until someone decides it deserves its own row.
 */
const TOOL_BUCKETS: Record<string, "filesRead" | "searchResults"> = {
  read_file: "filesRead",
  read_attachment: "filesRead",
  list_attachments: "filesRead",
  grep: "searchResults",
  glob: "searchResults",
};

export interface NativeToolTokenBuckets {
  /** `read_file` and friends — bounded, intentional reads. */
  filesRead: number;
  /** `grep` / `glob` — ranked results, the bucket that balloons on a big repo. */
  searchResults: number;
  /** Commands, web, MCP, browser, sub-agents — everything else. */
  otherToolOutput: number;
  /** Assistant prose, reasoning and media: everything that is NOT tool traffic. */
  nonTool: number;
}

/**
 * Split a turn's native messages into per-bucket token estimates.
 *
 * The four buckets sum to `estimateModelMessagesTokens(messages)` by
 * construction — every part is scored exactly once, with the SAME estimator the
 * dispatch path uses. That invariant is what lets the context meter carve tool
 * traffic OUT of message history instead of adding it on top (tool results ARE
 * history — counting them in both places would double-count).
 */
export function bucketNativeTokensByTool(
  messages: ModelMessage[],
): NativeToolTokenBuckets {
  const buckets: NativeToolTokenBuckets = {
    filesRead: 0,
    searchResults: 0,
    otherToolOutput: 0,
    nonTool: 0,
  };

  const add = (toolName: unknown, tokens: number) => {
    const key = TOOL_BUCKETS[String(toolName ?? "")] ?? "otherToolOutput";
    buckets[key] += tokens;
  };

  for (const m of messages) {
    if (typeof m.content === "string") {
      buckets.nonTool += estimateTokens(m.content);
      continue;
    }
    for (const part of contentParts(m)) {
      switch (part?.type) {
        case "tool-call":
          add(
            part.toolName,
            estimateTokens(
              `${String(part.toolName ?? "")}${safeJson(part.input ?? part.args)}`,
            ),
          );
          break;
        case "tool-result":
          add(
            part.toolName,
            estimateOutputTokens((part as { output?: unknown }).output),
          );
          break;
        case "text":
          buckets.nonTool += estimateTokens(String(part.text ?? ""));
          break;
        case "media":
        case "image":
        case "file":
          buckets.nonTool += MEDIA_PART_TOKEN_ESTIMATE;
          break;
        default:
          buckets.nonTool += estimateTokens(safeJson(part));
      }
    }
  }

  return buckets;
}

function estimateOutputTokens(output: unknown): number {
  if (output == null) return 0;
  if (typeof output === "string") return estimateTokens(output);
  const o = output as { type?: string; value?: unknown };
  if (o.type === "content" && Array.isArray(o.value)) {
    let total = 0;
    for (const part of o.value as AnyPart[]) {
      if (part?.type === "media") total += MEDIA_PART_TOKEN_ESTIMATE;
      else total += estimateTokens(String((part as { text?: string }).text ?? ""));
    }
    return total;
  }
  return estimateTokens(safeJson(output));
}

function safeJson(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

// ─── Compaction fallback (lossy, only when compaction fires) ────────────────

const FLATTEN_TOOL_RESULT_MAX_CHARS = 2_000;

/**
 * Degrade native-part messages to `content: string` for the string-based
 * compaction/summarization pipeline. Mirrors the legacy synthetic shapes so
 * summaries read the same as the old flattened history. Pure string messages
 * pass through by reference.
 */
export function flattenNativeForCompaction(
  messages: ModelMessage[],
): ModelMessage[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return m;
    const parts = contentParts(m);
    if (m.role === "tool") {
      const text = parts
        .map((p) => {
          const name = String((p as { toolName?: string }).toolName ?? "tool");
          const output = (p as { output?: unknown }).output;
          return `<tool_result tool="${name}">\n${flattenOutputText(output)}\n</tool_result>`;
        })
        .join("\n\n");
      // Tool results historically traveled as user-role synthetic messages.
      return { role: "user", content: text } as ModelMessage;
    }
    const text = parts
      .map((p) => {
        switch (p?.type) {
          case "text":
            return String(p.text ?? "");
          case "tool-call":
            return `[tool_call: ${String(p.toolName ?? "tool")}(${safeJson(p.input ?? p.args).slice(0, 200)})]`;
          case "media":
          case "image":
          case "file":
            return "[media omitted]";
          default:
            return safeJson(p).slice(0, 200);
        }
      })
      .filter(Boolean)
      .join("\n");
    return { ...m, content: text } as ModelMessage;
  });
}

function flattenOutputText(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output.slice(0, FLATTEN_TOOL_RESULT_MAX_CHARS);
  const o = output as { type?: string; value?: unknown };
  if (o.type === "text" || o.type === "error-text") {
    return String(o.value ?? "").slice(0, FLATTEN_TOOL_RESULT_MAX_CHARS);
  }
  if (o.type === "json" || o.type === "error-json") {
    return safeJson(o.value).slice(0, FLATTEN_TOOL_RESULT_MAX_CHARS);
  }
  if (o.type === "content" && Array.isArray(o.value)) {
    return (o.value as AnyPart[])
      .map((p) =>
        p?.type === "media"
          ? "[image omitted]"
          : String((p as { text?: string }).text ?? ""),
      )
      .join("\n")
      .slice(0, FLATTEN_TOOL_RESULT_MAX_CHARS);
  }
  return safeJson(output).slice(0, FLATTEN_TOOL_RESULT_MAX_CHARS);
}

// ─── Provider-shift re-gating (reload on a different provider) ──────────────

/**
 * When a turn produced media tool results on a vision provider but is being
 * replayed on a provider that can't take media in tool results, replace the
 * media parts with text placeholders (keeps the request valid).
 */
export function regateNativeMediaForProvider(
  messages: ModelMessage[],
  currentBuiltinProviderId: string | undefined,
  currentModelApiId?: string,
): ModelMessage[] {
  if (providerSupportsToolMedia(currentBuiltinProviderId, currentModelApiId))
    return messages;

  let changed = false;
  const out = messages.map((m) => {
    if (m.role !== "tool" || typeof m.content === "string") return m;
    const parts = contentParts(m).map((p) => {
      const output = (p as { output?: { type?: string; value?: unknown } }).output;
      if (output?.type !== "content" || !Array.isArray(output.value)) return p;
      const hasMedia = (output.value as AnyPart[]).some(
        (v) => v?.type === "media",
      );
      if (!hasMedia) return p;
      changed = true;
      return {
        ...p,
        output: {
          type: "content",
          value: (output.value as AnyPart[]).map((v) =>
            v?.type === "media"
              ? {
                  type: "text",
                  text: "[image omitted — this provider cannot view images in tool results]",
                }
              : v,
          ),
        },
      };
    });
    return { ...m, content: parts } as unknown as ModelMessage;
  });
  return changed ? out : messages;
}
