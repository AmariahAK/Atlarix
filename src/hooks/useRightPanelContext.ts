/**
 * useRightPanelContext Hook
 * =========================
 * AI-first context detection for the right panel
 * 
 * Priority order:
 * 1. AI-controlled panel state (explicit tool calls)
 * 2. User-pinned panel
 * 3. Fallback heuristics (for when AI doesn't call set_right_panel)
 */

import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useMemo, useCallback } from 'react';
import {
    type PanelContext,
    type PanelType,
    type PanelTab,
    type AIPanelState,
    sourceListAtom,
    pendingProposalsAtom,
    toolTimelineAtom,
    terminalOutputAtom,
    diagramStateAtom,
    pinnedPanelAtom,
    previewTabAtom,
    devServerUrlAtom,
    aiControlledPanelAtom,
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
    'permission': ['permission'],  // Permission approval panel
    'empty': [],
};

export interface RightPanelContextResult {
    context: PanelContext;
    isPinned: boolean;
    isAIControlled: boolean;
    pin: () => void;
    unpin: () => void;
    setActiveTab: (tab: PanelTab) => void;
    setAIPanel: (state: Omit<AIPanelState, 'timestamp'>) => void;
    clearAIPanel: () => void;
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
    const [aiPanel, setAIPanelState] = useAtom(aiControlledPanelAtom);

    // Get the last tool call for context detection
    const lastToolCall = toolTimeline[toolTimeline.length - 1];

    // Fallback heuristics (used when AI doesn't explicitly set panel)
    const heuristicType = useMemo((): PanelType => {
        // Priority 1: Active file diff (unapproved proposals)
        const pendingApproval = proposals.filter(p => !p.approved);
        if (pendingApproval.length > 0) {
            return 'file-diff';
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

    // Determine effective panel type:
    // 1. AI-controlled state (highest priority)
    // 2. User-pinned panel
    // 3. Heuristic detection (fallback)
    const effectiveType = useMemo((): PanelType => {
        if (aiPanel) {
            return aiPanel.view;
        }
        if (pinnedPanel) {
            return pinnedPanel;
        }
        return heuristicType;
    }, [aiPanel, pinnedPanel, heuristicType]);

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
                aiContext: aiPanel?.context,
            }),
        };
    }, [effectiveType, activeTab, sources, proposals, diagramState, terminalOutput, toolTimeline, devServerUrl, aiPanel]);

    // Helper to set AI panel state
    const setAIPanel = useCallback((state: Omit<AIPanelState, 'timestamp'>) => {
        setAIPanelState({
            ...state,
            timestamp: Date.now(),
        });
    }, [setAIPanelState]);

    // Clear AI panel state (return to heuristics)
    const clearAIPanel = useCallback(() => {
        setAIPanelState(null);
    }, [setAIPanelState]);

    return {
        context,
        isPinned: pinnedPanel !== null,
        isAIControlled: aiPanel !== null,
        pin: () => setPinnedPanel(effectiveType),
        unpin: () => {
            setPinnedPanel(null);
            setAIPanelState(null);  // Also clear AI state when unpinning
        },
        setActiveTab,
        setAIPanel,
        clearAIPanel,
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
        aiContext?: AIPanelState['context'];
    }
) {
    switch (type) {
        case 'web-search':
            return { sources: state.sources, timeline: state.toolTimeline, ...state.aiContext };
        case 'file-diff':
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
            return { ...state.aiContext };  // Permission context from AI
        default:
            return state.aiContext || null;
    }
}

export default useRightPanelContext;
