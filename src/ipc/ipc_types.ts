import { z } from "zod";
import type { DisplaySnapshotV1 } from "@/lib/chat/display-snapshot";
import type { WorkMode } from "@/lib/schemas";
import type { ProblemReport, Problem } from "../../shared/tsc_types";
export type { ProblemReport, Problem };

export interface AppOutput {
  type: "stdout" | "stderr" | "info" | "client-error" | "input-requested";
  message: string;
  timestamp: number;
  appId: number;
}

export interface RespondToAppInputParams {
  appId: number;
  response: string;
}

export interface ListAppsResponse {
  apps: App[];
  appBasePath: string;
}

export interface ChatStreamParams {
  chatId: number;
  appId?: number | null;
  /** Full prompt for the model (may include attachment XML bodies). */
  prompt: string;
  /** User-visible bubble text (chips / stub attachment tags). When omitted, uses `prompt`. */
  displayPrompt?: string;
  /** Pasted text / terminal payloads for chip preview in the UI. */
  pasteAttachments?: PasteAttachmentMeta[];
  redo?: boolean;
  attachments?: Array<{
    id?: string;
    name: string;
    type: string;
    data: string; // Base64 encoded file data
    attachmentType: "upload-to-codebase" | "chat-context"; // FileAttachment type
  }>;
  selectedComponents?: ComponentSelection[];
  /** v3.6: Override model for this message only (e.g. when user clicks Override in Auto routing preview). */
  modelOverride?: { provider: string; name: string };
  /** v3.9: When true, do not add a new user message; use the last user message content (after question answers) as prompt. */
  continueAfterQuestions?: boolean;
  /** Resume an interrupted turn (e.g. after a disconnect): add NO new user message; the
   *  model receives a `<system-reminder>` continuation directive, not a user turn. */
  continueInterrupted?: boolean;
  // Pass 7: Blueprint injection-mode + debug-trace fields removed with the Blueprint subsystem.
  /** Workspace SQLite session id for plan artifacts and message persistence. */
  workspaceSessionId?: string | null;
  /** @deprecated Plan artifacts are session DB rows; ignored. */
  prefillTaskLedger?: {
    steps: { description: string }[];
    sourcePlanMessageId?: number;
  };
  /** Custom slash command: override chat mode for this stream only. */
  streamChatModeOverride?: "ask" | "agent" | "build";
  /** Resend/edit: use this work mode for prompt + tool allowlist for this turn only. */
  workModeOverride?: WorkMode;
  /** v12 7A: run this turn as a user-defined agent (.atlarix/agents/<name>.md). */
  agentOverride?: string;
  /**
   * Set when this turn IS an automation run (unattended, no human responder).
   * unattended drops human-handoff tools; workspacePathOverride points the turn
   * at the run's isolated worktree for worktree-write automations.
   */
  automation?: {
    runId: string;
    unattended: true;
    workspacePathOverride?: string;
  };
}

/** Autonomous session review: one executed permission op logged in main. */
export interface AutonomousOpDto {
  operationId: string;
  type: string;
  path?: string;
  summary?: string;
  timestamp: number;
  result: "success" | "failed";
  reverted: boolean;
}

/** Main → renderer when an autonomous Build turn finishes with ops or bus activity. */
export interface AutonomousSessionCompletePayload {
  chatId: number;
  turnId: string;
  workspaceId?: number | null;
  ops: AutonomousOpDto[];
  agentActivity: Record<string, unknown>[];
}

/** Main → renderer: live task-ledger plan for PlanCard (scoped by chatId). */
export type PlanUpdateStepStatus = "pending" | "in_progress" | "done" | "failed";

export interface PlanUpdateStep {
  id: number;
  description: string;
  status: PlanUpdateStepStatus;
  completedAt?: number;
}

export interface PlanUpdatePayload {
  chatId: number;
  turnId: string;
  /** Assistant placeholder message id for this stream (ledger turnId may be `plan:<workspaceId>`). */
  assistantMessageId: number;
  task: string;
  steps: PlanUpdateStep[];
  status: "pending" | "in_progress" | "complete" | "failed";
}

