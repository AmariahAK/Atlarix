import { useQuery } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import type { LanguageModel } from "@/ipc/ipc_types";

/**
 * Fetches all available language models grouped by their provider IDs.
 *
 * @returns TanStack Query result object for the language models organized by provider.
 */
export function useLanguageModelsByProviders() {
  const ipcClient = IpcClient.getInstance();

  return useQuery<Record<string, LanguageModel[]>, Error>({
    queryKey: ["language-models-by-providers"],
    queryFn: async () => {
      return ipcClient.getLanguageModelsByProviders();
    },
    // Building this list is expensive (DB + the full models.dev catalog for
    // every provider). Without a staleTime it refetches on every component mount
    // and window focus — and many per-message components subscribe to it, which
    // hammers the main thread. Model sets change rarely and the events that do
    // change them (provider CRUD, core-models refresh, the manual "Refresh model
    // list" button) invalidate this key explicitly, so a few-minute cache is safe.
    staleTime: 5 * 60_000,
  });
}
