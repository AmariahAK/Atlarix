/**
 * useRightPanelContext Hook
 * =========================
 * Hybrid AI Intent + Heuristic Mapping System
 * 
 * Priority order:
 * 1. AI intent (semantic) → mapped to correct UI component
 * 2. User-pinned panel
 * 3. Fallback heuristics (v0.9.4 logic - when AI doesn't set intent)
 * 
 * This two-layer system ensures:
 * - AI stays in control (accuracy)
 * - Correct UI always renders (reliability)
 * - Backwards compatible (heuristics catch forgotten intents)
 */

import { useAtom, useAtomValue } from 'jotai';
import { useMemo, useCallback, useState, useEffect } from 'react';
import {
    type PanelContext,
    type PanelType,
    type PanelTab,
    type AIPanelIntent,
    type AIPanelIntentState,
    sourceListAtom,
    toolTimelineAtom,
    terminalOutputsAtom,
    pinnedPanelAtom,
    previewTabAtom,
    devServerUrlAtom,
    aiPanelIntentAtom,
    mapIntentToView,
    browserErrorsAtom,
    leftPanelWidthAtom,
    rightPanelWidthAtom,
    rightPanelVisibleAtom,
    leftPanelVisibleAtom,
} from '@/atoms/sourceAtoms';
import { permissionQueueAtom, getOperationsByStatus } from '@/atoms/permissionQueueAtom';
import { currentAppAtom, selectedAppIdAtom, selectedWorkspaceInfoAtom } from '@/atoms/appAtoms';

// Tab configurations for each panel type
const PANEL_TABS: Record<PanelType, PanelTab[]> = {
    'web-search': [],
    'code-preview': ['preview', 'code', 'browser', 'terminal', 'activity', 'agents', 'errors'],
    'terminal': ['terminal', 'activity'],
    'files': ['files'],
    'tools': [],  // Deprecated - ThinkingCard handles tools
    'plan': ['plan'],
    'empty': [],
};

export interface RightPanelContextResult {
    context: PanelContext;
    isPinned: boolean;
    isAIControlled: boolean;
    aiIntent: AIPanelIntent | null;
    pin: () => void;
    unpin: () => void;
    setActiveTab: (tab: PanelTab) => void;
    setAIIntent: (intent: AIPanelIntent, context?: AIPanelIntentState['context']) => void;
    clearAIIntent: () => void;
}

