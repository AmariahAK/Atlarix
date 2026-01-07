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

import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useMemo, useCallback } from 'react';
import {
    type PanelContext,
    type PanelType,
    type PanelTab,
    type AIPanelIntent,
    type AIPanelIntentState,
    sourceListAtom,
    pendingProposalsAtom,
    toolTimelineAtom,
    terminalOutputsAtom,
    diagramStateAtom,
    pinnedPanelAtom,
    previewTabAtom,
    devServerUrlAtom,
    aiPanelIntentAtom,
    mapIntentToView,
    browserErrorsAtom,
} from '@/atoms/sourceAtoms';
import { permissionQueueAtom, getOperationsByStatus } from '@/atoms/permissionQueueAtom';
import { currentAppAtom } from '@/atoms/appAtoms';

// Tab configurations for each panel type
const PANEL_TABS: Record<PanelType, PanelTab[]> = {
    'web-search': ['sources', 'debug'],
    'code-preview': ['preview', 'code', 'terminal', 'errors', 'permissions', 'search', 'diagram'],
    'diagram': ['diagram', 'logs'],
    'terminal': ['terminal'],
    'file-diff': [],  // Unified PermissionQueuePanel handles all - no more separate tabs
    'files': ['files'],
    'tools': [],  // Deprecated - ThinkingCard handles tools
    'timeline': ['timeline'],
    'permission': ['permission'],  // Legacy - now handled by file-diff
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
    const proposals = useAtomValue(pendingProposalsAtom);
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
    const diagramState = useAtomValue(diagramStateAtom);
    const devServerUrl = useAtomValue(devServerUrlAtom);
    const browserErrors = useAtomValue(browserErrorsAtom);
    const [pinnedPanel, setPinnedPanel] = useAtom(pinnedPanelAtom);
    const [activeTab, setActiveTab] = useAtom(previewTabAtom);
    const [aiPanelIntent, setAIPanelIntentState] = useAtom(aiPanelIntentAtom);
    const permissionQueue = useAtomValue(permissionQueueAtom);
    const currentApp = useAtomValue(currentAppAtom);

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
        // Priority 1: Active permissions in the queue (pending, queued, or running)
        if (hasPendingPermissions) {
            return 'file-diff';  // PermissionQueuePanel handles all permission operations
        }

        // Priority 1b: Legacy file diff / proposals (for backwards compat)
        const pendingApproval = proposals.filter(p => !p.approved);
        if (pendingApproval.length > 0) {
            return 'file-diff';  // FileDiffPanel handles both files AND permissions
        }

        // Priority 2: Web search results
        if (sources.length > 0 && lastToolCall?.name === 'web_search') {
            return 'web-search';
        }

        // Priority 3: Diagram generation
        if (diagramState && lastToolCall?.name === 'generate_diagram') {
            return 'diagram';
        }

        // Priority 4: Terminal output
        if (terminalOutput && lastToolCall?.name === 'run_command') {
            return 'terminal';
        }

        // Priority 5: Live preview (dev server running)
        if (devServerUrl) {
            return 'code-preview';
        }

        // Priority 6: Check for any recent sources
        if (sources.length > 0) {
            return 'web-search';
        }

        // Priority 7: Check for any diagram
        if (diagramState) {
            return 'diagram';
        }

        return 'empty';
    }, [sources, proposals, lastToolCall, diagramState, terminalOutput, devServerUrl, hasPendingPermissions]);

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
        const tabs = PANEL_TABS[effectiveType] || [];
        const validTab = tabs.includes(activeTab) ? activeTab : tabs[0];

        return {
            type: effectiveType,
            tabs,
            activeTab: validTab,
            data: getDataForType(effectiveType, {
                sources,
                proposals,
                diagramState,
                terminalOutput,
                toolTimeline,
                devServerUrl,
                browserErrors,
                workspacePath: currentApp?.path || '',
                aiContext: aiPanelIntent?.context,
            }),
        };
    }, [effectiveType, activeTab, sources, proposals, diagramState, terminalOutput, toolTimeline, devServerUrl, browserErrors, aiPanelIntent, currentApp]);

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
        proposals: any[];
        diagramState: any;
        terminalOutput: any;
        toolTimeline: any[];
        devServerUrl: string | null;
        browserErrors: any[];
        workspacePath: string;
        aiContext?: AIPanelIntentState['context'];
    }
) {
    switch (type) {
        case 'web-search':
            return { sources: state.sources, timeline: state.toolTimeline, ...state.aiContext };
        case 'file-diff':
            // FileDiffPanel handles both file changes AND permission approvals
            return { proposals: state.proposals, ...state.aiContext };
        case 'diagram':
            return { ...state.diagramState, ...state.aiContext };
        case 'terminal':
            return { ...state.terminalOutput, ...state.aiContext };
        case 'tools':
            return { timeline: state.toolTimeline, ...state.aiContext };
        case 'code-preview':
            // Include terminal output for the Terminal tab inside CodePreviewPanel
            // TerminalOutput has .output (string), but CodePreviewPanel expects .output (string[])
            // Strip ANSI codes for cleaner display
            const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*m/g, '');
            const rawOutput = state.terminalOutput?.output || '';
            const cleanOutput = stripAnsi(rawOutput);
            // Split by newlines and filter empty lines at the start
            const lines = cleanOutput.split('\n').filter((line, i, arr) => {
                // Keep all lines except leading empty ones
                if (i === 0 && line.trim() === '') return false;
                return true;
            });

            return {
                url: state.devServerUrl,
                terminal: state.terminalOutput ? {
                    output: lines,
                    running: state.terminalOutput.status === 'running'
                } : null,
                errors: state.browserErrors,
                sources: state.sources,  // Web search sources for the search tab
                workspacePath: state.workspacePath,  // For live code editor
                ...state.aiContext
            };
        case 'permission':
            // New PermissionQueuePanel - pass chatId from AI context
            return { chatId: state.aiContext?.chatId, ...state.aiContext };
        default:
            return state.aiContext || null;
    }
}

export default useRightPanelContext;
