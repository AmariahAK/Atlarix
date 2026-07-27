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

      // Tell main which workspace THIS window is showing. Main has no other way
      // to know — a window opened from the UI never announced its workspace, so
      // the workspace→window registry was empty and per-window events had to be
      // broadcast to every window. Also what names the window after its project.
      //
      // Done here because this is the single choke point every workspace load
      // goes through (same reasoning as the v14.16.1 provider-refresh fix); the
      // guard above means it fires once per workspace, not per render.
      if (appData.path) {
        void IpcClient.getInstance()
          .bindWindowToWorkspace(appData.path)
          .catch(() => {
            /* cosmetic + routing hint only — never block loading a workspace */
          });
      }
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
