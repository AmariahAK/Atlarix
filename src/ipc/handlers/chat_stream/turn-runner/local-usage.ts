/**
 * The Usage page's record of one turn, on this computer (lib/stats/usage-stats).
 * Called from runStream's `finally`, so a stopped or failed turn still adds the
 * tokens it spent, and its sub-agent and compaction tokens with them.
 *
 * (Satellite: never imports the parent handler.)
 */

import { estimateTurnCostUsd } from "@/lib/routing/byok-pricing";
import { auxSpendFrom, recordTurnUsageSafely } from "@/lib/stats/usage-stats";
import { takeAuxUsage } from "@/lib/usage/turn-usage-aggregator";
import type { StreamTurnContext } from "../turn-context";

export function recordLocalTurnUsage(
  ctx: StreamTurnContext,
  finished: boolean,
  automation: boolean,
  chatId?: number,
): void {
  const of = ctx.usageModel?.();
  if (!of) return;
  // Finalization drains the aux bucket on the save path; a stopped turn never
  // got there, so drain it here (the next turn resets it either way).
  const aux =
    ctx.turnAuxUsage !== undefined ? ctx.turnAuxUsage : takeAuxUsage(chatId);
  const spent = ctx.turnInputTokens + ctx.turnOutputTokens > 0;
  const byok = of.pricing.builtinProviderId !== "compass" && !!of.model;
  recordTurnUsageSafely({
    model: of.model,
    mode: of.mode,
    deep: of.deep,
    finished,
    automation,
    inputTokens: ctx.turnInputTokens,
    outputTokens: ctx.turnOutputTokens,
    cacheReadTokens: ctx.turnCachedInputTokens,
    cacheWriteTokens: ctx.turnCacheCreationTokens,
    // Atlarix turns are billed (the Credits tab); only BYOK gets an estimate,
    // and only from a price the provider publishes.
    ...(byok && spent
      ? {
          costUsd: estimateTurnCostUsd(
            of.pricing,
            {
              inputTokens: ctx.turnInputTokens,
              outputTokens: ctx.turnOutputTokens,
              ...(ctx.turnCachedInputTokens > 0
                ? { cachedInputTokens: ctx.turnCachedInputTokens }
                : {}),
              ...(ctx.turnCacheCreationTokens > 0
                ? { cacheCreationInputTokens: ctx.turnCacheCreationTokens }
                : {}),
              ...(ctx.maxTokensUsed
                ? { contextTokens: ctx.maxTokensUsed }
                : {}),
            },
            ctx.turnActualCostUsd > 0 ? ctx.turnActualCostUsd : null,
            { reliableOnly: true },
          ),
        }
      : {}),
    aux: auxSpendFrom(aux?.byLabel),
    messages: ctx.nativeTurnMessages,
  });
}
