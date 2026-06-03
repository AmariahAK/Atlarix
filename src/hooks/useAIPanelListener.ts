/**
 * useAIPanelListener Hook
 * =======================
 * Listens for IPC events from main process that control the right panel.
 * This enables the AI (via permission system, tools, etc.) to explicitly
 * set what the right panel should display using semantic intents.
 * 
 * Part of the Hybrid Approach:
 * - AI sends semantic intent (e.g., 'show-permissions')
 * - Frontend maps to correct UI component (e.g., 'file-diff')
 */

import { useEffect, useRef } from 'react';
import { useSetAtom } from 'jotai';
import { aiPanelIntentAtom, type AIPanelIntent, type AIPanelIntentState } from '@/atoms/sourceAtoms';
import { IpcClient } from '@/ipc/ipc_client';

// Valid AI intents that can be received from backend
const VALID_INTENTS: AIPanelIntent[] = [
    'show-permissions',
    'show-file-changes',
    'show-web-search',
    'show-terminal',
    'show-files',
    'show-preview',  // Dev server preview
    'hide',
    'empty'
];

export function useAIPanelListener() {
    const setAIPanelIntent = useSetAtom(aiPanelIntentAtom);

    // FIX 4 (v0.9.15): Track processed timestamps to prevent duplicate handling from StrictMode
    const processedTimestamps = useRef(new Set<number>());

    useEffect(() => {
        // Listen for intent updates from main process via IpcClient
        const handleIntentUpdate = (data: {
            intent: string;
            context?: any;
            timestamp: number;
            source?: 'ai' | 'user' | 'system';
        }) => {
            console.log('[useAIPanelListener] Received intent update:', data);

            // FIX 4: Deduplicate - Skip if we've already processed this exact timestamp
            if (processedTimestamps.current.has(data.timestamp)) {
                console.debug('[useAIPanelListener] Skipping duplicate intent (same timestamp)');
                return;
            }
            processedTimestamps.current.add(data.timestamp);

            // Limit set size to prevent memory leak
            if (processedTimestamps.current.size > 50) {
                const first = processedTimestamps.current.values().next().value;
                if (first) processedTimestamps.current.delete(first);
            }

            // Validate intent is known
            if (!VALID_INTENTS.includes(data.intent as AIPanelIntent)) {
                console.warn(`[useAIPanelListener] Unknown intent: ${data.intent}, ignoring`);
                return;
            }

            const intentState: AIPanelIntentState = {
                intent: data.intent as AIPanelIntent,
                context: data.context,
                timestamp: data.timestamp,
                source: data.source || 'system',
            };

            console.log(`[useAIPanelListener] Setting AI intent: ${data.intent}`);
            setAIPanelIntent(intentState);
        };

        // Use IpcClient's underlying ipcRenderer
        const ipcClient = IpcClient.getInstance();
        const ipcRenderer = (ipcClient as any).ipcRenderer;

        if (ipcRenderer?.on) {
            // Listen for new intent-based events
            ipcRenderer.on('right-panel:set-intent', handleIntentUpdate);

            // Also listen for legacy view-based events (backwards compatibility)
            ipcRenderer.on('right-panel:set-view', (data: any) => {
                console.log('[useAIPanelListener] Legacy set-view event, converting to intent');
                // Map legacy view to intent
                const viewToIntent: Record<string, AIPanelIntent> = {
                    'permission': 'show-permissions',
                    'file-diff': 'show-file-changes',
                    'web-search': 'show-web-search',
                    'terminal': 'show-terminal',
                    'files': 'show-files',
                    'empty': 'empty',
                };
                const intent = viewToIntent[data.view] || 'empty';
                handleIntentUpdate({
                    intent,
                    context: data.context,
                    timestamp: data.timestamp,
                    source: data.source,
                });
            });

            return () => {
                ipcRenderer.off?.('right-panel:set-intent', handleIntentUpdate);
                ipcRenderer.off?.('right-panel:set-view', handleIntentUpdate);
            };
        }

        return () => { };
    }, [setAIPanelIntent]);
}

export default useAIPanelListener;
