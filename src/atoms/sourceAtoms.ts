/**
 * Source & Panel State Atoms
 * ==========================
 * State management for the context-aware right panel
 */

import { atom } from "jotai";
import { type ParsedError } from "@/lib/devServerErrorParser";
import type { PlanChangesPayload } from "@/lib/plan-changes/plan-changes";

// ═══════════════════════════════════════════════════════════
// PANEL TYPES
// ═══════════════════════════════════════════════════════════

export type PanelType =
  | "web-search" // Source cards + iframe preview
  | "code-preview" // Live preview iframe (frontend); 'plan' rides as a tab here
  | "terminal" // Command output
  | "files" // File explorer (default)
  | "tools" // Tool execution activity
  | "empty"; // No content

export type PanelTab =
  | "sources"
  | "tools"
  | "debug"
  | "preview"
  | "terminal"
  | "logs"
  | "files"
  | "approve"
  | "permission"
  | "errors"
  | "network"
  | "permissions"
  | "search"
  | "chat"
  | "plan"
  | "automations";

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
// Layer 1: AI specifies semantic intent (e.g., 'show-preview')
// Layer 2: Frontend maps intent to correct UI component (e.g., 'code-preview')
// This preserves AI control while ensuring correct UI rendering.

/** Valid AI panel intents - semantic descriptions of what to show */
export type AIPanelIntent =
  | "show-permissions" // Approvals are inline in chat → maps to 'code-preview'
  | "show-file-changes" // Diffs are inline in chat → maps to 'code-preview'
  | "show-web-search" // Show web search results → maps to 'web-search'
  | "show-terminal" // Show command output → maps to 'terminal'
  | "show-plan" // Show ATLARIX plan execution panel → maps to 'plan'
  | "show-files" // Show file explorer → maps to 'files'
  | "show-preview" // Show dev server preview → maps to 'code-preview'
  | "hide" // Clear/hide panel → maps to 'empty'
  | "empty"; // No specific content → maps to 'empty'

export interface AIPanelIntentState {
  intent: AIPanelIntent;
  context?: {
    operationId?: string; // For a file operation or permission
    searchId?: string; // For web-search
    commandId?: string; // For terminal
    chatId?: number; // For permission queue panel
    message?: string; // User-facing explanation
  };
  timestamp: number;
  source: "ai" | "user" | "system"; // Who triggered the change
}

/** AI panel intent state - specifies WHAT to show, frontend maps to HOW */
export const aiPanelIntentAtom = atom<AIPanelIntentState | null>(null);

/**
 * Map AI semantic intent to actual panel type (UI component).
 * This is the key function that bridges AI intent to correct UI.
 */
