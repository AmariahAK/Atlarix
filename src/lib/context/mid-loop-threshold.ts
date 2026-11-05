/**
 * WHEN COMPACTION FIRES, and HOW MUCH ROOM each of its steps may protect.
 * Deliberately its own module, and deliberately the OWNER of these numbers.
 *
 * These used to live in `tier_context_budget.ts`, which transitively imports the
 * summarizer, the provider clients and settings/keychain. Nothing about "does this
 * request fit?" needs any of that, and pulling that chain into a test made the run
 * hang past the node project's default timeout — so the numbers that decide
 * whether a long turn survives had no direct coverage. `tier_context_budget`
 * re-exports them, so callers are unchanged.
 *
 * They live HERE rather than in `compaction.ts` for exactly that reason: this is
 * the leaf, so the compactor can import them without their tests having to import
 * the compactor. Everything below is pure arithmetic — the caller resolves the
 * catalog values and passes plain numbers in.
 */

import type { ModelMessage } from "ai";
import { estimateTokens } from "../../ipc/utils/token_utils";

/**
 * A reply may never claim more than this share of the window.
 *
 * Without a clamp the arithmetic inverts: the reasoning output floor is 32,000, so
 * on a 16,000-token budget `window − reserve` is NEGATIVE and every downstream
 * fraction is nonsense. Capping the reserve keeps `usable` at 60% of the window in
 * the worst case, and on any normal window the model's real output limit is well
 * under 40% so this clamp never binds.
 */
export const MAX_RESERVE_FRACTION = 0.4;

/**
 * How much of the context window this request may actually occupy.
 *
 * THE WINDOW HAS TO HOLD THE REPLY TOO. This replaces a flat
 * `COMPACTION_THRESHOLD = 0.9`, which was a crude stand-in for exactly this
 * reserve — and wrong in both directions, because a fixed percentage of a window
 * has no relationship to how long a reply can be:
 *
 *   1,000,000 window → 0.9 reserved 100,000 for output. A reply needs ~32,000.
 *                      We compacted ~68,000 tokens earlier than necessary, every
 *                      time, throwing away detail the model had room to keep.
 *      16,000 window → 0.9 reserved 1,600. A reasoning model wants 32,000 and
 *                      cannot reply at all; we compacted too late AND still did
 *                      not fit.
 *
 * `maxOutputTokens` comes from the models.dev catalog (`getMaxTokensWithFloor`),
 * so this scales per model instead of per guess. Pure arithmetic on purpose: the
 * caller resolves the catalog value, this module stays importable by a test that
 * does not want the provider chain.
 */
export function usableContextBudget(params: {
  contextWindow: number;
  maxOutputTokens: number;
}): number {
  const window = Math.max(0, params.contextWindow);
  if (window === 0) return 0;
  const reserve = Math.min(
    Math.max(0, params.maxOutputTokens),
    Math.floor(window * MAX_RESERVE_FRACTION),
  );
  return Math.max(1, window - reserve);
}

/**
 * The context WORKING WINDOW: how much of the model's real context window a
 * session may grow to before Atlarix compacts it.
 *
 * `usableContextBudget` alone never fires on a 1M-token model until ~970k, so
 * sessions sat at 350-485k and every step re-sent the whole conversation
 * (2026-10-31 spend incident: the first call of each turn cached ~10.5k of
 * ~440k). The working window is the owner's knob — one rule for every model,
 * whatever its window: the session compacts at `compactionThreshold` × the
 * working window (default 256,000 → ~192k at the 0.75 default), never more
 * than `usableContextBudget` (the reply must fit). A window smaller than the
 * chosen size still governs itself, so a 128k model is unchanged.
 */
export const CONTEXT_WORKING_WINDOW_DEFAULT = 256_000;
export const CONTEXT_WORKING_WINDOW_512K = 512_000;

/** The setting's three values: "256k" (default) | "512k" | "full" (the whole window). */
export type ContextWorkingWindowSetting = "256k" | "512k" | "full";

/**
 * The working window in tokens for a model whose real context window is
 * `contextWindow`. `undefined`/unknown settings resolve to the 256k default.
 */
export function contextWorkingWindowTokens(
  contextWindow: number,
  setting: ContextWorkingWindowSetting | undefined,
): number {
  const window = Math.max(0, contextWindow);
  if (setting === "full") return window;
  const cap =
    setting === "512k"
      ? CONTEXT_WORKING_WINDOW_512K
      : CONTEXT_WORKING_WINDOW_DEFAULT;
  return Math.min(window, cap);
}

/**
 * The compaction point: `compactionThreshold` × the working window, but never
 * more than the usable budget (the window MINUS the room the reply needs — the
 * reply must fit). This is what a request must exceed before compaction runs.
 */
export function compactionPoint(opts: {
  usableTokens: number;
  workingWindowTokens: number;
  threshold: number;
}): number {
  const at = Math.floor(opts.threshold * opts.workingWindowTokens);
  return Math.min(opts.usableTokens, Math.max(1, at));
}

