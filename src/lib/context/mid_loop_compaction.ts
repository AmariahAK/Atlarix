/**
 * PASS8 C1-C4: Shared wrapper around `compactAgenticMessagesIfNeeded` so that
 * every agentic loop (Build, Ask/Plan/Debug/Review tier, Agent-tab, chat-only,
 * runDelegation) handles mid-loop compaction the same way.
 *
 * The compaction logic itself lives in `src/lib/routing/tier_context_budget.ts`
 * (Build was the only caller before this pass). This helper adds:
 *  - a single opt-out via `enabled` (mirrors settings.enableContextAutoSummarize).
 *  - structured activity emission (running -> done) so the UI can pulse the
 *    token bar via `useCompactionTokenVisuals` (matches `/summariz/i` filter,
 *    see PASS8 G2).
 *  - graceful failure: any throw is caught and the original messages returned
 *    so a flaky summarizer never aborts a tool-loop iteration.
 */

import type { ModelMessage } from "ai";
import { compactAgenticMessagesIfNeeded } from "@/lib/routing/tier_context_budget";
import { pruneToolOutputsInMessages } from "@/lib/context-compaction";

/**
 * PASS8 D1: ModelMessage-safe wrapper around `pruneToolOutputsInMessages`.
 * The shared pruner expects `{ role: string; content: string }`. AI SDK
 * `ModelMessage` content can be a string OR an array of parts (multimodal,
 * tool calls / results). We only prune string-content messages; everything
 * else passes through untouched, preserving tool-call / tool-result envelopes
 * the SDK expects.
 */
export function pruneToolOutputsInModelMessages(msgs: ModelMessage[]): ModelMessage[] {
  if (!Array.isArray(msgs) || msgs.length === 0) return msgs;
  type Adapter = { role: string; content: string; __origIdx: number };
  const adapters: Adapter[] = [];
  msgs.forEach((m, idx) => {
    if (typeof m.content === "string") {
      adapters.push({ role: m.role, content: m.content, __origIdx: idx });
    }
  });
  if (adapters.length === 0) return msgs;
  const pruned = pruneToolOutputsInMessages(adapters);
  const replacements = new Map<number, string>();
  pruned.forEach((p) => replacements.set(p.__origIdx, p.content));
  return msgs.map((m, idx) => {
    const replaced = replacements.get(idx);
    if (replaced === undefined || replaced === (m.content as unknown as string)) return m;
    return { ...m, content: replaced } as ModelMessage;
  });
}

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
  systemPromptEstimate: number;
  tierLimit: number;
  /** Mirrors `settings.enableContextAutoSummarize !== false` from the caller. */
  enabled: boolean;
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
  /** Threshold override (defaults to 0.7 to match Build). */
  threshold?: number;
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
    systemPromptEstimate,
    tierLimit,
    enabled,
    chatId,
    loopLabel,
    emitActivity,
    onInfo,
    onWarn,
    threshold = 0.7,
  } = params;

  if (!enabled) {
    return { messages, compacted: false, beforeTokens: 0, afterTokens: 0 };
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
      systemPromptEstimate,
      tierLimit,
      threshold,
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
