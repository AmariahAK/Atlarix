import type { WebContents } from "electron";
import { safeSend } from "./safe_sender";

export const POST_TURN_TOOL_SUMMARY_LABEL = "Summarizing tool outputs";

export function emitPostTurnToolSummaryActivity(
  sender: WebContents,
  chatId: number,
  status: "running" | "done",
): void {
  safeSend(sender, "chat:activity", {
    id: `post-turn-tool-summary-${chatId}`,
    type: "background",
    label: POST_TURN_TOOL_SUMMARY_LABEL,
    status,
    timestamp: Date.now(),
    chatId,
  });
}
