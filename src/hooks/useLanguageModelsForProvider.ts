import { useQuery } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import type { LanguageModel } from "@/ipc/ipc_types";

/**
 * Fetches the list of available language models for a specific provider.
 *
 * @param providerId The ID of the language model provider.
 * @returns TanStack Query result object for the language models.
 */
export function useLanguageModelsForProvider(providerId: string | undefined) {
  const ipcClient = IpcClient.getInstance();

  return useQuery<
    LanguageModel[],
    Error // Specify Error type for better error handling
  >({
    queryKey: ["language-models", providerId],
    queryFn: async () => {
      if (!providerId) {
        // Avoid calling IPC if providerId is not set
        // Return an empty array as it's a query, not an error state
        return [];
      }
      return ipcClient.getLanguageModels({ providerId });
    },
    enabled: !!providerId,
    // Per-provider model fetch is expensive (provider API / models.dev catalog);
    // cache briefly so remounts don't refetch. Provider CRUD + the manual refresh
    // invalidate this key when the set actually changes.
    staleTime: 5 * 60_000,
  });
}
