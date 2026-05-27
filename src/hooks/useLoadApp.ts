import { useEffect, useRef } from "react";
import { useQuery, QueryClient } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import { useAtom, useSetAtom } from "jotai";
import { toast } from "sonner";
import { currentAppAtom } from "@/atoms/appAtoms";
import { diagramStateAtom, diagramStalenessAtom } from "@/atoms/sourceAtoms";

export function useLoadApp(appId: number | null) {
  const [, setApp] = useAtom(currentAppAtom);
  const setDiagramState = useSetAtom(diagramStateAtom);
  const setDiagramStaleness = useSetAtom(diagramStalenessAtom);
  const loadedAppIdRef = useRef<number | null>(null);

  const isAppNotFoundError = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes("App not found") || msg.includes("not found");
  };

  const fileListStaleMs = 5 * 60 * 1000;

  const { data: appData, isLoading: loading, error, refetch: refreshApp } = useQuery({
    queryKey: ['app', appId],
    queryFn: async () => {
      if (appId === null) return null;
      try {
        return await IpcClient.getInstance().getApp(appId);
      } catch (err) {
        if (isAppNotFoundError(err)) {
          return null;
        }
        console.error('Error fetching app:', err);
        throw err;
      }
    },
    enabled: appId !== null,
    retry: false,
    staleTime: fileListStaleMs,
    gcTime: fileListStaleMs,
  });

  const { data: appFilesData } = useQuery({
    queryKey: ['app-files', appId],
    queryFn: async () => {
      if (appId === null) return null;
      return IpcClient.getInstance().getAppFiles(appId);
    },
    enabled: appId !== null,
    retry: false,
    staleTime: fileListStaleMs,
    gcTime: fileListStaleMs,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (appId === null) {
      setApp(null);
      setDiagramState(null);
      setDiagramStaleness(null);
      loadedAppIdRef.current = null;
    } else if (appData !== undefined) {
      if (!appData) {
        setApp(null);
        setDiagramState(null);
        setDiagramStaleness(null);
        loadedAppIdRef.current = null;
        return;
      }

      if (loadedAppIdRef.current === appId) return;
      loadedAppIdRef.current = appId;

      const files = appFilesData?.files ?? appData.files ?? [];
      const fileDiscoveryWarnings =
        appFilesData?.fileDiscoveryWarnings ?? appData.fileDiscoveryWarnings;
      setApp({ ...appData, files, fileDiscoveryWarnings });

      if (fileDiscoveryWarnings?.length) {
        for (const msg of fileDiscoveryWarnings) {
          toast.warning(msg, { duration: 9000 });
        }
      }

      if (appData.workspaceDiscoveryHints && appData.pathExists !== false && appId !== null) {
        const disc = appData.workspaceDiscoveryHints;
        const key = `atlarix:discovery-hint:${appId}`;
        try {
          if (!sessionStorage.getItem(key)) {
            sessionStorage.setItem(key, "1");
            if (disc.isMultiRepoWorkspace) {
              toast.message("Multi-repo workspace", {
                description:
                  "File discovery and repo overview are scoped to nested git repos. Open a single repo folder if you only need one project.",
                duration: 10_000,
              });
            } else if (!disc.hasRootGit) {
              toast.warning(
                "This workspace root has no .git folder. File discovery may be degraded; open a repository subfolder when possible.",
                { duration: 9000 },
              );
            }
          }
        } catch {
          /* sessionStorage unavailable */
        }
      }

      setDiagramStaleness(null);
    }
  }, [appId, appData, appFilesData, setApp, setDiagramState, setDiagramStaleness]);

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
