import { useEffect, useCallback } from "react";
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
  setPanel: ReturnType<typeof useAtom<typeof workspacePlanPanelAtom>>[1],
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

  const messages =
    chatId != null && !Number.isNaN(chatId)
      ? (messagesByChatId[chatId] ?? []).map((m) => ({
          role: m.role,
          content: String(m.content ?? ""),
        }))
      : [];

  const syncChanges = useCallback(
    (content: string | null) => {
      const changes = resolveChanges(messages, content, proposals);
      setPanel((prev) => ({ ...prev, changes: changes ?? prev.changes }));
    },
    [messages, proposals, setPanel],
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
      return { ...prev, changes: changes ?? prev.changes };
    });
  }, [messages, proposals, setPanel]);
}
