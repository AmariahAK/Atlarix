import { useEffect, useRef } from "react";
import { useQuery, QueryClient } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import { useAtom, useSetAtom } from "jotai";
import { toast } from "sonner";
import { currentAppAtom } from "@/atoms/appAtoms";
import { diagramStateAtom, rightPanelVisibleAtom, previewTabAtom, diagramStalenessAtom, pinnedPanelAtom } from "@/atoms/sourceAtoms";

export function useLoadApp(appId: number | null) {
  const [, setApp] = useAtom(currentAppAtom);
  const setDiagramState = useSetAtom(diagramStateAtom);
  const setDiagramStaleness = useSetAtom(diagramStalenessAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const setPreviewTab = useSetAtom(previewTabAtom);
  const setPinnedPanel = useSetAtom(pinnedPanelAtom);
  const loadedAppIdRef = useRef<number | null>(null);

  const { data: appData, isLoading: loading, error, refetch: refreshApp } = useQuery({
    queryKey: ['app', appId],
    queryFn: async () => {
      if (appId === null) return null;
      try {
        const app = await IpcClient.getInstance().getApp(appId);
        return app;
      } catch (err) {
        console.error('Error fetching app:', err);
        throw err;
      }
    },
    enabled: appId !== null,
  });

  useEffect(() => {
    if (appId === null) {
      setApp(null);
      setDiagramState(null);
      setDiagramStaleness(null);
      loadedAppIdRef.current = null;
    } else if (appData !== undefined) {
      if (loadedAppIdRef.current === appId) return;
      loadedAppIdRef.current = appId;

      if (!appData) return;
      setApp(appData);

      if (appData.fileDiscoveryWarnings?.length) {
        for (const msg of appData.fileDiscoveryWarnings) {
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

      if (appData.pathExists === false) {
        loadedAppIdRef.current = appId;
        return;
      }

      const loadDiagram = async () => {
        try {
          const result = await IpcClient.getInstance().listDiagrams({ workspaceId: appId });
          if (result.success && result.diagrams.length > 0) {
            const latestDiagram = result.diagrams[0];
            setDiagramState({
              id: latestDiagram.id,
              code: latestDiagram.content || '',
              type: latestDiagram.type || 'mermaid',
              title: latestDiagram.title,
              compareMode: 'current',
              workspaceId: appId,
            });
            setPinnedPanel('code-preview');
            setRightPanelVisible(true);
            setPreviewTab('diagram');
            console.log(`[useLoadApp] Loaded diagram for workspace ${appId}: ${latestDiagram.title}`);
          } else {
            console.log(`[useLoadApp] No saved diagram for workspace ${appId}. Model can generate on demand.`);
          }
          setDiagramStaleness(null);
        } catch (err) {
          console.error('[useLoadApp] Failed to load diagram:', err);
        }
      };

      loadDiagram();
    }
  }, [appId, appData, setApp, setDiagramState, setDiagramStaleness, setRightPanelVisible, setPreviewTab, setPinnedPanel]);

  return { app: appData, loading, error, refreshApp };
}

export const invalidateAppQuery = (
  queryClient: QueryClient,
  { appId }: { appId: number | null },
) => {
  return queryClient.invalidateQueries({ queryKey: ["app", appId] });
};
