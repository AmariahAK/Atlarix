/**
 * useDevServer Hook
 * =================
 * Auto-manages dev server for live preview (Lovable-style)
 * 
 * Usage:
 *   const { url, isRunning, isFrontend, start, stop } = useDevServer(workspaceId);
 * 
 * Features:
 * - Auto-detects frontend projects
 * - Auto-starts when workspace is selected
 * - Provides live preview URL
 * - Stops server on workspace switch
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { IpcClient } from '@/ipc/ipc_client';
import { useAtomValue } from 'jotai';
import { selectedAppIdAtom } from '@/atoms/appAtoms';

interface DevServerState {
    url: string | null;
    isRunning: boolean;
    isStarting: boolean;
    isFrontend: boolean;
    framework: string | null;
    error: string | null;
}

interface UseDevServerReturn extends DevServerState {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    refresh: () => Promise<void>;
}

export function useDevServer(workspaceId: number | null): UseDevServerReturn {
    const [state, setState] = useState<DevServerState>({
        url: null,
        isRunning: false,
        isStarting: false,
        isFrontend: false,
        framework: null,
        error: null,
    });

    const previousWorkspaceId = useRef<number | null>(null);

    // Check if frontend and get status on mount/workspace change
    useEffect(() => {
        if (!workspaceId) {
            setState({
                url: null,
                isRunning: false,
                isStarting: false,
                isFrontend: false,
                framework: null,
                error: null,
            });
            return;
        }

        const checkAndStart = async () => {
            try {
                // Stop previous server if workspace changed
                if (previousWorkspaceId.current && previousWorkspaceId.current !== workspaceId) {
                    console.log(`🛑 Stopping dev server for previous workspace ${previousWorkspaceId.current}`);
                    await IpcClient.getInstance().stopDevServer(previousWorkspaceId.current);
                }
                previousWorkspaceId.current = workspaceId;

                // Check if frontend
                const frontendCheck = await IpcClient.getInstance().isFrontendProject(workspaceId);

                if (!frontendCheck.isFrontend) {
                    setState({
                        url: null,
                        isRunning: false,
                        isStarting: false,
                        isFrontend: false,
                        framework: null,
                        error: null,
                    });
                    return;
                }

                // Check current status
                const status = await IpcClient.getInstance().getDevServerStatus(workspaceId);

                if (status.isRunning && status.url) {
                    setState({
                        url: status.url,
                        isRunning: true,
                        isStarting: false,
                        isFrontend: true,
                        framework: frontendCheck.framework || null,
                        error: null,
                    });
                } else {
                    // Auto-start the dev server
                    console.log(`🚀 Auto-starting dev server for workspace ${workspaceId}`);
                    setState(s => ({ ...s, isFrontend: true, framework: frontendCheck.framework || null, isStarting: true }));

                    const result = await IpcClient.getInstance().startDevServer(workspaceId);

                    if (result.success) {
                        setState({
                            url: result.url || null,
                            isRunning: true,
                            isStarting: false,
                            isFrontend: true,
                            framework: frontendCheck.framework || null,
                            error: null,
                        });
                    } else {
                        setState(s => ({
                            ...s,
                            isStarting: false,
                            error: result.error || 'Failed to start dev server',
                        }));
                    }
                }
            } catch (error) {
                console.error('Dev server hook error:', error);
                setState(s => ({
                    ...s,
                    error: String(error),
                    isStarting: false,
                }));
            }
        };

        checkAndStart();
    }, [workspaceId]);

    // Manual start
    const start = useCallback(async () => {
        if (!workspaceId) return;

        setState(s => ({ ...s, isStarting: true, error: null }));

        try {
            const result = await IpcClient.getInstance().startDevServer(workspaceId);
            if (result.success) {
                setState(s => ({
                    ...s,
                    url: result.url || null,
                    isRunning: true,
                    isStarting: false,
                }));
            } else {
                setState(s => ({
                    ...s,
                    isStarting: false,
                    error: result.error || 'Failed to start',
                }));
            }
        } catch (error) {
            setState(s => ({
                ...s,
                isStarting: false,
                error: String(error),
            }));
        }
    }, [workspaceId]);

    // Manual stop
    const stop = useCallback(async () => {
        if (!workspaceId) return;

        try {
            await IpcClient.getInstance().stopDevServer(workspaceId);
            setState(s => ({
                ...s,
                url: null,
                isRunning: false,
            }));
        } catch (error) {
            console.error('Failed to stop dev server:', error);
        }
    }, [workspaceId]);

    // Refresh status
    const refresh = useCallback(async () => {
        if (!workspaceId) return;

        try {
            const status = await IpcClient.getInstance().getDevServerStatus(workspaceId);
            setState(s => ({
                ...s,
                url: status.url,
                isRunning: status.isRunning,
            }));
        } catch (error) {
            console.error('Failed to refresh dev server status:', error);
        }
    }, [workspaceId]);

    return {
        ...state,
        start,
        stop,
        refresh,
    };
}

/**
 * Convenience hook that uses the selected app ID
 */
export function useSelectedDevServer(): UseDevServerReturn {
    const workspaceId = useAtomValue(selectedAppIdAtom);
    return useDevServer(workspaceId);
}
