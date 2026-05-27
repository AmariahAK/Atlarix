/**
 * useDevServer Hook
 * =================
 * Manual dev server control for live preview.
 *
 * Usage:
 *   const { url, isRunning, isFrontend, start, stop } = useDevServer(workspaceId);
 *
 * Does not auto-start on workspace select — call `start()` from preview UI or tools.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { IpcClient } from '@/ipc/ipc_client';
import { useAtomValue, useSetAtom } from 'jotai';
import { selectedAppIdAtom } from '@/atoms/appAtoms';
import { devServerUrlAtom, rightPanelVisibleAtom, previewTabAtom } from '@/atoms/sourceAtoms';

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

    const setDevServerUrl = useSetAtom(devServerUrlAtom);
    const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
    const setPreviewTab = useSetAtom(previewTabAtom);

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
            setDevServerUrl(null);
            previousWorkspaceId.current = null;
            return;
        }

        let cancelled = false;

        const syncStatusOnly = async () => {
            try {
                if (
                    previousWorkspaceId.current &&
                    previousWorkspaceId.current !== workspaceId
                ) {
                    await IpcClient.getInstance()
                        .stopDevServer(previousWorkspaceId.current)
                        .catch(() => {});
                    if (!cancelled) {
                        setDevServerUrl(null);
                    }
                }
                previousWorkspaceId.current = workspaceId;

                const frontendCheck =
                    await IpcClient.getInstance().isFrontendProject(workspaceId);
                if (cancelled) return;

                if (!frontendCheck.isFrontend) {
                    setState({
                        url: null,
                        isRunning: false,
                        isStarting: false,
                        isFrontend: false,
                        framework: null,
                        error: null,
                    });
                    setDevServerUrl(null);
                    return;
                }

                const status =
                    await IpcClient.getInstance().getDevServerStatus(workspaceId);
                if (cancelled) return;

                if (status.isRunning && status.url) {
                    setState({
                        url: status.url,
                        isRunning: true,
                        isStarting: false,
                        isFrontend: true,
                        framework: frontendCheck.framework || null,
                        error: null,
                    });
                    setDevServerUrl(status.url);
                } else {
                    setState({
                        url: null,
                        isRunning: false,
                        isStarting: false,
                        isFrontend: true,
                        framework: frontendCheck.framework || null,
                        error: null,
                    });
                    setDevServerUrl(null);
                }
            } catch {
                if (!cancelled) {
                    setDevServerUrl(null);
                }
            }
        };

        void syncStatusOnly();

        return () => {
            cancelled = true;
        };
    }, [workspaceId, setDevServerUrl]);

    const start = useCallback(async () => {
        if (!workspaceId) return;

        setState((s) => ({ ...s, isStarting: true, error: null }));

        try {
            const frontendCheck =
                await IpcClient.getInstance().isFrontendProject(workspaceId);
            if (!frontendCheck.isFrontend) {
                setState((s) => ({
                    ...s,
                    isStarting: false,
                    isFrontend: false,
                    error: 'Not a frontend project',
                }));
                return;
            }

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
                if (result.url) {
                    setDevServerUrl(result.url);
                    setRightPanelVisible(true);
                    setPreviewTab('preview');
                }
            } else {
                setState((s) => ({
                    ...s,
                    isStarting: false,
                    isFrontend: true,
                    framework: frontendCheck.framework || null,
                    error: result.error || 'Failed to start',
                }));
                setDevServerUrl(null);
            }
        } catch (error) {
            setState((s) => ({
                ...s,
                isStarting: false,
                error: String(error),
            }));
            setDevServerUrl(null);
        }
    }, [workspaceId, setDevServerUrl, setRightPanelVisible, setPreviewTab]);

    const stop = useCallback(async () => {
        if (!workspaceId) return;

        try {
            await IpcClient.getInstance().stopDevServer(workspaceId);
            setState((s) => ({
                ...s,
                url: null,
                isRunning: false,
            }));
            setDevServerUrl(null);
        } catch (error) {
            console.error('Failed to stop dev server:', error);
        }
    }, [workspaceId, setDevServerUrl]);

    const refresh = useCallback(async () => {
        if (!workspaceId) return;

        try {
            const status =
                await IpcClient.getInstance().getDevServerStatus(workspaceId);
            setState((s) => ({
                ...s,
                url: status.url,
                isRunning: status.isRunning,
            }));
            if (status.isRunning && status.url) {
                setDevServerUrl(status.url);
            }
        } catch (error) {
            console.error('Failed to refresh dev server status:', error);
        }
    }, [workspaceId, setDevServerUrl]);

    return {
        ...state,
        start,
        stop,
        refresh,
    };
}

export function useSelectedDevServer(): UseDevServerReturn {
    const workspaceId = useAtomValue(selectedAppIdAtom);
    return useDevServer(workspaceId);
}
