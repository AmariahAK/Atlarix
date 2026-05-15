import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";

export interface PromptItem {
  id: number;
  title: string;
  description: string | null;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

export function usePrompts() {
  const queryClient = useQueryClient();
  // PASS8 F3: `prompts:list` is the deprecated legacy endpoint and always
  // returns []. The active prompts live under `prompts:get-global` /
  // `prompts:get-workspace`. We keep the query around for the (single)
  // LexicalChatInput consumer, but mark it as never stale so it fires once
  // per process instead of on every mutation / message dispatch.
  const listQuery = useQuery({
    queryKey: ["prompts"],
    queryFn: async (): Promise<PromptItem[]> => {
      const ipc = IpcClient.getInstance();
      return ipc.listPrompts();
    },
    meta: { showErrorToast: true },
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
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
      return ipc.deletePrompt(id);
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