export function mapIntentToView(
  intent: AIPanelIntent | null,
): PanelType | null {
  if (!intent) return null;

  switch (intent) {
    case "show-permissions":
    case "show-file-changes":
      // Approvals and diffs render inline in chat; show the workspace panel
      return "code-preview";

    case "show-web-search":
      return "web-search";

    case "show-terminal":
      return "terminal";

    case "show-files":
      return "files";

    case "show-preview":
      return "code-preview";

    case "show-plan":
      // v13.1: plan is a tab within the workspace panel (the renderer sets
      // previewTabAtom('plan')), not its own takeover panel type.
      return "code-preview";

    case "hide":
    case "empty":
      return "empty";

    default:
      // Unknown intent - let heuristics handle it
      console.warn(
        `[mapIntentToView] Unknown AI intent: ${intent}, falling back to heuristics`,
      );
      return null;
  }
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
  source: string; // stackoverflow, github, reddit, etc.
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
  status: "running" | "completed" | "error";
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
    | "model_selection"
    | "delegation"
    | "delegation_start"
    | "delegation_complete"
    | "delegation_error"
    | "self_review"
    | "background"
    | "tool_use"
    | "turn_summary"
    | "mode_change"
    | "agent_message"
    | "routing_decision"
    | "classifier_routing"
    | "orchestrator_blocker"
    | "parallel_prefetch_start"
    | "parallel_prefetch_complete"
    | "build_verification_complete"
    | "plan_created"
    | "duration_limit_reached"
    | "loop_detected"
    | "loop_repetition_aborted"
    | "stream_stall_aborted"
    | "tier_selection"
    | "tier_escalation"
    | "reasoning_started"
    | "reasoning_complete"
    | "subagent_start"
    | "subagent_progress"
    | "subagent_thought"
    | "subagent_tokens"
    | "subagent_complete";
  label: string;
  status: "running" | "done" | "error" | "active";
  tokens?: number;
  cost?: number;
  timestamp: number;
  detail?: string;
  /** Full tool result JSON for chat expand panels (diff, search links, terminal output). */
  resultText?: string;
  /** Tool invocation args when available (for expand path/command preview). */
  toolArgs?: Record<string, unknown>;
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
  /** Groups ThoughtsPanel rows for one session. */
  sessionId?: string;
  participantCount?: number;
  /** Short preview text (e.g. participant snippet). */
  preview?: string;
  /** plan_created: number of steps */
  stepCount?: number;
  /** Synthesis character count (not token usage). */
  synthesisLength?: number;
  /** Agent bus mirror on chat:activity — original bus `type` for filtering internal rows. */
  agentMessageType?: string;
  /** loop_detected / loop_repetition_aborted: tool that repeated (write_file | run_command). */
  toolName?: string;
  /** AI SDK per-invocation id (Fix 2) — stable thread-item key for tool_use rows. */
  toolCallId?: string;
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

// ═══════════════════════════════════════════════════════════
// PANEL STATE ATOMS
// ═══════════════════════════════════════════════════════════

/** Active tab in right panel */
export const previewTabAtom = atom<PanelTab>("sources");

/** Pinned panel type (prevents auto-switching) */
export const pinnedPanelAtom = atom<PanelType | null>(null);

/**
 * Ordered, VISIBLE right-panel tabs + the active one, synced from
 * useRightPanelContext (the single source of the assembled/filtered order). Lets
 * keyboard shortcuts (Cmd/Ctrl+I ← / Cmd/Ctrl+O →) move between tabs without
 * re-deriving the order. `tabs` matches exactly what the strip renders.
 */
export const rightPanelOrderedTabsAtom = atom<{
  tabs: PanelTab[];
  active: PanelTab;
}>({
  tabs: [],
  active: "sources",
});

/** Open state of the Cmd/Ctrl+J model picker (lifted from ChatInputControls
 *  so the global shortcut hub can open it). */
export const modelSheetOpenAtom = atom<boolean>(false);

/**
 * Mounted composers, in mount order — the last one owns Cmd/Ctrl+J.
 *
 * `ChatInputControls` can be mounted twice (the main composer and the right
 * panel's Chat tab), and `modelSheetOpenAtom` is one boolean, so without this
 * the chord would open both pickers at once. See `hooks/useModelPickerOpen.ts`
 * for the whole argument; nothing should read this atom directly.
 */
export const modelPickerMountsAtom = atom<string[]>([]);

// ═══════════════════════════════════════════════════════════
// FILE DIFF ATOMS (Code Changes)
// ═══════════════════════════════════════════════════════════

export interface FileProposal {
  id: string;
  chatId: number; // Track which chat session this proposal belongs to
  path: string; // File path or empty for commands
  operation: "create" | "modify" | "delete" | "rename" | "command";
  oldContent?: string;
  newContent?: string;
  description?: string;
  approved?: boolean;
  command?: string; // For command operations
  workingDir?: string; // Working directory for commands
}

/** Pending file proposals awaiting approval */
export const pendingProposalsAtom = atom<FileProposal[]>([]);

// Diagram atoms removed with the diagram subsystem — architecture viz is inline markmap/graph in chat.

// ═══════════════════════════════════════════════════════════
// TERMINAL ATOMS
// ═══════════════════════════════════════════════════════════

export interface TerminalOutput {
  operationId: string; // Unique ID for this command execution
  command: string; // The command being run
  output: string; // Combined stdout/stderr output
  status: "running" | "completed" | "error";
  exitCode?: number;
  duration?: number; // Execution time in ms
  startTime: number; // When command started (Date.now())
  /** A long-running/background process (server) — gets its own terminal tab. */
  background?: boolean;
}

/** Map of operationId → TerminalOutput for multiple concurrent commands */
export const terminalOutputsAtom = atom<Map<string, TerminalOutput>>(new Map());

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
  /** Stored plan name; null on rows predating the title column. */
  title: string | null;
  changes: PlanChangesPayload | null;
  /**
   * Set when the USER picked a plan in the panel's switcher.
   *
   * Load-bearing: plan-artifact activation otherwise replaces whatever the panel
   * is showing, so choosing an older plan and then having the agent touch a
   * different one would yank the panel away mid-read. While pinned, activation
   * only raises the unread badge. Cleared by choosing "Latest".
   */
  pinnedPlanId: string | null;
}>({
  planId: null,
  content: null,
  planStatus: null,
  sessionId: null,
  title: null,
  changes: null,
  pinnedPlanId: null,
});

export const rightPanelSuppressAutoOpenAtom = atom<boolean>(false);

/** Panel width in pixels (for resize). Persisted in localStorage (atlarix-right-panel-width) by RightPanel. */
export const rightPanelWidthAtom = atom<number>(400);

/** Dev server URL for live preview (Lovable-style) */
export const devServerUrlAtom = atom<string | null>(null);

/** A running background command (for the "jobs running" indicator + cancel). */
export interface BackgroundJobView {
  operationId: string;
  command: string;
  startedAt: number;
  elapsedMs: number;
  /** v14.8.10: the idle-stall watchdog flagged this job as gone quiet. */
  stalled?: boolean;
  /** v14.8.10: this job's `wake_on` condition has matched. */
  wakeMatched?: boolean;
}

/**
 * Running background jobs per chatId — fed by the chat:background-job-update
 * event (renderer refreshes via background-jobs-list). Drives the indicator
 * chip while you chat; emptied as jobs finish/cancel.
 */
export const backgroundJobsByChatIdAtom = atom<
  Record<number, BackgroundJobView[]>
>({});

