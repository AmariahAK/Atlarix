import { useEffect, useRef } from "react";
import { useQuery, QueryClient } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import { useAtom } from "jotai";
import { currentAppAtom } from "@/atoms/appAtoms";

export function useLoadApp(appId: number | null) {
  const [, setApp] = useAtom(currentAppAtom);
  const loadedAppIdRef = useRef<number | null>(null);

  const isAppNotFoundError = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes("App not found") || msg.includes("not found");
  };

  const appStaleMs = 5 * 60 * 1000;

  const { data: appData, isLoading: loading, error, refetch: refreshApp } = useQuery({
    queryKey: ["app", appId],
    queryFn: async () => {
      if (appId === null) return null;
      try {
        return await IpcClient.getInstance().getApp(appId);
      } catch (err) {
        if (isAppNotFoundError(err)) {
          return null;
        }
        console.error("Error fetching app:", err);
        throw err;
      }
    },
    enabled: appId !== null,
    retry: false,
    staleTime: appStaleMs,
    gcTime: appStaleMs,
  });

  useEffect(() => {
    if (appId === null) {
      setApp(null);
      loadedAppIdRef.current = null;
    } else if (appData !== undefined) {
      if (!appData) {
        setApp(null);
        loadedAppIdRef.current = null;
        return;
      }

      if (loadedAppIdRef.current === appId) return;
      loadedAppIdRef.current = appId;

      setApp(appData);
    }
  }, [appId, appData, setApp]);

  return { app: appData, loading, error, refreshApp };
}

export const invalidateAppQuery = (
  queryClient: QueryClient,
  { appId }: { appId: number | null },
) => {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["app", appId] }),
    queryClient.invalidateQueries({ queryKey: ["app-files", appId] }),
  ]);
};
