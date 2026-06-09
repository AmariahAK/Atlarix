import { useEffect, useMemo } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useSearch } from "@tanstack/react-router";
import { workspacePlanPanelAtom, pendingProposalsAtom } from "@/atoms/sourceAtoms";
import { chatMessagesByIdAtom } from "@/atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import type { PlanArtifactPayload } from "@/ipc/utils/emit_plan_artifact";
import {
  parsePlanChangesFromContent,
  deriveFilesFromPlanMarkdown,
  type PlanChangesPayload,
  type PlanFileAction,
} from "@/lib/plan-changes/plan-changes";

function proposalsToChanges(
  proposals: { path: string; operation: string }[],
): PlanChangesPayload | null {
  if (!proposals.length) return null;
  const files = proposals
    .filter((p) => p.path?.trim())
    .map((p) => {
      let action: PlanFileAction = "MODIFY";
      if (p.operation === "create") action = "CREATE";
      else if (p.operation === "delete") action = "DELETE";
      return { path: p.path, action };
    });
  return files.length ? { files } : null;
}

function resolveChanges(
  messages: { role: string; content: string }[],
  markdown: string | null,
  proposals: { path: string; operation: string }[],
): PlanChangesPayload | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const parsed = parsePlanChangesFromContent(m.content);
    if (parsed) return parsed;
  }
  const fromProposals = proposalsToChanges(proposals);
  if (fromProposals) return fromProposals;
  if (markdown) {
    const derived = deriveFilesFromPlanMarkdown(markdown);
    if (derived.length) return { files: derived };
  }
  return null;
}

function applyPayloadToPanel(
  payload: PlanArtifactPayload,
  setPanel: (
    update: import("react").SetStateAction<
      import("jotai").ExtractAtomValue<typeof workspacePlanPanelAtom>
    >,
  ) => void,
  changes: PlanChangesPayload | null,
): void {
  setPanel({
    planId: payload.planId,
    content: payload.content,
    planStatus: payload.planStatus,
    sessionId: payload.sessionId,
    changes,
  });
}

/**
 * Subscribes to plan artifact IPC and keeps workspacePlanPanelAtom in sync.
 */
export function useWorkspacePlanPanel(): void {
  const [, setPanel] = useAtom(workspacePlanPanelAtom);
  const proposals = useAtomValue(pendingProposalsAtom);
  const messagesByChatId = useAtomValue(chatMessagesByIdAtom);

  let chatId: number | undefined;
  try {
    const search = useSearch({ strict: false }) as { id?: number | string } | undefined;
    const id = search?.id;
    chatId = id != null ? Number(id) : undefined;
  } catch {
    chatId = undefined;
  }

  // Derive from the raw per-chat array reference (stable between renders unless
  // messages actually change) and memoize, so `messages` has a stable identity.
  // Without this the fresh `.map()` made the effects below re-run every render.
  const rawMessages =
    chatId != null && !Number.isNaN(chatId)
      ? messagesByChatId.get(chatId)
      : undefined;
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
      const changes = resolveChanges(messages, payload.content, proposals);
      applyPayloadToPanel(payload, setPanel, changes);
    };
    const onUpdated = (payload: PlanArtifactPayload) => {
      setPanel((prev) => {
        if (prev.planId && prev.planId !== payload.planId) return prev;
        const changes = resolveChanges(messages, payload.content, proposals);
        return {
          planId: payload.planId,
          content: payload.content,
          planStatus: payload.planStatus,
          sessionId: payload.sessionId,
          changes: changes ?? prev.changes,
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
      const changes = resolveChanges(messages, prev.content, proposals);
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
