/**
 * Source & Panel State Atoms
 * ==========================
 * State management for the context-aware right panel
 */

import { atom } from 'jotai';
import { type ParsedError } from '@/lib/devServerErrorParser';
import type { PlanChangesPayload } from '@/lib/plan-changes/plan-changes';
import type { PlanUpdatePayload } from '@/ipc/ipc_types';

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
    | 'plan'            // ATLARIX plan + changes summary
    | 'empty';          // No content

export type PanelTab = 'sources' | 'tools' | 'debug' | 'preview' | 'code' | 'terminal' | 'diagram' | 'logs' | 'files' | 'diff' | 'approve' | 'timeline' | 'permission' | 'errors' | 'permissions' | 'search' | 'vault' | 'activity' | 'chat' | 'plan';

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
    | 'show-plan'           // Show ATLARIX plan execution panel → maps to 'plan'
    | 'show-files'          // Show file explorer → maps to 'files'
    | 'show-preview'        // Show dev server preview → maps to 'code-preview'
    | 'hide'                // Clear/hide panel → maps to 'empty'
    | 'empty';              // No specific content → maps to 'empty'

export interface AIPanelIntentState {
    intent: AIPanelIntent;
    context?: {
        operationId?: string;    // For file-diff or permission
        searchId?: string;       // For web-search
        diagramId?: string;      // For diagram
        commandId?: string;      // For terminal
        chatId?: number;         // For permission queue panel
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
            // Both map to FileDiffPanel (approve tab shows permission queue)
            return 'file-diff';

        case 'show-web-search':
            return 'web-search';

        case 'show-diagram':
            return 'code-preview';

        case 'show-terminal':
            return 'terminal';

        case 'show-timeline':
            return 'timeline';

        case 'show-files':
            return 'files';

        case 'show-preview':
            return 'code-preview';

        case 'show-plan':
            return 'plan';

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

/** v2.1: Activity Stream items (model selection, delegation, compaction, tool use) */
export interface ActivityStreamItem {
  id: string;
  type:
    | 'model_selection'
    | 'delegation'
    | 'delegation_start'
    | 'delegation_complete'
    | 'delegation_error'
    | 'self_review'
    | 'background'
    | 'tool_use'
    | 'turn_summary'
    | 'mode_change'
    | 'agent_message'
    | 'routing_decision'
    | 'classifier_routing'
    | 'orchestrator_blocker'
    | 'parallel_prefetch_start'
    | 'parallel_prefetch_complete'
    | 'counsel_start'
    | 'counsel_participant_complete'
    | 'counsel_synthesising'
    | 'counsel_complete'
    | 'counsel_timeout'
    | 'build_verification_complete'
    | 'memory_saved'
    | 'plan_created'
    | 'duration_limit_reached'
    | 'loop_detected'
    | 'loop_repetition_aborted'
    | 'stream_stall_aborted'
    | 'tier_selection'
    | 'tier_escalation'
    | 'counsel_thinking'
    | 'reasoning_started'
    | 'reasoning_complete'
    | 'subagent_start'
    | 'subagent_progress'
    | 'subagent_complete';
  label: string;
  status: 'running' | 'done' | 'error' | 'active';
  tokens?: number;
  cost?: number;
  timestamp: number;
  detail?: string;
  parentId?: string;
  /** Delegation: agent id, task snippet, depth; for pipeline/graph */
  agent?: string;
  task?: string;
  depth?: number;
  result?: string;
  duration?: number;
  tools?: string[];
  /** Agent message: from/to for mesh threading */
  fromAgent?: string;
  toAgent?: string;
  threadId?: string;
  /** When set, activity was scoped to this chat (used for stream-local buffers). */
  chatId?: number;
  /** Counsel: groups ThoughtsPanel rows for one multi-model session. */
  sessionId?: string;
  participantCount?: number;
  counselRole?: 'fast' | 'balanced' | 'thinking' | 'synthesis';
  /** Short preview text (e.g. counsel participant snippet). */
  preview?: string;
  /** plan_created: number of steps */
  stepCount?: number;
  /** Counsel complete: synthesis character count (not token usage). */
  synthesisLength?: number;
  /** counsel_start: how counsel was triggered (user_command, auto_complex, deep_think_fallback, …). */
  counselTrigger?: string;
  /** Agent bus mirror on chat:activity — original bus `type` for filtering internal rows. */
  agentMessageType?: string;
  /** loop_detected / loop_repetition_aborted: tool that repeated (write_file | run_command). */
  toolName?: string;
  /** Normalized path or command key for repetition detection. */
  loopTarget?: string;
  /** Occurrences in sliding window when stuck was detected. */
  loopCount?: number;
  /** Agent bus: model id for this hop (optional). */
  modelId?: string;
  /** Agent bus: response duration in ms (optional). */
  responseMs?: number;
  /** Sub-agent card: specialist id (explore, architect, …). */
  agentType?: string;
  /** Workspace scope label (focus path, preset, repo snippet). */
  scope?: string;
  /** Tool call id that spawned this sub-agent. */
  parentToolId?: string;
  /** Delegation id for nesting tool/thought rows under a sub-agent card. */
  parentDelegationId?: string;
  /** Turn-scoped sub-agent round id (groups cards in one panel). */
  roundId?: string;
  /** Parsed handoff JSON for reload / expand. */
  structured?: unknown;
}

/** Last N agent-bus lines for the Thinking card (keyed by chat id). */
export interface AgentBusExchange {
  id: string;
  label: string;
  fromAgent?: string;
  toAgent?: string;
  timestamp: number;
  type: string;
  modelId?: string;
  responseMs?: number;
}

export const activityStreamItemsAtom = atom<ActivityStreamItem[]>([]);

export const agentBusRingByChatIdAtom = atom<Record<number, AgentBusExchange[]>>({});

/** v2.5: Current agent phase from activity stream for canvas animations (architect → containers, builder → beacons, reviewer → edges). */
export type AgentPhase = "architect" | "builder" | "reviewer" | null;
export const agentPhaseFromActivityAtom = atom<{ phase: AgentPhase; active: boolean }>((get) => {
  const items = get(activityStreamItemsAtom);
  const delegation = [...items].reverse().find(
    (i) =>
      (i.type === "delegation_start" || i.type === "delegation_complete" || i.type === "delegation_error") &&
      typeof i.agent === "string" &&
      ["architect", "builder", "reviewer"].includes(i.agent)
  );
  if (!delegation) return { phase: null, active: false };
  const phase = delegation.agent as AgentPhase;
  const active = delegation.type === "delegation_start" || delegation.status === "running";
  return { phase, active };
});

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
    type: 'mermaid' | 'architecture' | 'sequence' | 'class' | 'flowchart';
    compareMode: 'current' | 'before' | 'after' | 'side-by-side';
    beforeCode?: string;
    afterCode?: string;
    title?: string;
    /** Workspace this diagram belongs to (for selector sync) */
    workspaceId?: number | null;
    /** PASS6: main diagram vs auxiliary reference slices from get_diagram(role:"reference") */
    role?: 'main' | 'reference';
}

/** Secondary diagram slices (e.g. scoped class diagrams) shown as chips next to the main panel diagram */
export interface DiagramReferenceEntry {
    id: string;
    title?: string;
    code: string;
    type: DiagramState['type'];
}

export const diagramReferencesAtom = atom<DiagramReferenceEntry[]>([]);

/** AI-pushed blueprint graph for the Diagram tab (single active canvas). */
export interface BlueprintPanelRoom {
  id: string;
  name: string;
  files?: string[];
  functions?: string[];
}

export interface BlueprintPanelEdge {
  from: string;
  to: string;
  type?: string;
}

export interface BlueprintPanelState {
  workspaceId?: number | null;
  title?: string;
  rooms: BlueprintPanelRoom[];
  edges: BlueprintPanelEdge[];
  updatedAt: number;
}

export const blueprintStateAtom = atom<BlueprintPanelState | null>(null);

/** Current diagram state */
export const diagramStateAtom = atom<DiagramState | null>(null);

/** Diagram staleness warning - shown when external changes detected */
/** Git-based decision for Update vs Regenerate (when workspace is git) */
export interface GitDiagramDecision {
    action: 'none' | 'update' | 'regenerate';
    reason: string;
    confidence: number;
    totalFiles: number;
    linesAdded: number;
    linesDeleted: number;
}

export interface DiagramStalenessWarning {
    diagramId: number;
    isStale: boolean;
    severity: 'none' | 'minor' | 'moderate' | 'major';
    reason: string;
    recommendation: 'keep' | 'suggest-refresh' | 'force-refresh';
    /** When workspace is git: whether to update existing diagram or regenerate */
    gitDecision?: GitDiagramDecision;
}

export const diagramStalenessAtom = atom<DiagramStalenessWarning | null>(null);

// Pass 7: Legacy Blueprint editor atoms removed (`diagramViewModeAtom`, `blueprintAiEditingAtom`).
// `blueprintStateAtom` — legacy panel state; primary architecture viz is inline markmap/mermaid in chat.

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

/**
 * When true, streaming handlers should not call setRightPanelVisible(true) for
 * non-critical UI (sources, diagram tool results, terminal). Cleared when the user
 * opens the panel explicitly.
 */
/** Right-panel Plan tab: active session plan artifact from DB. */
export const workspacePlanPanelAtom = atom<{
  planId: string | null;
  content: string | null;
  planStatus: "plan" | "building" | "built" | null;
  sessionId: string | null;
  changes: PlanChangesPayload | null;
}>({
  planId: null,
  content: null,
  planStatus: null,
  sessionId: null,
  changes: null,
});

export const activePlanArtifactIdAtom = atom<string | null>(null);

export const rightPanelSuppressAutoOpenAtom = atom<boolean>(false);

/** Whether left panel is visible (extension panel). Toggled by Cmd+I / Ctrl+I when Pro. */
export const leftPanelVisibleAtom = atom<boolean>(false);

/** Whether panel content is loading (e.g., during search) */
export const rightPanelLoadingAtom = atom<boolean>(false);

/** Panel width in pixels (for resize). Persisted in localStorage (atlarix-right-panel-width) by RightPanel. */
export const rightPanelWidthAtom = atom<number>(400);

/** Left panel width in pixels (for resize). Persisted in localStorage (atlarix-left-panel-width) by LeftPanel. Default 280. */
export const leftPanelWidthAtom = atom<number>(280);

/** Dev server URL for live preview (Lovable-style) */
export const devServerUrlAtom = atom<string | null>(null);

/** Project type detected by DevServerProvider - used for backend diagram fallback */
export type ProjectType = 'frontend' | 'backend' | 'unknown';
export const projectTypeAtom = atom<ProjectType>('unknown');

// ═══════════════════════════════════════════════════════════
// BROWSER ERRORS (Live Preview Console Errors)
// ═══════════════════════════════════════════════════════════

export type BrowserError = ParsedError;

/** Browser errors captured from the live preview iframe */
export const browserErrorsAtom = atom<ParsedError[]>([]);

/** Stable signature for an error (message + file + line). Used to re-show dismissed errors when the same error recurs. */
export function getErrorSignature(error: ParsedError): string {
  return `${error.message}|${error.file ?? ''}|${error.line ?? ''}`;
}

/** Signatures of errors the user has marked done. When the same error is seen again (same message/file/line), it is re-shown and removed from this set. */
export const dismissedErrorSignaturesAtom = atom<Set<string>>(new Set<string>());

/** Visible browser errors: current list minus those whose signature is in the dismissed set. */
export const visibleBrowserErrorsAtom = atom((get) => {
  const errors = get(browserErrorsAtom);
  const dismissed = get(dismissedErrorSignaturesAtom);
  return errors.filter((e) => !dismissed.has(getErrorSignature(e)));
});

/** When user clicks "View code" on an error, open this file in Code tab and optionally scroll to line */
export interface SelectedErrorForCode {
  filePath: string;
  line?: number;
  column?: number;
}
export const selectedErrorForCodeAtom = atom<SelectedErrorForCode | null>(null);

/** Recent codebase search queries (max 10, for "Recent Searches" dropdown) */
export const recentCodeSearchesAtom = atom<string[]>([]);

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