/** Whether the request must be compacted before dispatch, given its size. */
export function compactionShouldTrigger(opts: {
  dispatchEstimate: number;
  usableTokens: number;
  workingWindowTokens: number;
  threshold: number;
}): boolean {
  return (
    opts.dispatchEstimate >
    compactionPoint({
      usableTokens: opts.usableTokens,
      workingWindowTokens: opts.workingWindowTokens,
      threshold: opts.threshold,
    })
  );
}

/**
 * Every limit compaction's steps compare against, derived from the budget they
 * are protecting space within.
 *
 * WHY THIS EXISTS. Each of these was an absolute constant tuned for a large
 * window, and on a small one each step silently opted itself out. Measured
 * 2026-08-31 on a real 4-message session of ~41,000 tokens against a 16,000-token
 * cap, where NOTHING compacted:
 *
 *   microcompact   keep last 3 TURNS      the session had 2 → no-op
 *   prune          PRUNE_MINIMUM 20,000   protected more than the whole budget,
 *                                         so a 19,000-token message was kept whole
 *   summarise      count precondition     arithmetically impossible at 4 messages
 *
 * THE INVARIANT: no protection floor may exceed the budget it protects within.
 * All of the above violated it. `assertBudgetsFitWithin` below encodes it, and a
 * test drives it across window sizes from 8K to 1M.
 */
export interface CompactionBudgets {
  /** Recent tool output kept verbatim by the pruner (was PRUNE_MINIMUM_TOKENS). */
  pruneProtectRecent: number;
  /** Below this much history, a forced compaction is an honest no-op. */
  forceMinHistory: number;
  /** Recent conversation kept verbatim by the summariser's tail selection. */
  preserveRecent: number;
  /** Tool-output budget in the head handed to the summariser. */
  headToolTokens: number;
  /** Recent tool output microcompact leaves alone (was a count of turns). */
  microcompactKeepTokens: number;
}

export function compactionBudgets(usable: number): CompactionBudgets {
  const u = Math.max(1, usable);
  const share = (fraction: number, min: number) =>
    Math.max(Math.min(min, u), Math.floor(u * fraction));
  return {
    // The pruner protects the newest tool output; a quarter leaves three quarters
    // reclaimable, which is what makes a tool-heavy turn compressible at all.
    pruneProtectRecent: share(0.25, 1_000),
    // Summarising a history smaller than this cannot free enough to be worth a
    // provider call.
    forceMinHistory: share(0.5, 1_000),
    preserveRecent: share(0.25, 1_000),
    headToolTokens: share(0.5, 2_000),
    microcompactKeepTokens: share(0.35, 1_000),
  };
}

/** The invariant, callable so a test can assert it rather than restate it. */
export function assertBudgetsFitWithin(
  budgets: CompactionBudgets,
  usable: number,
): string[] {
  return Object.entries(budgets)
    .filter(([, v]) => v > usable)
    .map(([k, v]) => `${k}=${v} exceeds usable=${usable}`);
}

/**
 * Text of a ModelMessage for estimation — every part that actually rides in the
 * request, so the estimate matches what the provider counts. Media is ignored
 * (no text weight), but tool-call ARGUMENTS and reasoning blocks count: they
 * are the two kinds of part the old version skipped, which is why the mid-turn
 * estimate read ~100k under the provider's real input count (0j) and compaction
 * silently no-opped on a round the guard had already ended.
 */
export function modelMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const p = part as {
          type?: string;
          text?: string;
          output?: unknown;
          result?: unknown;
          args?: unknown;
          input?: unknown;
        };
        if (p.type === "text" && typeof p.text === "string") return p.text;
        if (p.type === "tool-result") {
          const v = p.output ?? p.result;
          return typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
        }
        // A tool call's arguments are re-sent to the model on the next step;
        // edit_file's args carry whole files. Skipping them under-counted the
        // request by a large margin.
        if (p.type === "tool-call") {
          const v = p.args ?? p.input;
          return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
        }
        // Reasoning (thinking) blocks ride in the request too.
        if (p.type === "reasoning" && typeof p.text === "string") return p.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * The token cost of a bound toolset's descriptions + parameter schemas — the
 * tool half of the dispatched prefix. Measured from the ACTUAL `ToolSet` object
 * handed to the SDK (what dispatches), not re-derived from the registry, so it
 * cannot drift from what the provider counts.
 *
 * `modelMessageText` already counts the per-message side (tool-call args, tool
 * results, reasoning). This adds the OTHER half the old estimate omitted: the
 * tool SCHEMAS, ~6,700–9,300 tokens that ride in every request and were the gap
 * that let a round-ended session re-decide "below the point" and skip compaction
 * (0j, 2026-10-31).
 */