export interface ChatResponseEnd {
  chatId: number;
  /** Bug A: monotonic id of the stream leg that produced this terminal event.
   * The renderer drops a superseded leg's late end so it can't clobber the
   * live turn's UI state. Optional — older/auxiliary terminal sends omit it. */
  streamId?: number;
  updatedFiles: boolean;
  extraFiles?: string[];
  extraFilesError?: string;
  totalTokens?: number;
  contextWindow?: number;
  /** Reasoning / thinking tokens from the last completed stream step (when reported by the provider). */
  reasoningTokens?: number;
  /** True when the turn had at least one tool execution or permission request; used to play completion sound only when relevant. */
  hadToolCallsOrPermissions?: boolean;
  /** True when the turn ended by asking the user (ask_user) rather than finishing — drives the "needs your answer" vs "finished responding" notification. */
  endedWaitingOnUser?: boolean;
  /** True when the completed turn used the managed Atlarix Core provider (for usage refresh). */
  usedCompass?: boolean;
  /** v10: auxiliary LLM tokens this turn (sub-agents, compaction) — counted toward usage. */
  auxTokens?: number;
  /**
   * Per-source split of `auxTokens`, largest first. Sub-agents are work the user
   * asked for; compaction is the app spending on their behalf — a single lumped
   * figure hid that distinction.
   */
  auxBySource?: Array<{
    source: "subagents" | "compaction" | "other";
    tokens: number;
    calls: number;
  }>;
  /** v12 7D: estimated BYOK USD cost of this turn (omitted for Core/unknown-price). */
  turnCostUsd?: number;
  /** Fix 6: this turn's billed tokens (input+output) — summed into the
   * cumulative session-spend meter (the context meter is occupancy, not spend). */
  turnTokens?: number;
  /** v12 2.3: the snapshot turn id (= ledger turn id) so a detached background
   * agent can revert this turn's writes via the shadow-git snapshot. */
  snapshotTurnId?: string;
  /**
   * The turn ended cleanly with background work still outstanding (running/
   * pending background commands or sub-agents). The renderer shows a calm
   * "waiting … will resume automatically" chip; a fresh turn auto-resumes when
   * an item reports. Distinct from a normal completed turn.
   */
  parked?: boolean;
  /** When parked: count of running background commands (for the chip text). */
  parkedCommands?: number;
  /** When parked: count of running background sub-agents (for the chip text). */
  parkedSubagents?: number;
  /**
   * v12 0.2: native-history envelope for the assistant message (JSON of the
   * turn's native tool_use/tool_result ModelMessages). The renderer persists
   * it as the assistant session message's extras.modelContent so the next
   * turn replays native parts instead of flattened prose.
   */
  assistantModelContent?: string;
}

/** v10: per-dispatch context assembly report for the context meter. */
export interface ChatContextReport {
  chatId: number;
  sections: Array<{
    name: string;
    tokens: number;
    included: boolean;
    truncated: boolean;
  }>;
  /** Human-readable trim notes (what was pruned and why). */
  trimReport: string[];
  /** Actual MODEL-FACING dispatched token total (post-compaction/slice) — the
   * meter shows this so it reflects what the model sees and DROPS after a
   * summarize, instead of the full untrimmed conversation size. */
  dispatchedTokens?: number;
  /** Resolved context window for this dispatch (denominator for the meter). */
  contextWindow?: number;
}

/** Live per-turn token usage for the composer meter (streamed during a turn).
 * Real provider usage lands at each step (inputTokens set); throttled output
 * estimates during streaming carry inputTokens=null (renderer keeps the last
 * real input baseline and just grows output). */
export interface ChatTokenUsage {
  chatId: number;
  /** Provider-reported input/context tokens; null for a mid-stream estimate. */
  inputTokens: number | null;
  /** Provider-reported or estimated output tokens so far. */
  outputTokens: number;
  /** Provider total when known (input+output+cache+reasoning). */
  totalTokens?: number;
}

