import { useQuery } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import type { AtlarixCoreTierPresentation } from "@/lib/atlarix-core-catalog";

export const ATLARIX_CORE_CATALOG_QUERY_KEY = ["atlarixCoreTierCatalog"] as const;

export function useAtlarixCoreCatalog() {
  return useQuery<AtlarixCoreTierPresentation[], Error>({
    queryKey: ATLARIX_CORE_CATALOG_QUERY_KEY,
    queryFn: () => IpcClient.getInstance().getAtlarixCoreTierCatalog(),
    staleTime: 60_000,
  });
}
