/**
 * Atlarix Auto's live readout beside the context line: how much of today's free
 * share is left, and which model answered last. Shown only while Auto is the
 * selected model; empty until the first Auto reply of the session.
 *
 * The nudge appears once the share runs low — the one moment a Pro prompt is
 * useful rather than an ad.
 */
import { useEffect, useState } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import type { AutoStatus } from "@/main/auto-status";

/** Below this percentage of today's share, suggest Pro. */
export const AUTO_LOW_SHARE_PERCENT = 20;

export function AtlarixAutoStatus() {
  const [status, setStatus] = useState<AutoStatus | null>(null);
  useEffect(() => IpcClient.getInstance().onAutoStatus(setStatus), []);
  if (!status) return null;
  const { freeRemaining, servedModel } = status;
  const low = freeRemaining != null && freeRemaining < AUTO_LOW_SHARE_PERCENT;
  return (
    <span
      data-testid="atlarix-auto-status"
      className="shrink-0 text-[10px] tabular-nums text-muted-foreground/90"
      title={
        servedModel
          ? `Atlarix Auto answered with ${servedModel}. Free share left today, as of that reply.`
          : "Free share left today"
      }
    >
      {freeRemaining != null ? `Free today ~${freeRemaining}%` : "Free"}
      {servedModel ? ` · ${servedModel}` : ""}
      {low && (
        <span className="ml-1 text-amber-600 dark:text-amber-400">
          · running low — Pro includes GPT-6
        </span>
      )}
    </span>
  );
}
