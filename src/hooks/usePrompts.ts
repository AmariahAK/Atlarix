import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { IpcClient } from "@/ipc/ipc_client";
import { selectedAppIdAtom } from "@/atoms/appAtoms";

export interface PromptItem {
  id: number;
  title: string;
  description: string | null;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

function mapGlobalRow(
  row: NonNullable<Awaited<ReturnType<IpcClient["getGlobalPrompt"]>>>,
): PromptItem {
  return {
    id: row.id,
    title: "Global prompt",
    description: null,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapWorkspaceRow(
  row: NonNullable<Awaited<ReturnType<IpcClient["getWorkspacePrompt"]>>>,
): PromptItem {
  return {
    id: row.id,
    title: "Workspace prompt",
    description: null,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function usePrompts() {
  const queryClient = useQueryClient();
  const selectedAppId = useAtomValue(selectedAppIdAtom);

  const listQuery = useQuery({
    queryKey: ["prompts", selectedAppId],
    queryFn: async (): Promise<PromptItem[]> => {
      const ipc = IpcClient.getInstance();
      const [globalRow, workspaceRow] = await Promise.all([
        ipc.getGlobalPrompt(),
        selectedAppId != null
          ? ipc.getWorkspacePrompt(selectedAppId)
          : Promise.resolve(null),
      ]);
      const out: PromptItem[] = [];
      if (globalRow) out.push(mapGlobalRow(globalRow));
      if (workspaceRow) out.push(mapWorkspaceRow(workspaceRow));
      return out;
    },
    meta: { showErrorToast: true },
    refetchOnMount: true,
  });

  const createMutation = useMutation({
    mutationFn: async (params: {
      title: string;
      description?: string;
      content: string;
    }): Promise<PromptItem> => {
      const ipc = IpcClient.getInstance();
      return ipc.createPrompt(params);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
    meta: {
      showErrorToast: true,
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (params: {
      id: number;
      title: string;
      description?: string;
      content: string;
    }): Promise<void> => {
      const ipc = IpcClient.getInstance();
      return ipc.updatePrompt(params);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
    meta: {
      showErrorToast: true,
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number): Promise<void> => {
      const ipc = IpcClient.getInstance();
      const globalRow = await ipc.getGlobalPrompt();
      if (globalRow?.id === id) {
        await ipc.deleteGlobalPrompt();
        return;
      }
      if (selectedAppId != null) {
        const workspaceRow = await ipc.getWorkspacePrompt(selectedAppId);
        if (workspaceRow?.id === id) {
          await ipc.deleteWorkspacePrompt(selectedAppId);
          return;
        }
      }
      await ipc.deletePrompt(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
    meta: {
      showErrorToast: true,
    },
  });

  return {
    prompts: listQuery.data ?? [],
    isLoading: listQuery.isLoading,
    error: listQuery.error,
    refetch: listQuery.refetch,
    createPrompt: createMutation.mutateAsync,
    updatePrompt: updateMutation.mutateAsync,
    deletePrompt: deleteMutation.mutateAsync,
  };
}