export function estimateToolSetTokens(tools: unknown): number {
  if (!tools || typeof tools !== "object") return 0;
  let total = 0;
  for (const t of Object.values(tools as Record<string, unknown>)) {
    if (!t || typeof t !== "object") continue;
    const tool = t as {
      description?: unknown;
      inputSchema?: unknown;
      parameters?: unknown;
    };
    if (typeof tool.description === "string") {
      total += estimateTokens(tool.description);
    }
    const schema = tool.inputSchema ?? tool.parameters;
    if (schema != null) {
      total += estimateTokens(safeJson(schema));
    }
  }
  return total;
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Whether compaction would fire for this history.
 *
 * Compares against the compaction POINT when `compactionLimit` is given (the
 * mid-turn caller passes the turn's `compactionPoint`), else against `usable` —
 * the window MINUS the room the reply needs. `usable` already accounts for the
 * model's real output limit, so there is no second ratio to tune here and no way
 * for the two to drift apart.
 *
 * `usableTokens` is optional only so a caller that has not resolved the catalog
 * can still ask; it falls back to the per-dispatch tier limit, which is the
 * window in the normal case (`overflowClampFor` defaults to 1).
 */
export function compactionWouldTrigger(params: {
  messages: ModelMessage[];
  /** The native view of `messages` (1:1). When given, the count reads THIS so
   * tool-call args, reasoning and tool results are priced in FULL (the
   * flattened `messages` caps tool results at 2,000 chars for the summarizer).
   * Absent → `messages` is counted as-is. */
  nativeMessages?: ModelMessage[];
  systemPromptEstimate: number;
  tierLimit: number;
  usableTokens?: number;
  /** The turn's compaction point (threshold × working window, capped by usable) —
   * the mid-turn check's trigger, so one long turn compacts at the same point the
   * pre-dispatch gate does. Absent → the usable budget (the old mid-turn rule). */
  compactionLimit?: number;
  /** Bound tool descriptions + schemas, the part of the prefix the estimate used
   * to omit. When the `messages` already include the system header (the
   * prepareStep path), pass `systemPromptEstimate: 0` and the header is counted
   * as a message; `toolSurfaceTokens` is always added on top. */
  toolSurfaceTokens?: number;
}): { willTrigger: boolean; beforeTokens: number; usable: number } {
  const usable = params.compactionLimit ?? params.usableTokens ?? params.tierLimit;
  const counted = params.nativeMessages ?? params.messages;
  const beforeTokens =
    counted.reduce(
      (acc, m) => acc + estimateTokens(modelMessageText(m.content)),
      0,
    ) +
    params.systemPromptEstimate +
    (params.toolSurfaceTokens ?? 0);
  return { willTrigger: beforeTokens > usable, beforeTokens, usable };
}

/** @deprecated Name kept for existing callers; `compactionWouldTrigger` is the same check. */
export const midLoopCompactionWouldTrigger = compactionWouldTrigger;

/**
 * Should the round END here so the turn loop can compact?
 *
 * The SDK runs every tool step inside ONE round, so a long agentic turn never
 * reached the between-rounds compaction and sat at 238k of a 256k working
 * window, re-sending all of it on every step (owner, 2026-10-31). `inputTokens`
 * is the provider's own count on the last finished step — the real occupancy,
 * not an estimate.
 */
export function roundShouldEndForCompaction(
  inputTokens: number,
  compactionLimit: number | undefined,
): boolean {
  if (typeof compactionLimit !== "number" || compactionLimit <= 0) return false;
  return inputTokens > compactionLimit;
}

/** The fill (of the working window) at which the model is told context is filling. */
export const CONTEXT_REMINDER_FRACTION = 0.55;

/**
 * The model-facing fill reminder, or undefined below CONTEXT_REMINDER_FRACTION.
 *
 * It reports the SAME number that fires it — the share of the working window —
 * and where compaction runs on that scale. It used to fire on the working window
 * but report the share of the model's full window, so a 1M-window session read
 * "Context is at 14% capacity. Consider calling compress_context…" — a low
 * number paired with a nudge that `compress_context`'s own description says not
 * to follow because a thread is long. The UI meter still shows the full window;
 * the model is not reading the meter.
 */
export function contextFillReminder(opts: {
  dispatchEstimate: number;
  workingWindowTokens: number;
  usableTokens: number;
  compactionThreshold: number;
}): string | undefined {
  const working = Math.max(1, opts.workingWindowTokens);
  const fill = opts.dispatchEstimate / working;
  if (fill < CONTEXT_REMINDER_FRACTION) return undefined;
  const point = compactionPoint({
    usableTokens: opts.usableTokens,
    workingWindowTokens: working,
    threshold: opts.compactionThreshold,
  });
  const pct = Math.round(fill * 100);
  const pointPct = Math.round((point / working) * 100);
  return `Context is at ${pct}% of this session's ${working.toLocaleString("en-US")}-token working window; older turns are summarised automatically at ${pointPct}%.`;
}
