/**
 * Per-turn activity display.
 *
 * Refactor: ThoughtsPanel — prefer a simple group-chat UI for guided/autonomous delegation.
 */

import { useAtomValue } from "jotai";
import { useSettings } from "@/hooks/useSettings";
import { activityStreamItemsAtom } from "@/atoms/sourceAtoms";
import { ThoughtsPanel } from "./chat/ThoughtsPanel";

export function ActivityDisplay() {
  const { settings } = useSettings();
  const items = useAtomValue(activityStreamItemsAtom);

  const agentMode = settings?.agentMode ?? "guided";

  const hasDelegationEvents = items.some(
    (i) =>
      i.type === "delegation_start" ||
      i.type === "delegation_complete" ||
      i.type === "delegation_error" ||
      (i.type === "delegation" && i.id)
  );

  if (agentMode === "guided" || agentMode === "autonomous") {
    return <ThoughtsPanel />;
  }

  // If we have delegation events even in other modes, still show the panel.
  if (hasDelegationEvents) {
    return <ThoughtsPanel />;
  }

  // No delegation: nothing to render here (ToolIndicator + ThinkingCard cover normal status).
  return null;
}
