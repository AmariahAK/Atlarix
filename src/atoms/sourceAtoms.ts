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
    | 'empty';          // No content

export type PanelTab = 'sources' | 'tools' | 'debug' | 'preview' | 'code' | 'terminal' | 'diagram' | 'logs' | 'files' | 'diff' | 'approve';

export interface PanelContext {
    type: PanelType;
    tabs: PanelTab[];
    activeTab: PanelTab;
    data?: any;
}

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
    path: string;
    operation: 'create' | 'modify' | 'delete' | 'rename';
    oldContent?: string;
    newContent?: string;
    description?: string;
    approved?: boolean;
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
    code: string;
    type: 'mermaid' | 'plantuml';
    compareMode: 'current' | 'before' | 'after' | 'side-by-side';
    beforeCode?: string;
    afterCode?: string;
}

/** Current diagram state */
export const diagramStateAtom = atom<DiagramState | null>(null);

// ═══════════════════════════════════════════════════════════
// TERMINAL ATOMS
// ═══════════════════════════════════════════════════════════

export interface TerminalOutput {
    commandId: string;
    command: string;
    output: string[];
    status: 'running' | 'completed' | 'error';
    exitCode?: number;
}

/** Current terminal output */
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