/** A running sub-agent (v14.21) — the `task` equivalent of BackgroundJobView. */
export interface SubagentJobView {
  taskId: string;
  description: string;
  elapsedMs: number;
  lastOutput: string;
  /** No activity for a long while — it may be genuinely wedged. */
  stalled?: boolean;
}

/**
 * Running sub-agents per chatId. Fed by the SAME chat:background-job-update
 * event as commands (discriminated by `source:"subagent"`) — sub-agents were
 * previously skipped by that refresh entirely, which is why there was no way to
 * see or stop one from the UI.
 */
export const subagentJobsByChatIdAtom = atom<Record<number, SubagentJobView[]>>(
  {},
);

// ═══════════════════════════════════════════════════════════
// BROWSER ERRORS (Live Preview Console Errors)
// ═══════════════════════════════════════════════════════════

export type BrowserError = ParsedError;

/** Browser errors captured from the live preview iframe */
export const browserErrorsAtom = atom<ParsedError[]>([]);

/** Stable signature for an error (message + file + line). Used to re-show dismissed errors when the same error recurs. */
export function getErrorSignature(error: ParsedError): string {
  return `${error.message}|${error.file ?? ""}|${error.line ?? ""}`;
}

/** Signatures of errors the user has marked done. When the same error is seen again (same message/file/line), it is re-shown and removed from this set. */
export const dismissedErrorSignaturesAtom = atom<Set<string>>(
  new Set<string>(),
);

/** Visible browser errors: current list minus those whose signature is in the dismissed set. */
export const visibleBrowserErrorsAtom = atom((get) => {
  const errors = get(browserErrorsAtom);
  const dismissed = get(dismissedErrorSignaturesAtom);
  return errors.filter((e) => !dismissed.has(getErrorSignature(e)));
});

// ═══════════════════════════════════════════════════════════
// PAGE CONSOLE (every level, from the in-app browser tabs)
// ═══════════════════════════════════════════════════════════
// Distinct from `browserErrorsAtom` above, which holds parsed BUILD/dev-server
// errors grouped by file. This is the page's own console as a chronological
// stream — a console is not a file tree — and it carries `log`/`info`/`debug`
// too, so the panel can show that something WORKED rather than only that
// something broke.

export type PageConsoleEntry =
  import("@/ipc/utils/browser_view_manager").BrowserSurfaceError;

/** Rolling page-console stream. Capped in the listener, not here. */
export const pageConsoleAtom = atom<PageConsoleEntry[]>([]);

/**
 * Unread counts for the Console and Network tabs, mirroring automations'
 * `unreadCount`.
 *
 * This is what replaced the completion gate on the USER's side. Nothing blocks a
 * turn any more, so the way a person finds out something broke is a badge they
 * can act on — or ignore, which is the whole point. Cleared by RightPanel when
 * the matching tab is on screen.
 */
export const consoleUnreadCountAtom = atom(0);
export const networkUnreadCountAtom = atom(0);

/**
 * The Plan tab has a plan the user has not looked at yet.
 *
 * Reopening a session used to switch the right panel to Plan and force it open.
 * That reads a "let me look at this again" as "resume that plan", and it is worse
 * with several plans in a session: only the newest is restored, so ONE plan is
 * presented as though it were THE plan with nothing saying the others exist —
 * the same shape as a card labelled with the wrong page.
 *
 * A badge says the same thing without taking the surface: the plan is still
 * there, still in the transcript as an inline card, one click away. Same
 * vocabulary as Console/Network, cleared by RightPanel when the tab is shown.
 */
export const planUnreadAtom = atom(false);

export type ConsoleLevelFilter =
  | "problems"
  | "all"
  | "errors"
  | "warnings"
  | "logs";

/**
 * Defaults to `problems` — errors + warnings + load/crash/request failures —
 * which is exactly what the tab showed before every level was captured. Nothing
 * changes on screen until the user asks for more.
 */
export const consoleLevelFilterAtom = atom<ConsoleLevelFilter>("problems");

export const visiblePageConsoleAtom = atom((get) => {
  const entries = get(pageConsoleAtom);
  const filter = get(consoleLevelFilterAtom);
  // Navigation markers survive EVERY filter. They are dividers, not entries —
  // hiding them is how you end up reading one page's logs under another page's
  // heading, which is the confusion they exist to remove.
  const keep = (e: PageConsoleEntry, matches: boolean) =>
    e.type === "navigated" || matches;
  if (filter === "all") return entries;
  if (filter === "errors") {
    return entries.filter((e) =>
      keep(e, e.level === "error" || e.type !== "console-error"),
    );
  }
  if (filter === "warnings")
    return entries.filter((e) => keep(e, e.level === "warning"));
  if (filter === "logs") {
    return entries.filter((e) =>
      keep(
        e,
        e.type === "console-error" &&
          e.level !== "error" &&
          e.level !== "warning",
      ),
    );
  }
  // 'problems' (default): errors, warnings, and non-console failures.
  return entries.filter((e) =>
    keep(
      e,
      e.type !== "console-error" ||
        e.level === "error" ||
        e.level === "warning",
    ),
  );
});
