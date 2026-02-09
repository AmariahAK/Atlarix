/**
 * Per-turn activity display: one of text-only, Guided pipeline, or Autonomous graph.
 * Direct -> text only. Guided + delegations -> GuidedPipeline. Autonomous + delegations -> AutonomousGraph.
 */

import { useAtomValue } from "jotai";
import { useSettings } from "@/hooks/useSettings";
import { activityStreamItemsAtom } from "@/atoms/sourceAtoms";
import { ActivityStream } from "./ActivityStream";
import { GuidedPipeline } from "./chat/GuidedPipeline";
import { AutonomousGraph } from "./chat/AutonomousGraph";

export function ActivityDisplay() {
  const { settings } = useSettings();
  const items = useAtomValue(activityStreamItemsAtom);

  const agentMode = settings?.agentMode ?? "guided";
  const forceTextOnly =
    settings?.aiConfiguration?.activityStream?.detailLevel === "minimal";

  const hasDelegationEvents = items.some(
    (i) =>
      i.type === "delegation_start" ||
      i.type === "delegation_complete" ||
      i.type === "delegation_error" ||
      (i.type === "delegation" && i.id)
  );

  if (forceTextOnly) {
    return <ActivityStream />;
  }

  if (agentMode === "direct" || !hasDelegationEvents) {
    return <ActivityStream />;
  }

  if (agentMode === "guided") {
    return <GuidedPipeline />;
  }

  if (agentMode === "autonomous") {
    return <AutonomousGraph />;
  }

  return <ActivityStream />;
}
