/**
 * DevServerProvider
 * =================
 * Watches workspace changes and syncs dev server URL / terminal output / error parsing.
 * Pass6: does not auto-start the dev server or force the right panel open; user or tools start preview when needed.
 */

import { useEffect, useRef } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { selectedAppIdAtom } from '@/atoms/appAtoms';
import { devServerUrlAtom, projectTypeAtom, terminalOutputsAtom, type TerminalOutput, browserErrorsAtom } from '@/atoms/sourceAtoms';
import { IpcClient } from '@/ipc/ipc_client';
import { useBrowserErrorListener } from '@/hooks/useBrowserErrorListener';
import { deduplicateErrors, type ParsedError } from '@/lib/devServerErrorParser';
import { TerminalIntelligence } from '@/lib/terminal-intelligence';

export function DevServerProvider({ children }: { children: React.ReactNode }) {
    const workspaceId = useAtomValue(selectedAppIdAtom);
    const setDevServerUrl = useSetAtom(devServerUrlAtom);
    const setProjectType = useSetAtom(projectTypeAtom);
    const setTerminalOutputs = useSetAtom(terminalOutputsAtom);
    const setBrowserErrors = useSetAtom(browserErrorsAtom);
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

            // Parse output for errors using TerminalIntelligence (3-layer system)
            const parsedErrors = TerminalIntelligence.parse(payload.output);

            // Always update: replace build/terminal errors with current parse (prevents stacking)
            // When build succeeds, parsedErrors is empty → clears build errors
            setBrowserErrors((prev) => {
                const runtimeErrors = (prev as ParsedError[]).filter((e) => e.framework === 'browser');
                const uniqueBuildErrors = parsedErrors.length > 0
                    ? deduplicateErrors([] as any, parsedErrors)
                    : [];
                return [...runtimeErrors, ...uniqueBuildErrors] as any;
            });
            if (parsedErrors.length > 0) {
                console.log(`[DevServerProvider] Detected ${parsedErrors.length} errors in output`);
            }
        });

        return unsubscribe;
    }, [setTerminalOutputs, setBrowserErrors]);

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
                    setBrowserErrors([]); // Clear errors when switching workspace
                }
                previousWorkspaceId.current = workspaceId;

                // Check if this is a frontend project
                console.log(`🔍 [DevServerProvider] Checking workspace ${workspaceId}...`);
                const frontendCheck = await IpcClient.getInstance().isFrontendProject(workspaceId);

                if (!frontendCheck.isFrontend) {
                    console.log(`📦 [DevServerProvider] Workspace ${workspaceId} is backend project`);
                    setDevServerUrl(null);
                    setProjectType('backend');
                    return;
                }

                console.log(`🎨 [DevServerProvider] Detected ${frontendCheck.framework} project`);
                setProjectType('frontend');

                const status = await IpcClient.getInstance().getDevServerStatus(workspaceId);
                if (status.isRunning && status.url) {
                    console.log(`✅ [DevServerProvider] Server already running at ${status.url}`);
                    if (isMounted) {
                        setDevServerUrl(status.url);
                    }
                    return;
                }

                if (isMounted) {
                    setDevServerUrl(null);
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
    }, [workspaceId, setDevServerUrl, setProjectType]);

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
