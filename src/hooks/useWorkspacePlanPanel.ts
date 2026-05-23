import { useEffect, useCallback } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useSearch } from "@tanstack/react-router";
import { currentAppAtom, selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";
import { workspacePlanPanelAtom, pendingProposalsAtom } from "@/atoms/sourceAtoms";
import { chatMessagesByIdAtom } from "@/atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import type { PlanUpdatePayload } from "@/ipc/ipc_types";
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

/**
 * Loads `.atlarix/ATLARIX_PLAN.md`, subscribes to ledger + file updates, and keeps `workspacePlanPanelAtom`.
 */
export function useWorkspacePlanPanel(): void {
  const currentApp = useAtomValue(currentAppAtom);
  const selectedWorkspace = useAtomValue(selectedWorkspaceInfoAtom);
  const workspacePath = (currentApp?.path || selectedWorkspace?.path || "").trim();
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

  const reloadMarkdown = useCallback(async () => {
    if (!workspacePath) return;
    const result = await IpcClient.getInstance().readPlanWorkspaceFile(workspacePath);
    const markdown = result.content;
    const changes = resolveChanges(messages, markdown, proposals);
    setPanel((prev) => ({
      ...prev,
      markdown,
      changes: changes ?? prev.changes,
    }));
  }, [workspacePath, messages, proposals, setPanel]);

  useEffect(() => {
    if (!workspacePath) return;
    void reloadMarkdown();
  }, [workspacePath, reloadMarkdown]);

  useEffect(() => {
    if (!workspacePath) return;
    const unsubFile = IpcClient.getInstance().onPlanFileUpdated((payload) => {
      if (payload.workspacePath !== workspacePath) return;
      void reloadMarkdown();
    });
    return unsubFile;
  }, [workspacePath, reloadMarkdown]);

  useEffect(() => {
    if (chatId == null || Number.isNaN(chatId)) return;
    const unsub = IpcClient.getInstance().onPlanUpdate(chatId, (payload: PlanUpdatePayload) => {
      setPanel((prev) => {
        const changes =
          prev.changes ??
          resolveChanges(messages, prev.markdown, proposals);
        return { ...prev, ledger: payload, changes };
      });
    });
    return unsub;
  }, [chatId, messages, proposals, setPanel]);

  useEffect(() => {
    setPanel((prev) => {
      const changes = resolveChanges(messages, prev.markdown, proposals);
      if (!changes) return prev;
      return { ...prev, changes };
    });
  }, [messages, proposals, setPanel]);
}
