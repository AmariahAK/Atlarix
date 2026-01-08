import { useEffect, useRef } from "react";
import { useQuery, QueryClient } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import { useAtom, useSetAtom } from "jotai";
import { currentAppAtom } from "@/atoms/appAtoms";
import { diagramStateAtom, rightPanelVisibleAtom, previewTabAtom, diagramStalenessAtom } from "@/atoms/sourceAtoms";
import { App } from "@/ipc/ipc_types";

export function useLoadApp(appId: number | null) {
  const [, setApp] = useAtom(currentAppAtom);
  const setDiagramState = useSetAtom(diagramStateAtom);
  const setDiagramStaleness = useSetAtom(diagramStalenessAtom);
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
      setDiagramStaleness(null);
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
              id: latestDiagram.id,
              code: latestDiagram.content || '',
              type: latestDiagram.type || 'mermaid',
              title: latestDiagram.title,
              compareMode: 'current',
            });
            // Auto-open right panel with diagram tab
            setRightPanelVisible(true);
            setPreviewTab('diagram');
            console.log(`[useLoadApp] Loaded diagram for workspace ${appId}: ${latestDiagram.title}`);

            // Check if diagram is stale (external changes detected)
            if (appData?.path) {
              try {
                const stalenessResult = await IpcClient.getInstance().checkDiagramStaleness({
                  diagramId: latestDiagram.id,
                  workspacePath: appData.path,
                });

                if (stalenessResult.success && stalenessResult.staleness) {
                  const staleness = stalenessResult.staleness;
                  if (staleness.isStale) {
                    console.log(`[useLoadApp] Diagram is stale: ${staleness.reason}`);
                    setDiagramStaleness({
                      diagramId: latestDiagram.id,
                      isStale: staleness.isStale,
                      severity: staleness.severity,
                      reason: staleness.reason,
                      recommendation: staleness.recommendation,
                    });
                  } else {
                    setDiagramStaleness(null);
                  }
                }
              } catch (stalenessErr) {
                console.warn('[useLoadApp] Failed to check diagram staleness:', stalenessErr);
              }
            }
          } else {
            console.log(`[useLoadApp] No saved diagram for workspace ${appId}. Auto-generating...`);
            setDiagramStaleness(null);

            // Auto-generate initial diagram for new workspaces
            if (appData?.path) {
              try {
                const generateResult = await IpcClient.getInstance().generateDiagram({
                  workspaceId: appId,
                  appPath: appData.path,
                  type: 'mermaid',
                });

                if (generateResult.success && generateResult.diagram) {
                  setDiagramState({
                    id: generateResult.diagram.id,
                    code: generateResult.diagram.content || '',
                    type: generateResult.diagram.type || 'mermaid',
                    title: generateResult.diagram.title || 'Architecture Diagram',
                    compareMode: 'current',
                  });
                  setRightPanelVisible(true);
                  setPreviewTab('diagram');
                  console.log(`[useLoadApp] Auto-generated diagram for workspace ${appId}`);
                } else {
                  console.warn('[useLoadApp] Diagram generation returned no result');
                }
              } catch (genErr) {
                console.error('[useLoadApp] Failed to auto-generate diagram:', genErr);
              }
            }
          }
        } catch (err) {
          console.error('[useLoadApp] Failed to load diagram:', err);
        }
      };

      loadDiagram();
    }
  }, [appId, appData, setApp, setDiagramState, setDiagramStaleness, setRightPanelVisible, setPreviewTab]);

  return { app: appData, loading, error, refreshApp };
}

// Function to invalidate the app query
export const invalidateAppQuery = (
  queryClient: QueryClient,
  { appId }: { appId: number | null },
) => {
  return queryClient.invalidateQueries({ queryKey: ["app", appId] });
};