/**
 * FIX 4: payload for `chat:stream:disconnected`. Emitted after silent
 * reconnect attempts (2s/5s/10s) all fail. The renderer keeps the partial
 * response visible and offers [Reconnect] (replays the same turn) and
 * [Continue] (sends a new prompt asking the model to resume).
 */
export interface ChatProblemsEvent {
  chatId: number;
  appId: number;
  problems: ProblemReport;
}

/** Result of `revert:snapshot` — restore `.atlarix/snapshots/<turnId>/` into workspace. */
export interface RevertSnapshotResult {
  success: boolean;
  error?: string;
  restoredFiles?: number;
}

export interface AttachmentInfo {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentPreview?: string;
}

/** Persisted file upload payload (survives app restart). */
export interface StoredFileAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Base64-encoded file bytes (no data: URL prefix). */
  data: string;
}

/** Pasted text / terminal blocks for UI preview (not sent as file uploads). */
export interface PasteAttachmentMeta {
  /** Stable id for read_attachment / AttachmentStore. */
  id?: string;
  kind: "text" | "terminal";
  displayName: string;
  /** Model-facing body (full paste / terminal transcript). */
  content: string;
  /** Terminal: UI-faithful text for copy/preview. */
  displayContent?: string;
}

export interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  /**
   * v12 0.4-C2: the session DB row UUID this message maps to, when known
   * (set at persist time for streamed user messages; threaded through
   * hydration). Edits target the DB row DIRECTLY via this id — no ordinal
   * mapping between the ephemeral and persisted stores.
   */
  sessionRowId?: string;
  /** Full model-facing user text (attachment bodies); UI uses `content` when set. */
  modelContent?: string | null;
  /** Ephemeral/chat-only: in-memory chat id (not persisted). */
  chatId?: number;
  approvalState?: "approved" | "rejected" | null;
  commitHash?: string | null;
  dbTimestamp?: string | null;
  createdAt?: Date | string;
  requestId?: string | null;
  totalTokens?: number | null;
  /**
   * The PROVIDER's real total token usage for this assistant turn.
   *
   * The token meter prefers this over its own estimate. It is persisted on the
   * session row and threaded back through hydration, because without it a
   * restart drops the meter to a client-side estimate that counts only the flat
   * persisted messages — no system prompt, no native tool history — and so reads
   * roughly half. Reopening the app looked like the session had been summarised.
   */
  maxTokensUsed?: number | null;
  toolCalls?: Array<{ id: string; name: string; arguments?: string }>;
  sources?: Array<{
    title: string;
    url: string;
    content?: string;
    favicon?: string;
  }>;
  /** v3.9: 0-based exchange index. */
  exchangeIndex?: number | null;
  /** v3.9: Snapshot id before this assistant message (revert target). */
  snapshotId?: number | null;
  /** v3.9: Paths written in this exchange. */
  filesWritten?: string[] | null;
  /** Non-destructive revert: message stays in transcript, styled as reverted. */
  isReverted?: boolean | null;
  /** Compaction: auto-inserted continuation user line. */
  isSynthetic?: boolean | null;
  /** Work mode when this user message was sent. */
  workMode?: "ask" | "plan" | "build" | "debug" | "review" | null;
  /** File attachments for this message (shown as chips in UI). */
  attachments?: AttachmentInfo[] | null;
  /** Persisted file upload payloads for rehydrating AttachmentStore. */
  fileAttachments?: StoredFileAttachment[] | null;
  /** Pasted text / terminal bodies for chip preview after send. */
  pasteAttachments?: PasteAttachmentMeta[] | null;
  /** Frozen tool / sub-agent UI (DisplaySnapshotV1). */
  displaySnapshot?: DisplaySnapshotV1 | null;
  /**
   * Issue 4: assistant turn whose stream was cut off (compass stop, app
   * quit/suspend, crash) before completing. Holds partial content and renders
   * a "Continue" affordance so the user can resume.
   */
  interrupted?: boolean | null;
  /**
   * v14.7: assistant turn PARKED on a wait (a pending approval or an `ask_user`
   * question) — NOT an error. Persisted as `status:"waiting"` so reopen renders
   * the wait/question affordance instead of the "interrupted/Continue" error.
   */
  waiting?: boolean | null;
}

