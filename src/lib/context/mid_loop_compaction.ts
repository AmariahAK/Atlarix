/**
 * PASS8 C1-C4: Shared wrapper around `compactAgenticMessagesIfNeeded` so that
 * every agentic loop (Build, Ask/Plan/Debug/Review tier, Agent-tab, chat-only,
 * runDelegation) handles mid-loop compaction the same way.
 *
 * The compaction logic itself lives in `src/lib/routing/tier_context_budget.ts`
 * (Build was the only caller before this pass). This helper adds:
 *  - structured activity emission (running -> done) so the UI can pulse the
 *    token bar via `useCompactionTokenVisuals` (matches `/summariz/i` filter,
 *    see PASS8 G2).
 *  - graceful failure: any throw is caught and the original messages returned
 *    so a flaky summarizer never aborts a tool-loop iteration.
 */

import type { ModelMessage } from "ai";
import { compactAgenticMessagesIfNeeded } from "@/lib/routing/tier_context_budget";
import { compactionWouldTrigger } from "@/lib/context/mid-loop-threshold";

export interface MidLoopCompactionActivityPayload {
  id: string;
  type: "background";
  label: string;
  status: "running" | "done";
  detail?: string;
  timestamp: number;
  chatId: number;
}

export interface RunMidLoopCompactionParams {
  messages: ModelMessage[];
  /** Stage 3b: original native messages (1:1 with `messages`) for native-tail
   * reconstruction — recent tool results stay full-fidelity. */
  nativeMessages?: ModelMessage[];
  systemPromptEstimate: number;
  tierLimit: number;
  /** Window MINUS the reply reserve. See `usableContextBudget`. */
  usableTokens?: number;
  chatId: number;
  /** Short label distinguishing where the compaction fired (e.g. "Ask tier"). */
  loopLabel: string;
  /**
   * Sink for `chat:activity` events. Caller wires it to `safeSend(event.sender, "chat:activity", ...)`
   * when available; chat-only and delegation contexts may pass a no-op.
   */
  emitActivity?: (payload: MidLoopCompactionActivityPayload) => void;
  /** Optional logger callbacks. */
  onInfo?: (msg: string) => void;
  onWarn?: (msg: string, err?: unknown) => void;
}

export interface RunMidLoopCompactionResult {
  messages: ModelMessage[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
}

export async function runMidLoopCompaction(
  params: RunMidLoopCompactionParams,
): Promise<RunMidLoopCompactionResult> {
  const {
    messages,
    nativeMessages,
    systemPromptEstimate,
    tierLimit,
    usableTokens,
    chatId,
    loopLabel,
    emitActivity,
    onInfo,
    onWarn,
  } = params;

  // Gate ALL activity emission behind the real compaction trigger (same
  // predicate as compactAgenticMessagesIfNeeded). Without this, a
  // "Summarizing in-task context" card pulsed on EVERY loop iteration — even
  // at ~6k tokens against a 1M window — because the running/done events were
  // emitted unconditionally. Below threshold: do nothing, emit nothing.
  const pre = compactionWouldTrigger({
    messages,
    systemPromptEstimate,
    tierLimit,
    usableTokens,
  });
  if (!pre.willTrigger) {
    return {
      messages,
      compacted: false,
      beforeTokens: pre.beforeTokens,
      afterTokens: pre.beforeTokens,
    };
  }

  // PASS8 G2: label uses "Summarizing in-task context" so the existing
  // `/summariz/i` filter in `useCompactionTokenVisuals` matches without code
  // changes, and we emit a `running` event before `done` so the token bar
  // animates the pulse during mid-response compaction.
  const startedAt = Date.now();
  const baseLabel = "Summarizing in-task context";
  const activityIdRoot = `mid-compaction-${chatId}-${startedAt}`;

  try {
    emitActivity?.({
      id: `${activityIdRoot}-start`,
      type: "background",
      label: baseLabel,
      status: "running",
      timestamp: startedAt,
      chatId,
    });

    const result = await compactAgenticMessagesIfNeeded({
      messages,
      nativeMessages,
      systemPromptEstimate,
      tierLimit,
      usableTokens,
      chatId,
    });

    if (result.compacted) {
      onInfo?.(
        `[${loopLabel}] Mid-turn compaction: ${result.beforeTokens} -> ${result.afterTokens} tokens (tier limit ${tierLimit})`,
      );
      emitActivity?.({
        id: `${activityIdRoot}-done`,
        type: "background",
        label: baseLabel,
        status: "done",
        detail: `${result.beforeTokens} → ${result.afterTokens} est. tokens (tier limit ${tierLimit})`,
        timestamp: Date.now(),
        chatId,
      });
    } else {
      // No-op compaction still emits `done` so any spinner the UI is showing clears.
      emitActivity?.({
        id: `${activityIdRoot}-done`,
        type: "background",
        label: baseLabel,
        status: "done",
        detail: "below threshold",
        timestamp: Date.now(),
        chatId,
      });
    }

    return {
      messages: result.messages,
      compacted: result.compacted,
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
    };
  } catch (err) {
    onWarn?.(
      `[${loopLabel}] Mid-turn compaction failed (continuing without compaction):`,
      err,
    );
    emitActivity?.({
      id: `${activityIdRoot}-done`,
      type: "background",
      label: baseLabel,
      status: "done",
      detail: "compaction failed",
      timestamp: Date.now(),
      chatId,
    });
    return { messages, compacted: false, beforeTokens: 0, afterTokens: 0 };
  }
}
