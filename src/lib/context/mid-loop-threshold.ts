/**
 * WHEN COMPACTION FIRES — the one threshold, plus the pure predicate that reads
 * it. Deliberately its own module, and deliberately the OWNER of the number.
 *
 * It used to live in `tier_context_budget.ts`, which transitively imports the
 * summarizer, the provider clients and settings/keychain. Nothing about
 * "is the context 90% full?" needs any of that, and pulling that chain into a
 * test made the run hang past the node project's default timeout — so the one
 * number that decides whether a long turn survives had no direct coverage.
 * `tier_context_budget` re-exports these, so callers are unchanged.
 *
 * The constant lives HERE rather than in `compaction.ts` for exactly that reason:
 * this is the leaf, so the compactor can import the number without the number's
 * test having to import the compactor.
 */

import type { ModelMessage } from "ai";
import { estimateTokens } from "../../ipc/utils/token_utils";

/**
 * The fill ratio at which an LLM summary becomes worth paying for — shared by all
 * three triggers (pre-dispatch budget, mid-turn loop, model-initiated).
 *
 * There used to be three numbers for this one decision: 0.75 in `compaction.ts`,
 * 0.9 here, and an effective 1.0 in `enforceContextBudget` (which only acted once
 * already over the hard limit). "When does Atlarix compact" therefore had three
 * answers depending on which code path noticed first.
 *
 * 0.9 wins because it is the value with an argument behind it: compaction that
 * fires while a turn still has room throws away detail it never needed to lose,
 * and a summary is lossy in a way the raw history is not. Claude Code sits higher
 * still (~967K of a 1M window). The remaining 10% is output headroom.
 */
export const COMPACTION_THRESHOLD = 0.9;

/** Text of a ModelMessage for estimation — tool results included, media ignored. */
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
        };
        if (p.type === "text" && typeof p.text === "string") return p.text;
        if (p.type === "tool-result") {
          const v = p.output ?? p.result;
          return typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Whether mid-loop compaction would fire for this history.
 *
 * Measured against the model's REAL context window when known, not the
 * per-dispatch tier limit — otherwise a 1M-window model would compact at 90% of
 * a much smaller number and lose history it had ample room for.
 */
export function midLoopCompactionWouldTrigger(params: {
  messages: ModelMessage[];
  systemPromptEstimate: number;
  tierLimit: number;
  contextWindowTokens?: number;
  threshold?: number;
}): { willTrigger: boolean; beforeTokens: number } {
  const threshold = params.threshold ?? COMPACTION_THRESHOLD;
  const limitDenom = params.contextWindowTokens ?? params.tierLimit;
  const beforeTokens =
    params.messages.reduce(
      (acc, m) => acc + estimateTokens(modelMessageText(m.content)),
      0,
    ) + params.systemPromptEstimate;
  return { willTrigger: beforeTokens >= threshold * limitDenom, beforeTokens };
}