export interface Chat {
  id: number;
  appId?: number | null;
  title: string;
  messages: Message[];
  initialCommitHash?: string | null;
  dbTimestamp?: string | null;
}

export interface App {
  id: number;
  name: string;
  path: string;
  createdAt: Date;
  updatedAt: Date;
  githubOrg: string | null;
  githubRepo: string | null;
  githubBranch: string | null;
  installCommand: string | null;
  startCommand: string | null;
  isFavorite: boolean;
  /** v2.1: true if the workspace folder exists on disk; false if deleted outside app */
  pathExists?: boolean;
  /** Non-fatal file-list issues from fallback discovery (permissions, symlinks). */
  fileDiscoveryWarnings?: string[];
  /** Repo layout hints for discovery UX (multi-repo parent folder, missing root .git). */
  workspaceDiscoveryHints?: WorkspaceDiscoveryHints;
  /** Derived from pathExists: active = folder present, missing = folder absent */
  status?: "active" | "missing";
  lastOpenedAt?: Date | null;
  workspaceKind?: "local" | "remote-ssh";
  remoteConnection?: Record<string, unknown> | null;
}

export interface WorkspaceDiscoveryHints {
  hasRootGit: boolean;
  isMultiRepoWorkspace: boolean;
  nestedRepoNames?: string[];
}

export interface Version {
  oid: string;
  message: string;
  timestamp: number;
}

export type BranchResult = { branch: string };

export interface NodeSystemInfo {
  nodeVersion: string | null;
  pnpmVersion: string | null;
  nodeDownloadUrl: string;
}

export interface SystemDebugInfo {
  nodeVersion: string | null;
  pnpmVersion: string | null;
  nodePath: string | null;
  telemetryId: string;
  telemetryConsent: string;
  telemetryUrl: string;
  atlarixVersion: string;
  platform: string;
  architecture: string;
  logs: string;
  selectedLanguageModel: string;
}

export interface LocalModel {
  provider: "ollama" | "lmstudio";
  modelName: string; // Name used for API calls (e.g., "llama2:latest")
  displayName: string; // User-friendly name (e.g., "Llama 2")
}

export type LocalModelListResponse = {
  models: LocalModel[];
  error?: string; // User-friendly error message (e.g., "LM Studio not running")
};

export interface TokenCountParams {
  chatId: number;
  input: string;
}

export interface TokenCountResult {
  estimatedTotalTokens: number;
  actualMaxTokens: number | null;
  messageHistoryTokens: number;
  codebaseTokens: number;
  mentionedAppsTokens: number;
  inputTokens: number;
  systemPromptTokens: number;
  contextWindow: number;
  /** Effective budget (override or context window) for warnings */
  effectiveBudget?: number;
  providerId?: string;
  budgetSource?: "model" | "override";
}

export interface ChatLogsData {
  debugInfo: SystemDebugInfo;
  chat: Chat;
  codebase: string;
}

export interface LanguageModelProvider {
  id: string;
  name: string;
  hasFreeTier?: boolean;
  websiteUrl?: string;
  gatewayPrefix?: string;
  secondary?: boolean;
  envVarName?: string;
  apiBaseUrl?: string;
  type: "custom" | "local" | "cloud";
}

export type LanguageModel =
  | {
    id: number;
    apiName: string;
    displayName: string;
    description: string;
    tag?: string;
    tagColor?: string;
    maxOutputTokens?: number;
    contextWindow?: number;
    temperature?: number;
    dollarSigns?: number;
    type: "custom";
  }
  | {
    apiName: string;
    displayName: string;
    description: string;
    tag?: string;
    tagColor?: string;
    maxOutputTokens?: number;
    contextWindow?: number;
    temperature?: number;
    dollarSigns?: number;
    /** Real USD price per 1M tokens from the models.dev catalog (when known). */
    cost?: { input: number; output: number };
    supportsToolChoice?: boolean;
    type: "local" | "cloud";
  };

