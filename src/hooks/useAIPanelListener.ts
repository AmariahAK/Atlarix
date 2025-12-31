/**
 * useAIPanelListener Hook
 * =======================
 * Listens for IPC events from main process that control the right panel.
 * This enables the AI (via permission system, tools, etc.) to explicitly
 * set what the right panel should display.
 */

import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { aiControlledPanelAtom, type AIPanelState, type PanelType } from '@/atoms/sourceAtoms';
import { IpcClient } from '@/ipc/ipc_client';

// Valid panel types
const VALID_PANEL_TYPES: PanelType[] = [
    'web-search', 'code-preview', 'diagram', 'terminal',
    'file-diff', 'files', 'timeline', 'tools', 'permission', 'empty'
];

export function useAIPanelListener() {
    const setAIPanel = useSetAtom(aiControlledPanelAtom);

    useEffect(() => {
        // Listen for panel updates from main process via IpcClient
        const handlePanelUpdate = (data: {
            view: string;
            context?: any;
            timestamp: number;
            source?: 'ai' | 'user' | 'system';
        }) => {
            console.log('[useAIPanelListener] Received panel update:', data);

            // Validate view is a valid panel type
            if (!VALID_PANEL_TYPES.includes(data.view as PanelType)) {
                console.warn(`[useAIPanelListener] Invalid panel view: ${data.view}`);
                return;
            }

            const panelState: AIPanelState = {
                view: data.view as PanelType,
                context: data.context,
                timestamp: data.timestamp,
                source: data.source || 'system',
            };

            setAIPanel(panelState);
        };

        // Use IpcClient's underlying ipcRenderer
        const ipcClient = IpcClient.getInstance();
        const ipcRenderer = (ipcClient as any).ipcRenderer;

        if (ipcRenderer?.on) {
            ipcRenderer.on('right-panel:set-view', handlePanelUpdate);

            return () => {
                ipcRenderer.off?.('right-panel:set-view', handlePanelUpdate);
            };
        }

        return () => { };
    }, [setAIPanel]);
}

export default useAIPanelListener;
