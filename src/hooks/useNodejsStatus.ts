import { useQuery } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import type { NodeSystemInfo } from "@/ipc/ipc_types";

export const NODEJS_STATUS_QUERY_KEY = ["nodejsStatus"] as const;

const STALE_MS = 5 * 60 * 1000;

export function useNodejsStatus() {
  return useQuery<NodeSystemInfo, Error>({
    queryKey: NODEJS_STATUS_QUERY_KEY,
    queryFn: () => IpcClient.getInstance().getNodejsStatus(),
    staleTime: STALE_MS,
    gcTime: STALE_MS,
    refetchOnWindowFocus: false,
  });
}
