import { z } from "zod";
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
  chatId: number;
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
  prompt: string;
  redo?: boolean;
  attachments?: Array<{
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
  /** v5.0: Explicit Blueprint system-prompt tier (Diagram tab). When omitted, derived from chat mode + prompt heuristics. */
  blueprintInjectionMode?: "ask" | "plan" | "build" | "debug";
  /** v5.0: Optional debug context when tier resolves to Debug (IPC override; else settings). */
  blueprintDebugTrace?: string;
  blueprintDebugFile?: string;
}

/** v3.9: Clarifying question from AI (<questions> block). */
export interface Question {
  id: string;
  question: string;
  choices: string[];
  allowCustom: boolean;
}

export interface ChatResponseEnd {
  chatId: number;
  updatedFiles: boolean;
  extraFiles?: string[];
  extraFilesError?: string;
  totalTokens?: number;
  contextWindow?: number;
  /** True when the turn had at least one tool execution or permission request; used to play completion sound only when relevant. */
  hadToolCallsOrPermissions?: boolean;
  /** True when the completed turn used the managed Compass provider (for usage refresh). */
  usedCompass?: boolean;
  /** Populated when usedCompass — for analytics (PostHog). */
  compassTokens?: number;
  compassTier?: string;
}

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

export interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
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
  files: string[];
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
}

export interface Version {
  oid: string;
  message: string;
  timestamp: number;
  dbTimestamp?: string | null;
}

export type BranchResult = { branch: string };

export interface SandboxConfig {
  files: Record<string, string>;
  dependencies: Record<string, string>;
  entry: string;
}

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
  dyadVersion: string;
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

export interface UploadFileToCodebaseParams {
  appId: number;
  filePath: string;
  fileData: string; // Base64 encoded file data
  fileName: string;
}

export interface UploadFileToCodebaseResult {
  success: boolean;
  filePath: string;
}

// --- Prompts ---
export interface PromptDto {
  id: number;
  title: string;
  description: string | null;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePromptParamsDto {
  title: string;
  description?: string;
  content: string;
}

export interface UpdatePromptParamsDto extends CreatePromptParamsDto {
  id: number;
}

export interface FileAttachment {
  file: File;
  type: "upload-to-codebase" | "chat-context";
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

export interface HelpChatResponseChunk {
  sessionId: string;
  delta: string;
  type: "text";
}

export interface HelpChatResponseReasoning {
  sessionId: string;
  delta: string;
  type: "reasoning";
}

export interface HelpChatResponseEnd {
  sessionId: string;
}

export interface HelpChatResponseError {
  sessionId: string;
  error: string;
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
  enabled: boolean;
  scope?: "global" | "workspace";
  appId?: number | null;
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

export interface McpToolConsent {
  id: number;
  serverId: number;
  toolName: string;
  consent: McpToolConsentType;
  updatedAt: number;
}
export interface CloneRepoParams {
  url: string;
  installCommand?: string;
  startCommand?: string;
  appName: string;
}

export interface GithubRepository {
  name: string;
  full_name: string;
  private: boolean;
}

export type CloneRepoReturnType =
  | {
    app: App;
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
export interface SetNodePathParams {
  nodePath: string;
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
