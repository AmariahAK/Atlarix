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
    terminalOutputAtom,
    diagramStateAtom,
    pinnedPanelAtom,
    previewTabAtom,
    devServerUrlAtom,
    aiPanelIntentAtom,
    mapIntentToView,
} from '@/atoms/sourceAtoms';

// Tab configurations for each panel type
const PANEL_TABS: Record<PanelType, PanelTab[]> = {
    'web-search': ['sources', 'debug'],
    'code-preview': ['preview', 'code', 'terminal'],
    'diagram': ['diagram', 'logs'],
    'terminal': ['terminal'],
    'file-diff': ['files', 'diff', 'approve'],
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
    const terminalOutput = useAtomValue(terminalOutputAtom);
    const diagramState = useAtomValue(diagramStateAtom);
    const devServerUrl = useAtomValue(devServerUrlAtom);
    const [pinnedPanel, setPinnedPanel] = useAtom(pinnedPanelAtom);
    const [activeTab, setActiveTab] = useAtom(previewTabAtom);
    const [aiPanelIntent, setAIPanelIntentState] = useAtom(aiPanelIntentAtom);

    // Get the last tool call for context detection
    const lastToolCall = toolTimeline[toolTimeline.length - 1];

    // ═══════════════════════════════════════════════════════════
    // LAYER 2: Heuristic Fallback (v0.9.4 Logic)
    // Used when AI doesn't explicitly set intent
    // ═══════════════════════════════════════════════════════════
    const heuristicType = useMemo((): PanelType => {
        // Priority 1: Active file diff / permissions (unapproved proposals)
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
    }, [sources, proposals, lastToolCall, diagramState, terminalOutput, devServerUrl]);

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
                aiContext: aiPanelIntent?.context,
            }),
        };
    }, [effectiveType, activeTab, sources, proposals, diagramState, terminalOutput, toolTimeline, devServerUrl, aiPanelIntent]);

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
            return { url: state.devServerUrl, ...state.aiContext };
        case 'permission':
            // Legacy - permission panel now maps to file-diff
            return { proposals: state.proposals, ...state.aiContext };
        default:
            return state.aiContext || null;
    }
}

export default useRightPanelContext;
