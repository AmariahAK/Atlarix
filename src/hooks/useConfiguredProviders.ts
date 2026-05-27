import { useQuery } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";

/** All provider-setup UI must use this hook — do not call getConfiguredProviders IPC directly. */
export const CONFIGURED_PROVIDERS_QUERY_KEY = ["configuredProviders"] as const;

const STALE_MS = 5 * 60 * 1000;

export function useConfiguredProviders() {
  return useQuery<string[], Error>({
    queryKey: CONFIGURED_PROVIDERS_QUERY_KEY,
    queryFn: () => IpcClient.getInstance().getConfiguredProviders(),
    staleTime: STALE_MS,
    gcTime: STALE_MS,
    refetchOnWindowFocus: false,
  });
}
