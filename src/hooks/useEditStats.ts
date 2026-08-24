import { useQuery } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import type { EditStatsSummary } from "@/ipc/ipc_types";

/**
 * Lines the agent has written, aggregated per workspace and per model.
 *
 * Local-only data (a SQLite rollup on this machine), so there is nothing to keep
 * fresh between windows and no reason to refetch on focus — a `staleTime` keeps the
 * profile page from re-querying every time it mounts.
 */
export function useEditStats() {
  const ipcClient = IpcClient.getInstance();

  return useQuery<EditStatsSummary, Error>({
    queryKey: ["edit-stats-summary"],
    queryFn: async () => ipcClient.getEditStatsSummary(),
    staleTime: 60_000,
  });
}
