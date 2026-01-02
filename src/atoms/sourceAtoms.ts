/**
 * Source & Panel State Atoms
 * ==========================
 * State management for the context-aware right panel
 */

import { atom } from 'jotai';

// ═══════════════════════════════════════════════════════════
// PANEL TYPES
// ═══════════════════════════════════════════════════════════

export type PanelType =
    | 'web-search'      // Source cards + iframe preview
    | 'code-preview'    // Live preview iframe (frontend)
    | 'diagram'         // Architecture diagram (backend)
    | 'terminal'        // Command output
    | 'file-diff'       // File changes + approval
    | 'files'           // File explorer (default)
    | 'timeline'        // Diagram timeline (project evolution)
    | 'tools'           // Tool execution activity (Ask mode)
    | 'permission'      // Permission approval panel (run_command, write_file)
    | 'empty';          // No content

export type PanelTab = 'sources' | 'tools' | 'debug' | 'preview' | 'code' | 'terminal' | 'diagram' | 'logs' | 'files' | 'diff' | 'approve' | 'timeline' | 'permission';

export interface PanelContext {
    type: PanelType;
    tabs: PanelTab[];
    activeTab: PanelTab;
    data?: any;
}

// ═══════════════════════════════════════════════════════════
// AI PANEL INTENT SYSTEM (Hybrid Approach)
// ═══════════════════════════════════════════════════════════
// Two-layer system:
// Layer 1: AI specifies semantic intent (e.g., 'show-permissions')
// Layer 2: Frontend maps intent to correct UI component (e.g., 'file-diff')
// This preserves AI control while ensuring correct UI rendering.

/** Valid AI panel intents - semantic descriptions of what to show */
export type AIPanelIntent =
    | 'show-permissions'    // Show file/command approval UI → maps to 'file-diff'
    | 'show-file-changes'   // Show file diff viewer → maps to 'file-diff'
    | 'show-web-search'     // Show web search results → maps to 'web-search'
    | 'show-diagram'        // Show architecture diagram → maps to 'diagram'
    | 'show-terminal'       // Show command output → maps to 'terminal'
    | 'show-timeline'       // Show diagram history → maps to 'timeline'
    | 'show-files'          // Show file explorer → maps to 'files'
    | 'hide'                // Clear/hide panel → maps to 'empty'
    | 'empty';              // No specific content → maps to 'empty'

export interface AIPanelIntentState {
    intent: AIPanelIntent;
    context?: {
        operationId?: string;    // For file-diff or permission
        searchId?: string;       // For web-search
        diagramId?: string;      // For diagram
        commandId?: string;      // For terminal
        message?: string;        // User-facing explanation
    };
    timestamp: number;
    source: 'ai' | 'user' | 'system';  // Who triggered the change
}

/** AI panel intent state - specifies WHAT to show, frontend maps to HOW */
export const aiPanelIntentAtom = atom<AIPanelIntentState | null>(null);

/**
 * Map AI semantic intent to actual panel type (UI component).
 * This is the key function that bridges AI intent to correct UI.
 */
export function mapIntentToView(intent: AIPanelIntent | null): PanelType | null {
    if (!intent) return null;

    switch (intent) {
        case 'show-permissions':
        case 'show-file-changes':
            // Both map to FileDiffPanel (handles file changes AND permission approvals)
            return 'file-diff';

        case 'show-web-search':
            return 'web-search';

        case 'show-diagram':
            return 'diagram';

        case 'show-terminal':
            return 'terminal';

        case 'show-timeline':
            return 'timeline';

        case 'show-files':
            return 'files';

        case 'hide':
        case 'empty':
            return 'empty';

        default:
            // Unknown intent - let heuristics handle it
            console.warn(`[mapIntentToView] Unknown AI intent: ${intent}, falling back to heuristics`);
            return null;
    }
}

// Legacy: Keep for backwards compatibility during transition
export interface AIPanelState {
    view: PanelType;
    context?: {
        operationId?: string;
        searchId?: string;
        diagramId?: string;
        commandId?: string;
        message?: string;
    };
    timestamp: number;
    source: 'ai' | 'user' | 'system';
}

/** @deprecated Use aiPanelIntentAtom instead */
export const aiControlledPanelAtom = atom<AIPanelState | null>(null);

// ═══════════════════════════════════════════════════════════
// SOURCE ATOMS (Web Search)
// ═══════════════════════════════════════════════════════════

export interface SourceItem {
    id: string;
    title: string;
    url: string;
    snippet: string;
    favicon?: string;
    source: string;     // stackoverflow, github, reddit, etc.
    score?: number;
}

