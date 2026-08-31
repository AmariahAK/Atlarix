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

// ─── Persist-time bounding (what the NEXT turn rehydrates) ──────────────────

/** Marker left in a clipped result so the model knows text is missing, not empty. */
const TRUNCATION_NOTE = "\n\n[…older tool output clipped when this turn was saved. " +
  "Re-run the tool, or use `session_search`, if you need the full text.]";

/** Smallest useful remnant of a clipped result — below this, clipping buys nothing. */
const MIN_KEPT_RESULT_CHARS = 400;

/**
 * Shrink a finished turn's native history before it is PERSISTED.
 *
 * WHY THIS EXISTS. `foldNativeIntoTurn` pushes every agentic round into two
 * places: `agenticMessages` (the request, which mid-loop compaction shrinks) and
 * `rt.nativeTurnMessages` (this, the envelope stored on the assistant message's
 * `modelContent`). Nothing bounded the second. So mid-work compaction was real but
 * did not STICK: a thirty-round turn persisted its full tool history, the next
 * message rehydrated all of it, and the pre-dispatch gate paid to summarize what
 * mid-turn had already summarized. Observed 2026-08-31 as a meter reading
 * 34,954 / 16.0k on a single turn.
 *
 * WHY IT TRUNCATES CONTENT AND NEVER REMOVES A MESSAGE. The envelope is replayed
 * to the provider as native `tool_use` / `tool_result` pairs. Dropping a message
 * can orphan a `tool_result` whose `tool_use` is gone (or the reverse), which is a
 * provider 400 on the next turn — a hard failure in exchange for saved tokens.
 * Clipping the TEXT INSIDE a result keeps every pair intact by construction, which
 * is why this is a separate, deterministic step and not a second compactor.
 * opencode draws the same line: tool-output bounding is "provider-independent" and
 * kept out of compaction, which owns token pressure (CONTEXT.md).
 *
 * OLDEST FIRST. The recent rounds are the ones the next turn reasons from; the
 * early ones have usually been superseded by their own follow-ups.
 *
 * CALL IT ONCE, AT PERSIST — never on read. The stored envelope is replayed
 * byte-stable each turn so the provider's prompt cache holds; a transform applied
 * on the way out would produce a different prefix every turn and defeat it. This
 * function is idempotent so that a second application is a no-op rather than a
 * slow erosion of the same turn.
 */
export function boundNativeHistoryForPersist(
  messages: ModelMessage[],
  opts: { budgetTokens: number },
): ModelMessage[] {
  const budget = Math.max(0, opts.budgetTokens);
  if (budget === 0) return messages;

  // Per-message estimates ONCE, then a running total updated in place.
  //
  // The first version called `estimateModelMessagesTokens(out)` inside the loop,
  // re-tokenizing the entire turn on every message — O(n²) over exactly the inputs
  // that make this function necessary (a thirty-round turn of large reads). It ran
  // at persist time, with the user waiting on the end of their turn, and made an
  // eight-case unit test take 13s. Measure once, subtract as you clip.
  const sizes = messages.map(estimateModelMessageTokens);
  let total = sizes.reduce((a, b) => a + b, 0);
  if (total <= budget) return messages;

  // Work on a shallow copy; only the messages actually clipped are rebuilt.
  const out = [...messages];

  // Oldest first. `messages` is in round order, so index order is age order.
  for (let i = 0; i < out.length && total > budget; i++) {
    const m = out[i]!;
    if (m.role !== "tool" || typeof m.content === "string") continue;

    const parts = contentParts(m);
    let changed = false;
    const nextParts = parts.map((part) => {
      if (part?.type !== "tool-result") return part;
      const clipped = clipToolResultOutput((part as { output?: unknown }).output);
      if (!clipped.changed) return part;
      changed = true;
      return { ...part, output: clipped.output };
    });
    if (!changed) continue;

    const next = { ...m, content: nextParts as never } as ModelMessage;
    out[i] = next;
    const after = estimateModelMessageTokens(next);
    total += after - sizes[i]!;
    sizes[i] = after;
  }
  return out;
}

/**
 * Clip one tool result's output in place, preserving its shape (`text` stays
 * `text`, `json` becomes `text` since a truncated JSON string is not JSON).
 * Reports `changed: false` when there is nothing worth clipping, which is what
 * makes the whole pass idempotent.
 */
function clipToolResultOutput(
  output: unknown,
): { output: unknown; changed: boolean } {
  const asText = (value: string): { output: unknown; changed: boolean } => {
    // Already clipped by a previous pass: report no change so the caller keeps the
    // existing part object instead of rebuilding an identical one.
    //
    // NOT what makes this idempotent — that comes from the kept prefix being a
    // fixed `slice(0, MIN_KEPT_RESULT_CHARS)`, so re-clipping a clipped value
    // reproduces it byte for byte. Verified by deleting this line and watching the
    // stability tests still pass. It is an early-out, not a correctness guard, and
    // it is documented that way so nobody later "fixes" the stability tests by
    // strengthening this line.
    if (value.includes(TRUNCATION_NOTE)) return { output, changed: false };
    if (value.length <= MIN_KEPT_RESULT_CHARS) return { output, changed: false };
    return {
      output: {
        type: "text",
        value: value.slice(0, MIN_KEPT_RESULT_CHARS) + TRUNCATION_NOTE,
      },
      changed: true,
    };
  };

  if (output == null) return { output, changed: false };
  if (typeof output === "string") {
    const r = asText(output);
    // A bare string output stays a bare string.
    return r.changed
      ? { output: output.slice(0, MIN_KEPT_RESULT_CHARS) + TRUNCATION_NOTE, changed: true }
      : r;
  }
  const o = output as { type?: string; value?: unknown };
  if (o.type === "text" || o.type === "error-text") {
    return asText(String(o.value ?? ""));
  }
  if (o.type === "json" || o.type === "error-json") {
    return asText(safeJson(o.value));
  }
  if (o.type === "content" && Array.isArray(o.value)) {
    // Media parts are left alone — they are already placeholders or re-gated
    // elsewhere, and clipping a data URI mid-string produces something invalid.
    const text = (o.value as AnyPart[])
      .map((part) =>
        part?.type === "media" ? "" : String((part as { text?: string }).text ?? ""),
      )
      .filter(Boolean)
      .join("\n");
    if (!text) return { output, changed: false };
    return asText(text);
  }
  return { output, changed: false };
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
