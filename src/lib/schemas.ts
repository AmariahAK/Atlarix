import { z } from "zod";

export const SecretSchema = z.object({
  value: z.string(),
  encryptionType: z.enum(["electron-safe-storage", "plaintext"]).optional(),
});
export type Secret = z.infer<typeof SecretSchema>;

/**
 * Zod schema for chat summary objects returned by the get-chats IPC
 */
export const ChatSummarySchema = z.object({
  id: z.number(),
  appId: z.number().nullable(),
  title: z.string().nullable(),
  createdAt: z.date(),
});

/**
 * Type derived from the ChatSummarySchema
 */
export type ChatSummary = z.infer<typeof ChatSummarySchema>;

/**
 * Zod schema for an array of chat summaries
 */
export const ChatSummariesSchema = z.array(ChatSummarySchema);

/**
 * Zod schema for chat search result objects returned by the search-chats IPC
 */
export const ChatSearchResultSchema = z.object({
  id: z.number(),
  appId: z.number().nullable(),
  title: z.string().nullable(),
  createdAt: z.date(),
  matchedMessageContent: z.string().nullable(),
});

/**
 * Type derived from the ChatSearchResultSchema
 */
export type ChatSearchResult = z.infer<typeof ChatSearchResultSchema>;

export const ChatSearchResultsSchema = z.array(ChatSearchResultSchema);

// Zod schema for app search result objects returned by the search-app IPC
export const AppSearchResultSchema = z.object({
  id: z.number(),
  name: z.string(),
  createdAt: z.date(),
  matchedChatTitle: z.string().nullable(),
  matchedChatMessage: z.string().nullable(),
});

// Type derived from AppSearchResultSchema
export type AppSearchResult = z.infer<typeof AppSearchResultSchema>;

export const AppSearchResultsSchema = z.array(AppSearchResultSchema);

const providers = [
  "openai",
  "anthropic",
  "google",
  "vertex",
  "auto",
  "openrouter",
  "ollama",
  "lmstudio",
  "azure",
  "xai",
  "bedrock",
  "groq",
  "together",
  "mistral",
] as const;

export const cloudProviders = providers.filter(
  (provider) => provider !== "ollama" && provider !== "lmstudio",
);

/**
 * Zod schema for large language model configuration
 */
export const LargeLanguageModelSchema = z.object({
  name: z.string(),
  provider: z.string(),
  customModelId: z.number().optional(),
});

/**
 * Type derived from the LargeLanguageModelSchema
 */
export type LargeLanguageModel = z.infer<typeof LargeLanguageModelSchema>;

/**
 * Zod schema for provider settings
 * Regular providers use only apiKey. Vertex has additional optional fields.
 */
export const RegularProviderSettingSchema = z.object({
  apiKey: SecretSchema.optional(),
});

export const AzureProviderSettingSchema = z.object({
  apiKey: SecretSchema.optional(),
  resourceName: z.string().optional(),
});

export const VertexProviderSettingSchema = z.object({
  // We make this undefined so that it makes existing callsites easier.
  apiKey: z.undefined(),
  projectId: z.string().optional(),
  location: z.string().optional(),
  serviceAccountKey: SecretSchema.optional(),
});

export const ProviderSettingSchema = z.union([
  // Must use more specific type first!
  // Zod uses the first type that matches.
  //
  // We use passthrough as a hack because Azure and Vertex
  // will match together since their required fields overlap.
  //
  // In addition, there may be future provider settings that
  // we may want to preserve (e.g. user downgrades to older version)
  // so doing passthrough keeps these extra fields.
  AzureProviderSettingSchema.passthrough(),
  VertexProviderSettingSchema.passthrough(),
  RegularProviderSettingSchema.passthrough(),
]);

/**
 * Type derived from the ProviderSettingSchema
 */
export type ProviderSetting = z.infer<typeof ProviderSettingSchema>;
export type RegularProviderSetting = z.infer<
  typeof RegularProviderSettingSchema
>;
export type AzureProviderSetting = z.infer<typeof AzureProviderSettingSchema>;
export type VertexProviderSetting = z.infer<typeof VertexProviderSettingSchema>;

export const RuntimeModeSchema = z.enum(["web-sandbox", "local-node", "unset"]);
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

export const RuntimeMode2Schema = z.enum(["host", "docker"]);
export type RuntimeMode2 = z.infer<typeof RuntimeMode2Schema>;

export const ChatModeSchema = z.enum(["build", "ask", "agent"]);
export type ChatMode = z.infer<typeof ChatModeSchema>;

/** v2.1: Agent mode (Direct / Guided / Autonomous). */
export const AgentModeSchema = z.enum(["direct", "guided", "autonomous"]);
export type AgentMode = z.infer<typeof AgentModeSchema>;

