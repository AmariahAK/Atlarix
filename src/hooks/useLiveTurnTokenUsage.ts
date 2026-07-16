import { useEffect, useMemo, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { IpcClient } from "@/ipc/ipc_client";
import {
  liveTurnUsageByChatIdAtom,
  isStreamingForChatAtom,
} from "@/atoms/chatAtoms";
import {
  growLiveOutput,
  type LiveUsageCheckpoint,
} from "@/lib/chat/live-token-usage";

/**
 * Subscribe to the backend's live per-turn token usage and keep
 * `liveTurnUsageByChatIdAtom` fresh for a chat — so BOTH the always-visible
 * composer counter (ChatInputControls) and the popover meter (TokenBar) climb
 * live during a turn.
 *
 * This MUST be mounted somewhere always-present for the active chat (the
 * composer), NOT inside a conditionally-mounted popover — otherwise the meter
 * only updates while that popover is open (the bug this fixes). It writes the
 * shared atom; consumers just read it.
 *
 * The backend emits two kinds of usage:
 *  - a REAL per-step checkpoint (`input` = full context, `output` = that step's
 *    output only), and
 *  - a throttled stream ESTIMATE (`input` null, `output` = turn-cumulative
 *    visible-text estimate).
 * See {@link growLiveOutput} for how the meter grows between checkpoints without
 * dipping or double-counting.
 */
export function useLiveTurnTokenUsage(chatId: number | null | undefined): void {
  const setLiveUsage = useSetAtom(liveTurnUsageByChatIdAtom);
  const isStreaming = useAtomValue(
    useMemo(() => isStreamingForChatAtom(chatId ?? -1), [chatId]),
  );

  // Per-chat live-meter checkpoint tracking (refs, not state, so 400ms ticks
  // don't churn renders here).
  const lastEstOutputRef = useRef<Map<number, number>>(new Map());
  const checkpointRef = useRef<Map<number, LiveUsageCheckpoint>>(new Map());

  useEffect(() => {
    const unsub = IpcClient.getInstance().onTokenUsage((p) => {
      if (chatId == null || p.chatId !== chatId) return;
      // Real per-step checkpoint: snap to provider truth + anchor the next
      // step's estimate delta to the current cumulative estimate.
      if (p.inputTokens != null) {
        checkpointRef.current.set(chatId, {
          realOutput: p.outputTokens,
          estBase: lastEstOutputRef.current.get(chatId) ?? 0,
        });
        setLiveUsage((prev) => ({
          ...prev,
          [chatId]: { input: p.inputTokens, output: p.outputTokens },
        }));
        return;
      }
      // Throttled stream estimate (cumulative turn output). Grow the meter.
      lastEstOutputRef.current.set(chatId, p.outputTokens);
      setLiveUsage((prev) => {
        const cur = prev[chatId];
        const output = growLiveOutput({
          cur,
          checkpoint: checkpointRef.current.get(chatId),
          estOutput: p.outputTokens,
        });
        return { ...prev, [chatId]: { input: cur?.input ?? null, output } };
      });
    });
    return unsub;
  }, [chatId, setLiveUsage]);

  // New stream (rising edge of streaming) → start a fresh per-turn output
  // accumulation, but DON'T drop the meter to the lower client estimate between
  // turns. Collapse the last-known resting occupancy (input + output) into the
  // input baseline and zero output, so the counter holds context across turns
  // and the first real emit of the new turn snaps it to truth.
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (isStreaming && !prevStreamingRef.current && chatId != null) {
      lastEstOutputRef.current.delete(chatId);
      checkpointRef.current.delete(chatId);
      setLiveUsage((prev) => {
        const cur = prev[chatId];
        if (!cur) return prev;
        const baseline = (cur.input ?? 0) + cur.output;
        return { ...prev, [chatId]: { input: baseline, output: 0 } };
      });
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming, chatId, setLiveUsage]);
}