export function useRightPanelContext(): RightPanelContextResult {
    // Read all potential context sources
    const sources = useAtomValue(sourceListAtom);
    const toolTimeline = useAtomValue(toolTimelineAtom);
    const terminalOutputs = useAtomValue(terminalOutputsAtom);

    // Get the latest/running terminal output from the Map
    const terminalOutput = useMemo(() => {
        if (terminalOutputs.size === 0) return null;
        // Prefer running commands, otherwise get the most recent
        const outputs = Array.from(terminalOutputs.values());
        const running = outputs.find(o => o.status === 'running');
        if (running) return running;
        // Sort by startTime descending and take the most recent
        return outputs.sort((a, b) => b.startTime - a.startTime)[0] || null;
    }, [terminalOutputs]);
    const devServerUrl = useAtomValue(devServerUrlAtom);
    const browserErrors = useAtomValue(browserErrorsAtom);
    const [pinnedPanel, setPinnedPanel] = useAtom(pinnedPanelAtom);
    const [activeTab, setActiveTab] = useAtom(previewTabAtom);

    const [aiPanelIntent, setAIPanelIntentState] = useAtom(aiPanelIntentAtom);
    const permissionQueue = useAtomValue(permissionQueueAtom);
    const currentApp = useAtomValue(currentAppAtom);
    const leftPanelWidth = useAtomValue(leftPanelWidthAtom);
    const rightPanelWidth = useAtomValue(rightPanelWidthAtom);
    const rightPanelVisible = useAtomValue(rightPanelVisibleAtom);
    const leftPanelVisible = useAtomValue(leftPanelVisibleAtom);
    const [windowWidth, setWindowWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1024);

    useEffect(() => {
        const onResize = () => setWindowWidth(window.innerWidth);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const chatAreaHidden = Boolean(
        rightPanelVisible &&
        (leftPanelVisible ? leftPanelWidth : 0) + rightPanelWidth >= windowWidth - 80
    );
    const selectedAppId = useAtomValue(selectedAppIdAtom);
    const selectedWorkspaceInfo = useAtomValue(selectedWorkspaceInfoAtom);

    // Get the last tool call for context detection
    const lastToolCall = toolTimeline[toolTimeline.length - 1];

    // Check if there are any pending permissions in the queue
    const hasPendingPermissions = useMemo(() => {
        const pending = getOperationsByStatus(permissionQueue, 'pending');
        const queued = getOperationsByStatus(permissionQueue, 'queued');
        const running = getOperationsByStatus(permissionQueue, 'running');
        return pending.length > 0 || queued.length > 0 || running.length > 0;
    }, [permissionQueue]);

    // ═══════════════════════════════════════════════════════════
    // LAYER 2: Heuristic Fallback (v0.9.4 Logic)
    // Used when AI doesn't explicitly set intent
    // ═══════════════════════════════════════════════════════════
    const heuristicType = useMemo((): PanelType => {
        // Note: file/command approvals render inline in chat — no dedicated panel type.

        // Priority 2: Web search results
        if (sources.length > 0 && lastToolCall?.name === 'web_search') {
            return 'web-search';
        }

        // Priority 3: Terminal output (explicit terminal intent)
        if (terminalOutput && lastToolCall?.name === 'run_command') {
            return 'terminal';
        }

        // Priority 4: Workspace chat – always full tabs (preview, code, terminal, errors, diagram, etc.)
        if (currentApp ?? selectedAppId) {
            return 'code-preview';
        }

        // Priority 5: Live preview (dev server running, non-workspace) – full tabs
        if (devServerUrl) {
            return 'code-preview';
        }

        // Priority 6: Check for any recent sources (non-workspace)
        if (sources.length > 0) {
            return 'web-search';
        }

        return 'empty';
    }, [sources, lastToolCall, terminalOutput, devServerUrl, hasPendingPermissions, currentApp, selectedAppId]);

    // ═══════════════════════════════════════════════════════════
    // LAYER 1: AI Intent Mapping
    // AI specifies semantic intent, we map to correct UI component
    // ═══════════════════════════════════════════════════════════
    const effectiveType = useMemo((): PanelType => {
        // Priority 1: AI intent (mapped to correct view)
        if (aiPanelIntent) {
            const mappedView = mapIntentToView(aiPanelIntent.intent);
            if (mappedView) {
                console.log(`[RightPanel] AI intent '${aiPanelIntent.intent}' → UI '${mappedView}'`);
                return mappedView;
            }
            // Unknown intent - fall through to heuristics
        }

        // Priority 2: User-pinned panel
        if (pinnedPanel) {
            return pinnedPanel;
        }

        // Priority 3: Heuristic detection (fallback)
        return heuristicType;
    }, [aiPanelIntent, pinnedPanel, heuristicType]);

    // Build context object
    const context = useMemo((): PanelContext => {
        let tabs = PANEL_TABS[effectiveType] || [];
        if (chatAreaHidden && !tabs.includes('chat')) {
            tabs = ['chat', ...tabs];
        }
        const validTab = tabs.includes(activeTab) ? activeTab : tabs[0];

        return {
            type: effectiveType,
            tabs,
            activeTab: validTab,
            data: getDataForType(effectiveType, {
                sources,
                terminalOutput,
                terminalOutputs,
                toolTimeline,
                devServerUrl,
                browserErrors,
                // Use selected workspace when currentApp not yet loaded (e.g. sidebar file click)
                workspacePath: currentApp?.path || selectedWorkspaceInfo?.path || '',
                appId: currentApp?.id ?? selectedAppId ?? null,
                aiContext: aiPanelIntent?.context,
            }),
        };
    }, [effectiveType, activeTab, sources, terminalOutput, terminalOutputs, toolTimeline, devServerUrl, browserErrors, aiPanelIntent, currentApp, selectedAppId, selectedWorkspaceInfo, chatAreaHidden]);

    // Helper to set AI intent
    const setAIIntent = useCallback((intent: AIPanelIntent, context?: AIPanelIntentState['context']) => {
        console.log(`[RightPanel] Setting AI intent: ${intent}`);
        setAIPanelIntentState({
            intent,
            context,
            timestamp: Date.now(),
            source: 'ai',
        });
    }, [setAIPanelIntentState]);

    // Clear AI intent (return to heuristics)
    const clearAIIntent = useCallback(() => {
        console.log('[RightPanel] Clearing AI intent, returning to heuristics');
        setAIPanelIntentState(null);
    }, [setAIPanelIntentState]);

    return {
        context,
        isPinned: pinnedPanel !== null,
        isAIControlled: aiPanelIntent !== null,
        aiIntent: aiPanelIntent?.intent ?? null,
        pin: () => setPinnedPanel(effectiveType),
        unpin: () => {
            setPinnedPanel(null);
            setAIPanelIntentState(null);  // Also clear AI intent when unpinning
        },
        setActiveTab,
        setAIIntent,
        clearAIIntent,
    };
}

// Helper to get relevant data for each panel type
function getDataForType(
    type: PanelType,
    state: {
        sources: any[];
        terminalOutput: any;
        terminalOutputs: Map<string, any>;
        toolTimeline: any[];
        devServerUrl: string | null;
        browserErrors: any[];
        workspacePath: string;
        appId: number | null;
        aiContext?: AIPanelIntentState['context'];
    }
) {
    // Helper to prepare terminal output
    const prepareTerminalOutput = () => {
        const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*m/g, '');
        const rawOutput = state.terminalOutput?.output || '';
        const cleanOutput = stripAnsi(rawOutput);
        const lines = cleanOutput.split('\n').filter((line: string, i: number) => {
            if (i === 0 && line.trim() === '') return false;
            return true;
        });
        return state.terminalOutput ? {
            output: lines,
            running: state.terminalOutput.status === 'running'
        } : null;
    };

    switch (type) {
        case 'web-search':
            return { sources: state.sources, timeline: state.toolTimeline, ...state.aiContext };
        case 'terminal':
            return { ...state.terminalOutput, ...state.aiContext };
        case 'tools':
            return { timeline: state.toolTimeline, ...state.aiContext };
        case 'code-preview':
            return {
                url: state.devServerUrl,
                terminal: prepareTerminalOutput(),
                terminalOutputs: state.terminalOutputs,
                errors: state.browserErrors,
                sources: state.sources,
                workspacePath: state.workspacePath,
                appId: state.appId,
                ...state.aiContext
            };
        default:
            return state.aiContext || null;
    }
}
