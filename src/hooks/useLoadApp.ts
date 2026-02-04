import { useEffect, useRef } from "react";
import { useQuery, QueryClient } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import { useAtom, useSetAtom } from "jotai";
import { currentAppAtom } from "@/atoms/appAtoms";
import { diagramStateAtom, rightPanelVisibleAtom, previewTabAtom, diagramStalenessAtom, pinnedPanelAtom, type DiagramStalenessWarning } from "@/atoms/sourceAtoms";
import { App } from "@/ipc/ipc_types";

export function useLoadApp(appId: number | null) {
  const [, setApp] = useAtom(currentAppAtom);
  const setDiagramState = useSetAtom(diagramStateAtom);
  const setDiagramStaleness = useSetAtom(diagramStalenessAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const setPreviewTab = useSetAtom(previewTabAtom);
  const setPinnedPanel = useSetAtom(pinnedPanelAtom);
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
              workspaceId: appId,
            });
            // Auto-open toolbar right panel (code-preview) with Diagram tab selected
            setPinnedPanel('code-preview');
            setRightPanelVisible(true);
            setPreviewTab('diagram');
            console.log(`[useLoadApp] Loaded diagram for workspace ${appId}: ${latestDiagram.title}`);

            // Do NOT check staleness on load. Staleness is session-based only: we show the
            // "diagram is stale" banner when the main process sends diagram:staleness-detected
            // after file changes in this session (or mid-chat). This avoids showing "stale"
            // just because the project differs from the diagram's saved git/fingerprint on open.
            setDiagramStaleness(null);
          } else {
            console.log(`[useLoadApp] No saved diagram for workspace ${appId}. Auto-generating...`);
            setDiagramStaleness(null);

            // Auto-generate initial diagram for new workspaces
            if (appData?.path) {
              try {
                // Use AI-powered diagram generation (generates title and content automatically)
                const generateResult = await IpcClient.getInstance().generateAiDiagram({
                  workspaceId: appId,
                });

                if (generateResult.success && generateResult.diagram) {
                  const d = generateResult.diagram;
                  setDiagramState({
                    id: d.id,
                    code: d.content || '',
                    type: d.type || 'mermaid',
                    title: d.title || 'Architecture Diagram',
                    compareMode: 'current',
                    workspaceId: appId,
                  });
                  setPinnedPanel('code-preview');
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
  }, [appId, appData, setApp, setDiagramState, setDiagramStaleness, setRightPanelVisible, setPreviewTab, setPinnedPanel]);

  return { app: appData, loading, error, refreshApp };
}

// Function to invalidate the app query
export const invalidateAppQuery = (
  queryClient: QueryClient,
  { appId }: { appId: number | null },
) => {
  return queryClient.invalidateQueries({ queryKey: ["app", appId] });
};
