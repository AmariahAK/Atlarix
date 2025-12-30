/**
 * useRightPanelContext Hook
 * =========================
 * Priority-based context detection for the right panel
 * 
 * Determines what content to show based on:
 * 1. Active file diff (highest priority) - write_files pending
 * 2. Web search results - web_search tool call
 * 3. Diagram generation - generate_diagram tool call
 * 4. Terminal output - run_command tool call
 * 5. Live preview - dev server running
 * 6. Default - file explorer
 */

import { useAtom, useAtomValue } from 'jotai';
import { useMemo } from 'react';
import {
    type PanelContext,
    type PanelType,
    type PanelTab,
    sourceListAtom,
    pendingProposalsAtom,
    toolTimelineAtom,
    terminalOutputAtom,
    diagramStateAtom,
    pinnedPanelAtom,
    previewTabAtom,
    devServerUrlAtom,
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
    'empty': [],
};

export interface RightPanelContextResult {
    context: PanelContext;
    isPinned: boolean;
    pin: () => void;
    unpin: () => void;
    setActiveTab: (tab: PanelTab) => void;
}

export function useRightPanelContext(): RightPanelContextResult {
    // Read all potential context sources
    const sources = useAtomValue(sourceListAtom);
    const proposals = useAtomValue(pendingProposalsAtom);
    const toolTimeline = useAtomValue(toolTimelineAtom);
    const terminalOutput = useAtomValue(terminalOutputAtom);
    const diagramState = useAtomValue(diagramStateAtom);
    const devServerUrl = useAtomValue(devServerUrlAtom);  // Lovable-style live preview
    const [pinnedPanel, setPinnedPanel] = useAtom(pinnedPanelAtom);
    const [activeTab, setActiveTab] = useAtom(previewTabAtom);

    // Get the last tool call for context detection
    const lastToolCall = toolTimeline[toolTimeline.length - 1];

    // Determine panel type based on priority
    const detectedType = useMemo((): PanelType => {
        // Priority 1: Active file diff (unapproved proposals)
        // Check for !approved to catch both undefined and false
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

        // Priority 6: Check for any recent sources (might have been from earlier)
        if (sources.length > 0) {
            return 'web-search';
        }

        // Priority 7: Check for any diagram
        if (diagramState) {
            return 'diagram';
        }

        // Default: empty
        // Note: Tool activity removed - ThinkingCard shows tool calls
        return 'empty';
    }, [sources, proposals, lastToolCall, diagramState, terminalOutput, devServerUrl]);

    // Use pinned panel if set, otherwise use detected type
    const effectiveType = pinnedPanel ?? detectedType;

    // Build context object
    const context = useMemo((): PanelContext => {
        const tabs = PANEL_TABS[effectiveType];

        // Ensure active tab is valid for current panel type
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
            }),
        };
    }, [effectiveType, activeTab, sources, proposals, diagramState, terminalOutput, toolTimeline]);

    return {
        context,
        isPinned: pinnedPanel !== null,
        pin: () => setPinnedPanel(effectiveType),
        unpin: () => setPinnedPanel(null),
        setActiveTab,
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
    }
) {
    switch (type) {
        case 'web-search':
            return { sources: state.sources, timeline: state.toolTimeline };
        case 'file-diff':
            return { proposals: state.proposals };
        case 'diagram':
            return state.diagramState;
        case 'terminal':
            return state.terminalOutput;
        case 'tools':
            return { timeline: state.toolTimeline };
        case 'code-preview':
            return { url: state.devServerUrl };  // Live preview URL
        default:
            return null;
    }
}

export default useRightPanelContext;