export interface CreateCustomLanguageModelProviderParams {
  id: string;
  name: string;
  apiBaseUrl: string;
  envVarName?: string;
}

export interface CreateCustomLanguageModelParams {
  apiName: string;
  displayName: string;
  providerId: string;
  description?: string;
  maxOutputTokens?: number;
  contextWindow?: number;
}

export interface DoesReleaseNoteExistParams {
  version: string;
}

export interface ApproveProposalResult {
  extraFiles?: string[];
  extraFilesError?: string;
}

export interface ImportAppParams {
  path: string;
  appName: string;
  installCommand?: string;
  startCommand?: string;
}

export interface CopyAppParams {
  appId: number;
  newAppName: string;
  withHistory: boolean;
}

export interface ImportAppResult {
  appId: number;
  chatId: number;
}

export interface RenameBranchParams {
  appId: number;
  oldBranchName: string;
  newBranchName: string;
}

export const UserBudgetInfoSchema = z.object({
  usedCredits: z.number(),
  totalCredits: z.number(),
  budgetResetDate: z.date(),
  redactedUserId: z.string(),
});
export type UserBudgetInfo = z.infer<typeof UserBudgetInfoSchema>;

export interface ComponentSelection {
  id: string;
  name: string;
  runtimeId?: string; // Unique runtime ID for duplicate components
  relativePath: string;
  lineNumber: number;
  columnNumber: number;
}

export interface AppUpgrade {
  id: string;
  title: string;
  description: string;
  manualUpgradeUrl: string;
  isNeeded: boolean;
}

export interface EnvVar {
  key: string;
  value: string;
}

export interface SetAppEnvVarsParams {
  appId: number;
  envVars: EnvVar[];
}

export interface GetAppEnvVarsParams {
  appId: number;
}

export interface UpdateChatParams {
  chatId: number;
  title: string;
}

export interface FileAttachment {
  file?: File;
  type: "upload-to-codebase" | "chat-context";
  /** Stable id so renderer + main share an attachment ID. */
  id?: string;
  /** Long paste lifted from the composer — UI chip only; injected into prompt on send. */
  textPaste?: {
    content: string;
    displayName: string;
  };
  /** Terminal selection copied into chat — UI chip only; injected into prompt on send. */
  terminalPaste?: {
    /** Model-facing transcript (prompt tagged, output raw). */
    content: string;
    /** Terminal-faithful text for copy/preview (no prefix on stdout). */
    displayContent?: string;
    displayName: string;
    instanceLabel: string;
    owner: "user" | "agent";
    lineStart: number;
    lineEnd: number;
  };
  /**
   * `@`-mention of a workspace file/folder picked in the composer — UI chip only.
   * On send, the `@file:`/`@dir:` token is re-emitted into the prompt so the
   * existing scoped, capped extraction (parseContextMentions →
   * extractMentionedContext) runs unchanged. Never base64-encoded.
   */
  mention?: {
    kind: "file" | "dir";
    /** Workspace-relative path (no leading `./`, no spaces). */
    relpath: string;
    displayName: string;
  };
  /**
   * A reference to a running background job sent to chat from the jobs UI — UI
   * chip only (shows `id-<jobId>`). On send, a `<atlarix-background-job>` block
   * with the job id, command, and current output tail is injected so the user
   * can ask the model about it ("this looks stuck — what's wrong?").
   */
  backgroundJob?: {
    jobId: string;
    command: string;
    /** Output tail captured at send time (may be empty). */
    outputTail?: string;
  };
}

export interface RevertVersionParams {
  appId: number;
  previousVersionId: string;
}

export type RevertVersionResponse =
  | { successMessage: string }
  | { warningMessage: string };

// --- Help Bot Types ---
export interface StartHelpChatParams {
  sessionId: string;
  message: string;
}

