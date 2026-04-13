/**
 * Per-turn activity display.
 *
 * Refactor: ThoughtsPanel — prefer a simple group-chat UI for guided/autonomous delegation.
 */

import { useAtomValue } from "jotai";
import { useSettings } from "@/hooks/useSettings";
import { activeChatIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
import { activityStreamItemsAtom, type ActivityStreamItem } from "@/atoms/sourceAtoms";
import { ThoughtsPanel } from "./chat/ThoughtsPanel";
import { cn } from "@/lib/utils";

const COUNSEL_ACTIVITY_TYPES: ActivityStreamItem["type"][] = [
  "counsel_start",
  "counsel_participant_complete",
  "counsel_synthesising",
  "counsel_complete",
];

/** True when inline ThoughtsPanel should render (delegation, bus, counsel, or tool-heavy agent turns). */
export function shouldRenderInlineThoughtsPanel(
  items: ActivityStreamItem[],
  agentMode: string | undefined,
): boolean {
  const mode = agentMode ?? "guided";
  const hasDelegationStyle = items.some(
    (i) =>
      i.type === "delegation_start" ||
      i.type === "delegation_complete" ||
      i.type === "delegation_error" ||
      (i.type === "delegation" && i.id) ||
      i.type === "parallel_prefetch_start" ||
      i.type === "agent_message",
  );
  const hasCounsel = items.some((i) => COUNSEL_ACTIVITY_TYPES.includes(i.type));
  const hasToolUseForAgentMode =
    (mode === "guided" || mode === "autonomous") && items.some((i) => i.type === "tool_use");
  return hasDelegationStyle || hasCounsel || hasToolUseForAgentMode;
}

/** Activity rows for the chat that owns the inline panel (matches ThoughtsPanel chat filter). */
export function activityStreamItemsForChat(
  items: ActivityStreamItem[],
  chatId: number | null | undefined,
): ActivityStreamItem[] {
  if (chatId == null) return items;
  return items.filter((i) => i.chatId == null || i.chatId === chatId);
}

export function inlineThoughtsPanelVisible(
  items: ActivityStreamItem[],
  chatId: number | null | undefined,
  agentMode: string | undefined,
): boolean {
  const panelItems = activityStreamItemsForChat(items, chatId);
  return (
    panelItems.length > 0 && shouldRenderInlineThoughtsPanel(panelItems, agentMode)
  );
}

/** Bordered inline block when activity warrants ThoughtsPanel (delegation, counsel, tools in agent modes). */
export function InlineThoughtsBlock({ className }: { className?: string }) {
  const { settings } = useSettings();
  const items = useAtomValue(activityStreamItemsAtom);
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const activeChatId = useAtomValue(activeChatIdAtom);
  const chatId = activeChatId ?? selectedChatId;
  const agentMode = settings?.agentMode ?? "guided";
  if (!inlineThoughtsPanelVisible(items, chatId, agentMode)) return null;
  return (
    <div
      className={cn(
        "mt-2 rounded-lg border border-border/50 bg-muted/20 overflow-hidden min-h-0",
        className,
      )}
    >
      <ThoughtsPanel variant="inline" />
    </div>
  );
}

/** @deprecated Prefer InlineThoughtsBlock in chat; kept for imports. */
export function ActivityDisplay() {
  const { settings } = useSettings();
  const items = useAtomValue(activityStreamItemsAtom);
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const activeChatId = useAtomValue(activeChatIdAtom);
  const chatId = activeChatId ?? selectedChatId;
  const agentMode = settings?.agentMode ?? "guided";
  if (!inlineThoughtsPanelVisible(items, chatId, agentMode)) return null;
  return <ThoughtsPanel variant="inline" />;
}
