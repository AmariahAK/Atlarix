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

export interface SecurityFinding {
  title: string;
  level: "critical" | "high" | "medium" | "low";
  description: string;
}

export interface SecurityReviewResult {
  findings: SecurityFinding[];
  timestamp: string;
  /** null for workspace-session reviews (keyed by sessionId, not a numeric chat). */
  chatId: number | null;
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
  /** When true (Auto routing): use thinking tier for this message. */
  forceThinkingTier?: boolean;
  /** Resend/edit: use this work mode for prompt + tool allowlist for this turn only. */
  workModeOverride?: WorkMode;
  /** v12 7A: run this turn as a user-defined agent (.atlarix/agents/<name>.md). */
  agentOverride?: string;
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
  updatedFiles: boolean;
  extraFiles?: string[];
  extraFilesError?: string;
  totalTokens?: number;
  contextWindow?: number;
  /** Reasoning / thinking tokens from the last completed stream step (when reported by the provider). */
  reasoningTokens?: number;
  /** True when the turn had at least one tool execution or permission request; used to play completion sound only when relevant. */
  hadToolCallsOrPermissions?: boolean;
  /** True when the completed turn used the managed Compass provider (for usage refresh). */
  usedCompass?: boolean;
  /** Populated when usedCompass — for analytics (PostHog). */
  compassTokens?: number;
  compassTier?: string;
  /** v10: auxiliary LLM tokens this turn (sub-agents, compaction) — counted toward usage. */
  auxTokens?: number;
  /** v12 7D: estimated BYOK USD cost of this turn (omitted for Core/unknown-price). */
  turnCostUsd?: number;
  /** v12 2.3: the snapshot turn id (= ledger turn id) so a detached background
   * agent can revert this turn's writes via the shadow-git snapshot. */
  snapshotTurnId?: string;
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
}

/**
 * FIX 4: payload for `chat:stream:disconnected`. Emitted after silent
 * reconnect attempts (2s/5s/10s) all fail. The renderer keeps the partial
 * response visible and offers [Reconnect] (replays the same turn) and
 * [Continue] (sends a new prompt asking the model to resume).
 */
/** Result of `compass:get-usage` — use `reason` so UI does not treat RPC/migration failures as “signed out”. */
export type CompassUsageIpcResult =
  | {
      ok: true;
      tokensUsedThisMonth: number;
      monthlyLimit: number;
      tier: string;
    }
  | {
      ok: false;
      reason: "not_authenticated" | "rpc_error" | "network_error";
      message?: string;
    };

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

export interface CreateAppParams {
  name: string;
  /** Optional absolute path to create the app in. Prefer targetPath so the app lives at project root; avoid creating under atlarix-apps for new projects. When set, app.path is stored as this path so file ops and commands use it. */
  targetPath?: string;
}

export interface CreateAppResult {
  app: {
    id: number;
    name: string;
    path: string;
    createdAt: string;
    updatedAt: string;
  };
  chatId: number;
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
  /** When this assistant turn used Auto routing, the resolved tier (ephemeral / UI). */
  autoRoutedTier?: "fast" | "balanced" | "thinking" | null;
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
  supabaseProjectId: string | null;
  supabaseParentProjectId: string | null;
  supabaseProjectName: string | null;
  neonProjectId: string | null;
  neonDevelopmentBranchId: string | null;
  neonPreviewBranchId: string | null;
  vercelProjectId: string | null;
  vercelProjectName: string | null;
  vercelTeamSlug: string | null;
  vercelDeploymentUrl: string | null;
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
  dbTimestamp?: string | null;
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

export interface EditAppFileReturnType {
  warning?: string;
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

export interface ConnectToExistingVercelProjectParams {
  projectId: string;
  appId: number;
}

export interface IsVercelProjectAvailableResponse {
  available: boolean;
  error?: string;
}

export interface CreateVercelProjectParams {
  name: string;
  appId: number;
}

export interface GetVercelDeploymentsParams {
  appId: number;
}

export interface VercelDeployment {
  uid: string;
  url: string;
  state: string;
  createdAt: number;
  target: string;
  readyState: string;
}

export interface DisconnectVercelProjectParams {
  appId: number;
}

export interface IsVercelProjectAvailableParams {
  name: string;
}

export interface SaveVercelAccessTokenParams {
  token: string;
}

export interface VercelProject {
  id: string;
  name: string;
  framework: string | null;
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
}

// --- Neon Types ---
export interface CreateNeonProjectParams {
  name: string;
  appId: number;
}

export interface NeonProject {
  id: string;
  name: string;
  connectionString: string;
  branchId: string;
}

export interface NeonBranch {
  type: "production" | "development" | "snapshot" | "preview";
  branchId: string;
  branchName: string;
  lastUpdated: string; // ISO timestamp
  parentBranchId?: string; // ID of the parent branch
  parentBranchName?: string; // Name of the parent branch
}

export interface GetNeonProjectParams {
  appId: number;
}

export interface GetNeonProjectResponse {
  projectId: string;
  projectName: string;
  orgId: string;
  branches: NeonBranch[];
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

export interface SupabaseBranch {
  id: string;
  name: string;
  isDefault: boolean;
  projectRef: string;
  parentProjectRef: string;
}

export interface SetSupabaseAppProjectParams {
  projectId: string;
  parentProjectId?: string;
  appId: number;
}
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