// --- Workspace session persistence ---
export interface WorkspaceChatSession {
  id: string;
  workspaceId: number;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

// --- MCP Types ---
export interface McpServer {
  id: number;
  name: string;
  transport: string;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  envJson?: Record<string, string> | null;
  url?: string | null;
  apiKey?: string | null;
  enabled: boolean;
  scope?: "global" | "workspace";
  appId?: number | null;
  authType?: "none" | "env" | "api_key" | "oauth";
  oauthConnected?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateMcpServer
  extends Omit<McpServer, "id" | "createdAt" | "updatedAt"> {
  scope?: "global" | "workspace";
  appId?: number | null;
}
export type McpServerUpdate = Partial<McpServer> & Pick<McpServer, "id">;
export type McpToolConsentType = "ask" | "always" | "denied";

export interface McpTool {
  name: string;
  description?: string | null;
  consent: McpToolConsentType;
}

export interface McpListToolsResult {
  tools: McpTool[];
  error?: string;
  needsOAuth?: boolean;
}

export interface McpToolConsent {
  id: number;
  serverId: number;
  toolName: string;
  consent: McpToolConsentType;
  updatedAt: number;
}

// --- Skills Types (community registry installs) ---
export interface SkillManifestFile {
  name: string;
  url: string;
}

export interface SkillManifestEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  compatibleModes: string[];
  files: SkillManifestFile[];
}

export interface SkillRegistryIndex {
  version: string;
  updatedAt?: string;
  skills: SkillManifestEntry[];
}

export interface InstallSkillParams {
  skill: SkillManifestEntry;
  scope: "global" | "workspace";
  workspacePath?: string;
}

export interface UninstallSkillParams {
  skillId: string;
  scope: "global" | "workspace";
  workspacePath?: string;
}

/** Workforce Feature 1: repo-scoped priority skill summary (from `.atlarix/skills/`). */
export interface RepoSkillSummary {
  name: string;
  description: string;
  tags: string[];
  modes: string[];
  priority: boolean;
  version: string;
  filename: string;
}

/** Result of `skills:list-repo-skills`. */
export interface ListRepoSkillsResult {
  skills: RepoSkillSummary[];
  isWorkforce: boolean;
}

export interface InstalledSkillRow {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  tags: string[];
  compatibleModes: string[];
  installedAt: Date | string;
  scope: "global" | "workspace";
  workspacePath: string | null;
  cachedFiles: Array<{ name: string; localPath: string }>;
}

export interface ActiveSkillContent {
  id: string;
  name: string;
  content: string;
}

export interface CloneRepoParams {
  url: string;
  installCommand?: string;
  startCommand?: string;
  appName: string;
  /** Absolute path to the new repo root (e.g. parentDir/workspaceName). */
  targetPath?: string;
}

export interface GithubCloneProgress {
  step: string;
  message: string;
  progress: number;
}

export interface GithubRepository {
  name: string;
  full_name: string;
  private: boolean;
}

export type CloneRepoReturnType =
  | {
    app: App;
    /** Initial chat row created with the cloned workspace */
    chatId?: number;
  }
  | {
    error: string;
  };

export interface SelectNodeFolderResult {
  path: string | null;
  canceled?: boolean;
  selectedPath: string | null;
}

export interface VisualEditingChange {
  componentId: string;
  componentName: string;
  relativePath: string;
  lineNumber: number;
  styles: {
    margin?: { left?: string; right?: string; top?: string; bottom?: string };
    padding?: { left?: string; right?: string; top?: string; bottom?: string };
    dimensions?: { width?: string; height?: string };
    border?: { width?: string; radius?: string; color?: string };
    backgroundColor?: string;
    text?: {
      fontSize?: string;
      fontWeight?: string;
      color?: string;
      fontFamily?: string;
    };
  };
  textContent?: string;
}

export interface ApplyVisualEditingChangesParams {
  appId: number;
  changes: VisualEditingChange[];
}

export interface AnalyseComponentParams {
  appId: number;
  componentId: string;
}

/** Discord invite API (main process) — metadata for Community dialog. */
export type DiscordInviteInfoResult =
  | {
      ok: true;
      name: string;
      description: string | null;
      memberCount?: number;
      presenceCount?: number;
    }
  | { ok: false };
