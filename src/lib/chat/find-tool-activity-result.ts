/**
 * The result belonging to ONE tool call.
 *
 * WHY THIS IS KEYED ON THE CALL ID
 * It used to be keyed on the tool NAME, scanning last→first for the most recent
 * result of that name — which silently crossed concurrent calls of the same tool.
 * With two `web_search` calls in flight, whichever finished last supplied the
 * content for BOTH cards: one search's results rendered under the other's query,
 * while the other card read "0 results".
 *
 * Seen in a real session and confirmed against the search log — the searches
 * themselves were correct and the model received them correctly, so the damage was
 * confined to the display. That is arguably the worse place for it: the transcript
 * then contradicts what the agent says it found, and there is nothing on screen to
 * suggest the pairing is what went wrong.
 *
 * The name scan REMAINS as the fallback for rows that genuinely have no call id
 * (legacy tool starts, text-tool invocations). It is only reached when the caller
 * has no id to match on, so it cannot re-introduce the crossing on the native path.
 *
 * Pure and separate from `useStreamChat` so the pairing can be tested directly.
 */

export type ToolActivityLike = {
  chatId?: number | null;
  type?: string;
  toolName?: string;
  toolCallId?: string;
  label?: string;
  resultText?: string;
  detail?: string;
};

export function findToolActivityResult(
  activities: readonly ToolActivityLike[],
  chatId: number,
  toolName: string,
  toolCallId?: string,
): { resultText?: string; detail?: string } {
  const normalized = toolName.trim();
  const callId = toolCallId?.trim();
  if (!normalized && !callId) return {};

  for (let i = activities.length - 1; i >= 0; i--) {
    const item = activities[i]!;
    if (item.chatId != null && item.chatId !== chatId) continue;
    if (item.type !== "tool_use") continue;
    if (callId) {
      if (item.toolCallId?.trim() !== callId) continue;
    } else {
      const name = (item.toolName ?? item.label ?? "").trim();
      if (name !== normalized) continue;
    }
    const resultText = item.resultText?.trim();
    const detail = item.detail?.trim();
    if (resultText || detail) return { resultText, detail };
  }
  return {};
}
