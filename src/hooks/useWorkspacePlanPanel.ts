import { useEffect, useMemo } from "react";
import { useAtom, useAtomValue, getDefaultStore } from "jotai";
import { useSearch } from "@tanstack/react-router";
import {
  workspacePlanPanelAtom,
  pendingProposalsAtom,
  previewTabAtom,
  planUnreadAtom,
} from "@/atoms/sourceAtoms";
import { messagesForChatAtom } from "@/atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import type { PlanArtifactPayload } from "@/ipc/utils/emit_plan_artifact";
import {
  resolvePlanChanges,
  type PlanChangesPayload,
} from "@/lib/plan-changes/plan-changes";

function applyPayloadToPanel(
  payload: PlanArtifactPayload,
  setPanel: (
    update: import("react").SetStateAction<
      import("jotai").ExtractAtomValue<typeof workspacePlanPanelAtom>
    >,
  ) => void,
  changes: PlanChangesPayload | null,
): void {
  setPanel((prev) => ({
    planId: payload.planId,
    content: payload.content,
    planStatus: payload.planStatus,
    sessionId: payload.sessionId,
    title: payload.title,
    changes,
    // A pin belongs to the user, not to the payload — carry it across.
    pinnedPlanId: prev.pinnedPlanId,
  }));
}

/**
 * Subscribes to plan artifact IPC and keeps workspacePlanPanelAtom in sync.
 */
export function useWorkspacePlanPanel(): void {
  const [, setPanel] = useAtom(workspacePlanPanelAtom);
  const proposals = useAtomValue(pendingProposalsAtom);

  let chatId: number | undefined;
  try {
    const search = useSearch({ strict: false }) as
      | { id?: number | string }
      | undefined;
    const id = search?.id;
    chatId = id != null ? Number(id) : undefined;
  } catch {
    chatId = undefined;
  }

  // Derive from the raw per-chat array reference (stable between renders unless
  // messages actually change) and memoize, so `messages` has a stable identity.
  // Without this the fresh `.map()` made the effects below re-run every render.
  // One chat's slice (not the whole map, which changes on every streamed flush
  // of every chat). 0 is no chat's id, so it reads as empty.
  const rawMessages = useAtomValue(
    messagesForChatAtom(chatId != null && !Number.isNaN(chatId) ? chatId : 0),
  );
  const messages = useMemo(
    () =>
      (rawMessages ?? []).map((m) => ({
        role: m.role,
        content: String(m.content ?? ""),
      })),
    [rawMessages],
  );

  useEffect(() => {
    const onActivated = (payload: PlanArtifactPayload) => {
      // A user-pinned plan is not replaced by an activation for a different one:
      // the panel would otherwise be yanked away mid-read the moment the agent
      // touched another plan. The badge below still says something happened.
      const pinned = getDefaultStore().get(workspacePlanPanelAtom).pinnedPlanId;
      if (pinned && pinned !== payload.planId) {
        if (getDefaultStore().get(previewTabAtom) !== "plan") {
          getDefaultStore().set(planUnreadAtom, true);
        }
        return;
      }
      const changes = resolvePlanChanges(messages, payload.content, proposals);
      applyPayloadToPanel(payload, setPanel, changes);
      // The plan is LOADED but the panel is not seized.
      //
      // This used to switch the right panel to Plan and force it open (v13.1,
      // "surface the Plan tab once when a session with an active plan loads").
      // Reopening a session is "let me look at this again", not "resume that
      // plan" — and with several plans in a session only the newest is restored,
      // so one plan was presented as though it were THE plan with nothing saying
      // the others existed.
      //
      // A badge carries the same information without the takeover: the plan is
      // here, the transcript still has its inline card, and the tab is one click
      // away. If the tab is already the one on screen there is nothing unread.
      if (getDefaultStore().get(previewTabAtom) !== "plan") {
        getDefaultStore().set(planUnreadAtom, true);
      }
    };
    const onUpdated = (payload: PlanArtifactPayload) => {
      setPanel((prev) => {
        if (prev.planId && prev.planId !== payload.planId) return prev;
        const changes = resolvePlanChanges(messages, payload.content, proposals);
        return {
          planId: payload.planId,
          content: payload.content,
          planStatus: payload.planStatus,
          sessionId: payload.sessionId,
          title: payload.title,
          changes: changes ?? prev.changes,
          pinnedPlanId: prev.pinnedPlanId,
        };
      });
    };
    const unsubA = IpcClient.getInstance().onPlanArtifactActivated(onActivated);
    const unsubU = IpcClient.getInstance().onPlanArtifactUpdated(onUpdated);
    return () => {
      unsubA();
      unsubU();
    };
  }, [messages, proposals, setPanel]);

  useEffect(() => {
    setPanel((prev) => {
      if (!prev.content) return prev;
      const changes = resolvePlanChanges(messages, prev.content, proposals);
      const next = changes ?? prev.changes;
      // Return the SAME object when nothing changed so jotai does not write a
      // new reference — otherwise this effect's own write retriggers the render
      // that re-runs it (React #185 "Maximum update depth exceeded").
      if (changesEqual(next, prev.changes)) return prev;
      return { ...prev, changes: next };
    });
  }, [messages, proposals, setPanel]);
}

/** Cheap structural equality for the plain, serializable plan-changes payload. */
function changesEqual(
  a: PlanChangesPayload | null,
  b: PlanChangesPayload | null,
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
