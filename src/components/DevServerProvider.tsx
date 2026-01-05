/**
 * DevServerProvider
 * =================
 * Component that auto-starts dev servers for frontend workspaces (Lovable-style)
 * 
 * Mount this at the app level to enable automatic live preview.
 * It watches for workspace changes and:
 * 1. Stops the previous dev server
 * 2. Detects if new workspace is frontend
 * 3. Auto-starts the dev server
 * 4. Updates devServerUrlAtom for live preview
 */

import { useEffect, useRef } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { selectedAppIdAtom } from '@/atoms/appAtoms';
import { devServerUrlAtom, rightPanelVisibleAtom, projectTypeAtom, pinnedPanelAtom, terminalOutputsAtom, type TerminalOutput } from '@/atoms/sourceAtoms';
import { IpcClient } from '@/ipc/ipc_client';
import { useBrowserErrorListener } from '@/hooks/useBrowserErrorListener';

export function DevServerProvider({ children }: { children: React.ReactNode }) {
    const workspaceId = useAtomValue(selectedAppIdAtom);
    const setDevServerUrl = useSetAtom(devServerUrlAtom);
    const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
    const setProjectType = useSetAtom(projectTypeAtom);
    const setPinnedPanel = useSetAtom(pinnedPanelAtom);
    const setTerminalOutputs = useSetAtom(terminalOutputsAtom);
    const previousWorkspaceId = useRef<number | null>(null);

    // Listen for browser errors from iframe
    useBrowserErrorListener();

    // Subscribe to dev server output events
    useEffect(() => {
        const ipc = IpcClient.getInstance();
        const unsubscribe = ipc.onDevServerOutput((payload) => {
            // Convert dev server output to TerminalOutput format
            const terminalOutput: TerminalOutput = {
                operationId: `dev-server-${payload.workspaceId}`,
                command: `npm run dev (${payload.framework})`,
                output: payload.fullOutput,
                status: payload.status === 'running' ? 'running' : 'completed',
                startTime: payload.timestamp,
            };

            setTerminalOutputs((prev) => {
                const next = new Map(prev);
                next.set(terminalOutput.operationId, terminalOutput);
                return next;
            });
        });

        return unsubscribe;
    }, [setTerminalOutputs]);

    useEffect(() => {
        if (!workspaceId) {
            setDevServerUrl(null);
            return;
        }

        let isMounted = true;

        const handleWorkspaceChange = async () => {
            try {
                // Stop previous server if different workspace
                if (previousWorkspaceId.current && previousWorkspaceId.current !== workspaceId) {
                    console.log(`🛑 [DevServerProvider] Stopping server for workspace ${previousWorkspaceId.current}`);
                    await IpcClient.getInstance().stopDevServer(previousWorkspaceId.current).catch(() => { });
                    setDevServerUrl(null);
                }
                previousWorkspaceId.current = workspaceId;

                // Check if this is a frontend project
                console.log(`🔍 [DevServerProvider] Checking workspace ${workspaceId}...`);
                const frontendCheck = await IpcClient.getInstance().isFrontendProject(workspaceId);

                if (!frontendCheck.isFrontend) {
                    console.log(`📦 [DevServerProvider] Workspace ${workspaceId} is backend project`);
                    setDevServerUrl(null);
                    setProjectType('backend');
                    // Auto-show diagram for backend projects
                    setPinnedPanel('diagram');
                    setRightPanelVisible(true);
                    return;
                }

                console.log(`🎨 [DevServerProvider] Detected ${frontendCheck.framework} project`);
                setProjectType('frontend');

                // Check if already running
                const status = await IpcClient.getInstance().getDevServerStatus(workspaceId);
                if (status.isRunning && status.url) {
                    console.log(`✅ [DevServerProvider] Server already running at ${status.url}`);
                    if (isMounted) {
                        setDevServerUrl(status.url);
                        setRightPanelVisible(true);
                    }
                    return;
                }

                // Auto-start dev server
                console.log(`🚀 [DevServerProvider] Starting dev server for workspace ${workspaceId}...`);
                const result = await IpcClient.getInstance().startDevServer(workspaceId);

                if (result.success && result.url && isMounted) {
                    console.log(`✅ [DevServerProvider] Dev server ready at ${result.url}`);
                    setDevServerUrl(result.url);
                    setRightPanelVisible(true);
                } else if (result.error) {
                    console.warn(`⚠️ [DevServerProvider] Failed to start: ${result.error}`);
                }
            } catch (error) {
                // IPC channels may not be registered yet (during hot reload)
                console.debug('[DevServerProvider] IPC not ready:', error);
            }
        };

        // Small delay to avoid rapid fire on workspace switching
        const timeout = setTimeout(handleWorkspaceChange, 500);

        return () => {
            isMounted = false;
            clearTimeout(timeout);
        };
    }, [workspaceId, setDevServerUrl, setRightPanelVisible]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            // Stop all servers when component unmounts (app closing)
            // Wrapped in try-catch in case IPC channels aren't registered yet
            try {
                IpcClient.getInstance().listRunningDevServers().then(response => {
                    if (response.success && response.servers.length > 0) {
                        console.log(`🛑 [DevServerProvider] Cleanup: stopping ${response.servers.length} servers`);
                        response.servers.forEach(s => {
                            IpcClient.getInstance().stopDevServer(s.workspaceId).catch(() => { });
                        });
                    }
                }).catch(() => {
                    // Ignore errors - IPC channels may not be registered
                });
            } catch {
                // Ignore errors during cleanup
            }
        };
    }, []);

    return <>{children}</>;
}

export default DevServerProvider;
