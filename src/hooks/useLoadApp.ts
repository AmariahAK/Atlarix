import { useEffect, useRef } from "react";
import { useQuery, QueryClient } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import { useAtom, useSetAtom } from "jotai";
import { currentAppAtom } from "@/atoms/appAtoms";
import { diagramStateAtom, rightPanelVisibleAtom, previewTabAtom } from "@/atoms/sourceAtoms";
import { App } from "@/ipc/ipc_types";

export function useLoadApp(appId: number | null) {
  const [, setApp] = useAtom(currentAppAtom);
  const setDiagramState = useSetAtom(diagramStateAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const setPreviewTab = useSetAtom(previewTabAtom);
  const loadedAppIdRef = useRef<number | null>(null);

  // Fetch app data
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

  // Sync app data to atom and load diagrams
  useEffect(() => {
    if (appId === null) {
      setApp(null);
      setDiagramState(null);
      loadedAppIdRef.current = null;
    } else if (appData !== undefined) {
      // Prevent duplicate loading for the same app ID
      if (loadedAppIdRef.current === appId) return;
      loadedAppIdRef.current = appId;

      setApp(appData);

      // Load diagram for this workspace
      const loadDiagram = async () => {
        try {
          const result = await IpcClient.getInstance().listDiagrams({ workspaceId: appId });
          if (result.success && result.diagrams.length > 0) {
            // Get the most recent diagram
            const latestDiagram = result.diagrams[0];
            setDiagramState({
              code: latestDiagram.content || '',
              type: latestDiagram.type || 'mermaid',
              title: latestDiagram.title,
              compareMode: 'current',
            });
            // Auto-open right panel with diagram tab
            setRightPanelVisible(true);
            setPreviewTab('diagram');
            console.log(`[useLoadApp] Loaded diagram for workspace ${appId}: ${latestDiagram.title}`);
          } else {
            console.log(`[useLoadApp] No saved diagram for workspace ${appId}.`);
            // Do not auto-generate. Let the user decide when to generate.
          }
        } catch (err) {
          console.error('[useLoadApp] Failed to load diagram:', err);
        }
      };

      loadDiagram();
    }
  }, [appId, appData, setApp, setDiagramState, setRightPanelVisible, setPreviewTab]);

  return { app: appData, loading, error, refreshApp };
}

// Function to invalidate the app query
export const invalidateAppQuery = (
  queryClient: QueryClient,
  { appId }: { appId: number | null },
) => {
  return queryClient.invalidateQueries({ queryKey: ["app", appId] });
};