/** v2.1: Permission mode (read-only Ask vs allow edits Build). */
export const PermissionModeSchema = z.enum(["ask", "build"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/** v2.1: Guided mode config. */
export const GuidedConfigSchema = z.object({
  maxDelegationsPerTurn: z.number().min(1).max(10).default(3),
  agentModel: z.enum(["same", "fast", "custom"]).default("fast"),
  customAgentModel: LargeLanguageModelSchema.optional(),
});
export type GuidedConfig = z.infer<typeof GuidedConfigSchema>;

/** v2.1: Autonomous mode config (opt-in, higher token usage). */
export const AutonomousConfigSchema = z.object({
  maxDelegationDepth: z.number().min(1).max(5).default(2),
  maxDelegationsPerTurn: z.number().min(1).max(10).default(3),
  tokenBudgetPerTurn: z.number().default(50_000),
  requireApprovalForNested: z.boolean().default(true),
});
export type AutonomousConfig = z.infer<typeof AutonomousConfigSchema>;

/** v2.1: Self-review config. */
export const SelfReviewConfigSchema = z.object({
  enabled: z.boolean().default(false),
  strategy: z.enum(["runtime", "agentLightning", "both"]).default("both"),
  maxIterations: z.number().min(1).max(3).default(2),
  qualityThreshold: z.number().min(0.7).max(0.95).default(0.85),
  reviewModel: z.enum(["same", "fast", "custom"]).default("fast"),
  customReviewModel: LargeLanguageModelSchema.optional(),
  criteria: z.array(z.string()).default(["completeness", "correctness", "clarity", "safety", "best_practices"]),
  showInActivityStream: z.boolean().default(true),
});
export type SelfReviewConfig = z.infer<typeof SelfReviewConfigSchema>;

/** v2.1: Agent Lightning (offline training) config. */
export const AgentLightningConfigSchema = z.object({
  collectData: z.boolean().default(false),
  schedule: z.enum(["every_10_sessions", "daily", "weekly", "manual"]).default("weekly"),
  optimizationTarget: z.enum(["quality", "token_efficiency", "speed", "balanced"]).default("balanced"),
});
export type AgentLightningConfig = z.infer<typeof AgentLightningConfigSchema>;

/** v2.1: Context and summarization config. */
export const ContextSummarizationConfigSchema = z.object({
  summarizationModel: z.enum(["fast", "same", "custom"]).default("fast"),
  customSummarizationModel: LargeLanguageModelSchema.optional(),
  compactionThreshold: z.number().min(0.6).max(0.9).default(0.75),
  adaptiveThreshold: z.boolean().default(true),
  summarizationStrategy: z.enum(["preserve_details", "balanced", "aggressive"]).default("balanced"),
  adaptivePromptSizing: z.boolean().default(true),
});
export type ContextSummarizationConfig = z.infer<typeof ContextSummarizationConfigSchema>;

/** v2.1: Project understanding (ATLARIX.md) config. */
export const ProjectUnderstandingConfigSchema = z.object({
  autoUpdateAtlarixMd: z.boolean().default(false),
  updateTriggers: z.object({
    afterArchitectureDecisions: z.boolean().default(true),
    afterSummarization: z.boolean().default(true),
    afterEverySession: z.boolean().default(false),
  }).default({}),
  updateModel: z.enum(["fast", "same", "custom"]).default("fast"),
  requireApprovalForUpdates: z.enum(["always", "auto_approve_minor", "never"]).default("always"),
});
export type ProjectUnderstandingConfig = z.infer<typeof ProjectUnderstandingConfigSchema>;

/** v2.1: Activity stream config. */
export const ActivityStreamConfigSchema = z.object({
  position: z.enum(["right_panel", "overlay", "bottom_bar"]).default("right_panel"),
  autoCollapseAfterMs: z.union([z.literal(3000), z.literal(10000), z.literal(0)]).default(10000),
  showTokenCosts: z.enum(["always", "autonomous_only", "never"]).default("always"),
  detailLevel: z.enum(["minimal", "standard", "verbose"]).default("standard"),
});
export type ActivityStreamConfig = z.infer<typeof ActivityStreamConfigSchema>;

/** v2.1: AI Configuration (agents, self-review, context, project understanding). */
export const AIConfigurationSchema = z.object({
  guided: GuidedConfigSchema.optional(),
  autonomous: AutonomousConfigSchema.optional(),
  selfReview: SelfReviewConfigSchema.optional(),
  agentLightning: AgentLightningConfigSchema.optional(),
  contextSummarization: ContextSummarizationConfigSchema.optional(),
  projectUnderstanding: ProjectUnderstandingConfigSchema.optional(),
  activityStream: ActivityStreamConfigSchema.optional(),
});
export type AIConfiguration = z.infer<typeof AIConfigurationSchema>;

export const GitHubSecretsSchema = z.object({
  accessToken: SecretSchema.nullable(),
});
export type GitHubSecrets = z.infer<typeof GitHubSecretsSchema>;

export const GithubUserSchema = z.object({
  email: z.string(),
});
export type GithubUser = z.infer<typeof GithubUserSchema>;

export const SupabaseSchema = z.object({
  accessToken: SecretSchema.optional(),
  refreshToken: SecretSchema.optional(),
  expiresIn: z.number().optional(),
  tokenTimestamp: z.number().optional(),
});
export type Supabase = z.infer<typeof SupabaseSchema>;

export const NeonSchema = z.object({
  accessToken: SecretSchema.optional(),
  refreshToken: SecretSchema.optional(),
  expiresIn: z.number().optional(),
  tokenTimestamp: z.number().optional(),
});
export type Neon = z.infer<typeof NeonSchema>;

export const ExperimentsSchema = z.object({
  // Deprecated
  enableSupabaseIntegration: z.boolean().describe("DEPRECATED").optional(),
  enableFileEditing: z.boolean().describe("DEPRECATED").optional(),
});
export type Experiments = z.infer<typeof ExperimentsSchema>;

export const AtlarixProBudgetSchema = z.object({
  budgetResetAt: z.string(),
  maxBudget: z.number(),
});
export type AtlarixProBudget = z.infer<typeof AtlarixProBudgetSchema>;

export const GlobPathSchema = z.object({
  globPath: z.string(),
});

export type GlobPath = z.infer<typeof GlobPathSchema>;

export const AppChatContextSchema = z.object({
  contextPaths: z.array(GlobPathSchema),
  smartContextAutoIncludes: z.array(GlobPathSchema),
  excludePaths: z.array(GlobPathSchema).optional(),
});
export type AppChatContext = z.infer<typeof AppChatContextSchema>;

export type ContextPathResult = GlobPath & {
  files: number;
  tokens: number;
};

export type ContextPathResults = {
  contextPaths: ContextPathResult[];
  smartContextAutoIncludes: ContextPathResult[];
  excludePaths: ContextPathResult[];
};

export const ReleaseChannelSchema = z.enum(["stable", "beta"]);
export type ReleaseChannel = z.infer<typeof ReleaseChannelSchema>;

export const ZoomLevelSchema = z.enum(["90", "100", "110", "125", "150"]);
export type ZoomLevel = z.infer<typeof ZoomLevelSchema>;

export const SmartContextModeSchema = z.enum([
  "balanced",
  "conservative",
  "deep",
]);
export type SmartContextMode = z.infer<typeof SmartContextModeSchema>;
/**
 * Zod schema for user settings
 */
export const UserSettingsSchema = z.object({
  selectedModel: LargeLanguageModelSchema,
  providerSettings: z.record(z.string(), ProviderSettingSchema),
  githubUser: GithubUserSchema.optional(),
  githubAccessToken: SecretSchema.optional(),
  vercelAccessToken: SecretSchema.optional(),
  supabase: SupabaseSchema.optional(),
  neon: NeonSchema.optional(),
  autoApproveChanges: z.boolean().optional(),
  telemetryConsent: z.enum(["opted_in", "opted_out", "unset"]).optional(),
  telemetryUserId: z.string().optional(),
  hasRunBefore: z.boolean().optional(),
  enableAtlarixPro: z.boolean().optional(),
  experiments: ExperimentsSchema.optional(),
  lastShownReleaseNotesVersion: z.string().optional(),
  maxChatTurnsInContext: z.number().optional(),
  /** Phase 6: When true, use context bar + auto-summarize instead of fixed turn truncation */
  enableContextAutoSummarize: z.boolean().optional(),
  thinkingBudget: z.enum(["low", "medium", "high"]).optional(),
  enableProLazyEditsMode: z.boolean().optional(),
  proLazyEditsMode: z.enum(["off", "v1", "v2"]).optional(),
  enableProSmartFilesContextMode: z.boolean().optional(),
  enableProWebSearch: z.boolean().optional(),
  proSmartContextOption: SmartContextModeSchema.optional(),
  selectedTemplateId: z.string(),
  enableSupabaseWriteSqlMigration: z.boolean().optional(),
  selectedChatMode: ChatModeSchema.optional(),
  /** v2.1: Agent mode (Direct / Guided / Autonomous). Default guided. */
  agentMode: AgentModeSchema.optional(),
  /** v2.1: When true, hide model picker and route to Fast/Medium/Thinking by complexity. */
  autoModelRouting: z.boolean().optional(),
  /** v2.1: When Auto is ON, single provider for Fast/Medium/Thinking (must have API key). */
  autoProviderId: z.string().nullable().optional(),
  /** v2.1: When Auto is ON, [Fast, Medium, Thinking] model names for autoProviderId. */
  autoModelIds: z.tuple([z.string(), z.string(), z.string()]).optional(),
  /** Intent: ask (read-only) | build (full access) | auto (model may switch). */
  intentMode: z.enum(["ask", "build", "auto"]).optional(),
  /** v2.1: AI Configuration (agents, self-review, context, project understanding). */
  aiConfiguration: AIConfigurationSchema.optional(),
  acceptedCommunityCode: z.boolean().optional(),
  zoomLevel: ZoomLevelSchema.optional(),

  /** Optional per-provider token budget cap (e.g. { openai: 32000 }) to control costs */
  tokenBudgetOverrides: z.record(z.string(), z.number()).optional(),

  /** When true, selecting a container opens Edit Internals (beacon view) directly instead of Summary Card. */
  blueprintAlwaysShowBeacons: z.boolean().optional(),

  enableAutoFixProblems: z.boolean().optional(),
  enableNativeGit: z.boolean().optional(),
  enableAutoUpdate: z.boolean(),
  releaseChannel: ReleaseChannelSchema,
  runtimeMode2: RuntimeMode2Schema.optional(),
  customNodePath: z.string().optional().nullable(),
  isRunning: z.boolean().optional(),
  lastKnownPerformance: z
    .object({
      timestamp: z.number(),
      memoryUsageMB: z.number(),
      cpuUsagePercent: z.number().optional(),
      systemMemoryUsageMB: z.number().optional(),
      systemMemoryTotalMB: z.number().optional(),
      systemCpuPercent: z.number().optional(),
    })
    .optional(),

  ////////////////////////////////
  // E2E TESTING ONLY.
  ////////////////////////////////
  isTestMode: z.boolean().optional(),

  ////////////////////////////////
  // DEPRECATED.
  ////////////////////////////////
  enableProSaverMode: z.boolean().optional(),
  dyadProBudget: AtlarixProBudgetSchema.optional(),
  runtimeMode: RuntimeModeSchema.optional(),
});

/**
 * Type derived from the UserSettingsSchema
 */
export type UserSettings = z.infer<typeof UserSettingsSchema>;

export function isAtlarixProEnabled(settings: UserSettings): boolean {
  return settings.enableAtlarixPro === true && hasAtlarixProKey(settings);
}

export function hasAtlarixProKey(settings: UserSettings): boolean {
  return !!settings.providerSettings?.auto?.apiKey?.value;
}

export function isTurboEditsV2Enabled(settings: UserSettings): boolean {
  return Boolean(
    isAtlarixProEnabled(settings) &&
    settings.enableProLazyEditsMode === true &&
    settings.proLazyEditsMode === "v2",
  );
}

// Define interfaces for the props
export interface SecurityRisk {
  type: "warning" | "danger";
  title: string;
  description: string;
}

export interface FileChange {
  name: string;
  path: string;
  summary: string;
  type: "write" | "rename" | "delete";
  isServerFunction: boolean;
}

export interface CodeProposal {
  type: "code-proposal";
  title: string;
  securityRisks: SecurityRisk[];
  filesChanged: FileChange[];
  packagesAdded: string[];
  sqlQueries: SqlQuery[];
}

export type SuggestedAction =
  | RestartAppAction
  | SummarizeInNewChatAction
  | RefactorFileAction
  | WriteCodeProperlyAction
  | RebuildAction
  | RestartAction
  | RefreshAction
  | KeepGoingAction;

export interface RestartAppAction {
  id: "restart-app";
}

export interface SummarizeInNewChatAction {
  id: "summarize-in-new-chat";
}

export interface WriteCodeProperlyAction {
  id: "write-code-properly";
}

export interface RefactorFileAction {
  id: "refactor-file";
  path: string;
}

export interface RebuildAction {
  id: "rebuild";
}

export interface RestartAction {
  id: "restart";
}

export interface RefreshAction {
  id: "refresh";
}

export interface KeepGoingAction {
  id: "keep-going";
}

export interface ActionProposal {
  type: "action-proposal";
  actions: SuggestedAction[];
}

export interface TipProposal {
  type: "tip-proposal";
  title: string;
  description: string;
}

export type Proposal = CodeProposal | ActionProposal | TipProposal;

export interface ProposalResult {
  proposal: Proposal;
  chatId: number;
  messageId: number;
}

export interface SqlQuery {
  content: string;
  description?: string;
}