/** Currently selected source for preview */
export const selectedSourceAtom = atom<SourceItem | null>(null);

/** All sources from current search */
export const sourceListAtom = atom<SourceItem[]>([]);

// ═══════════════════════════════════════════════════════════
// TOOL TIMELINE ATOMS
// ═══════════════════════════════════════════════════════════

export interface ToolExecution {
    id: string;
    name: string;
    status: 'running' | 'completed' | 'error';
    startTime: number;
    endTime?: number;
    duration?: number;
    result?: any;
    error?: string;
}

/** Tool execution history for timeline display */
export const toolTimelineAtom = atom<ToolExecution[]>([]);

// ═══════════════════════════════════════════════════════════
// PANEL STATE ATOMS
// ═══════════════════════════════════════════════════════════

/** Active tab in right panel */
export const previewTabAtom = atom<PanelTab>('sources');

/** Pinned panel type (prevents auto-switching) */
export const pinnedPanelAtom = atom<PanelType | null>(null);

/** Current panel context - computed from various signals */
export const panelContextAtom = atom<PanelContext>({
    type: 'empty',
    tabs: [],
    activeTab: 'sources',
    data: null
});

// ═══════════════════════════════════════════════════════════
// FILE DIFF ATOMS (Code Changes)
// ═══════════════════════════════════════════════════════════

export interface FileProposal {
    id: string;
    chatId: number;  // Track which chat session this proposal belongs to
    path: string;    // File path or empty for commands
    operation: 'create' | 'modify' | 'delete' | 'rename' | 'command';
    oldContent?: string;
    newContent?: string;
    description?: string;
    approved?: boolean;
    command?: string;  // For command operations
    workingDir?: string;  // Working directory for commands
}

/** Pending file proposals awaiting approval */
export const pendingProposalsAtom = atom<FileProposal[]>([]);

/** Currently selected proposal for diff view */
export const selectedProposalAtom = atom<FileProposal | null>(null);

/** Overall approval state */
export const approvalStateAtom = atom<{
    approved: string[];
    rejected: string[];
}>({ approved: [], rejected: [] });

// ═══════════════════════════════════════════════════════════
// DIAGRAM ATOMS
// ═══════════════════════════════════════════════════════════

export interface DiagramState {
    id?: number;
    code: string;
    type: 'mermaid' | 'plantuml' | 'architecture' | 'sequence' | 'class' | 'flowchart';
    compareMode: 'current' | 'before' | 'after' | 'side-by-side';
    beforeCode?: string;
    afterCode?: string;
    title?: string;
}

/** Current diagram state */
export const diagramStateAtom = atom<DiagramState | null>(null);

// ═══════════════════════════════════════════════════════════
// TERMINAL ATOMS
// ═══════════════════════════════════════════════════════════

export interface TerminalOutput {
    operationId: string;    // Unique ID for this command execution
    command: string;        // The command being run
    output: string;         // Combined stdout/stderr output
    status: 'running' | 'completed' | 'error';
    exitCode?: number;
    duration?: number;      // Execution time in ms
    startTime: number;      // When command started (Date.now())
}

/** Map of operationId → TerminalOutput for multiple concurrent commands */
export const terminalOutputsAtom = atom<Map<string, TerminalOutput>>(new Map());

/** Current terminal output (legacy - for single command view) */
export const terminalOutputAtom = atom<TerminalOutput | null>(null);

// ═══════════════════════════════════════════════════════════
// PANEL VISIBILITY
// ═══════════════════════════════════════════════════════════

/** Whether right panel is visible */
export const rightPanelVisibleAtom = atom<boolean>(false);

/** Whether panel content is loading (e.g., during search) */
export const rightPanelLoadingAtom = atom<boolean>(false);

/** Panel width in pixels (for resize) */
export const rightPanelWidthAtom = atom<number>(400);

/** Dev server URL for live preview (Lovable-style) */
export const devServerUrlAtom = atom<string | null>(null);

/** Project type detected by DevServerProvider - used for backend diagram fallback */
export type ProjectType = 'frontend' | 'backend' | 'unknown';
export const projectTypeAtom = atom<ProjectType>('unknown');

// ═══════════════════════════════════════════════════════════
// PANEL HISTORY (for breadcrumb navigation)
// ═══════════════════════════════════════════════════════════

export interface PanelHistoryEntry {
    type: PanelType;
    tab: PanelTab;
    timestamp: number;
    title: string;
}

/** Panel navigation history */
export const panelHistoryAtom = atom<PanelHistoryEntry[]>([]);

/** Current position in history (for back/forward) */
export const panelHistoryIndexAtom = atom<number>(-1);
