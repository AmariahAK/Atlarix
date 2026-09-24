import { z } from "zod";
import { SUPPORTED_LOCALES } from "@/lib/i18n/locales";

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

/**
 * The closed 21-entry provider tuple that used to live here is GONE (v14.23.0).
 *
 * It was a second, staler registry: providers are enumerated at runtime by
 * `getLanguageModelProviders()` (the models.dev catalog + the presentation overlay),
 * so a hardcoded list could only ever disagree with it. Its one consumer — the
 * "is any provider configured?" check in `useLanguageModelProviders` — now filters
 * the live list, which also fixes the case where a user's only key belonged to a
 * catalog-only provider and the app claimed nothing was configured.
 *
 * `LargeLanguageModelSchema.provider` was already `z.string()`, so nothing typed
 * against the tuple.
 */

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
  apiKey: SecretSchema.optional(),
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
export type AzureProviderSetting = z.infer<typeof AzureProviderSettingSchema>;
export type VertexProviderSetting = z.infer<typeof VertexProviderSettingSchema>;

export const RuntimeModeSchema = z.enum(["web-sandbox", "local-node", "unset"]);

// v12 0.1: "agent" remains ONLY so legacy persisted settings parse — the agent
// chat-mode path was deleted and readSettings coerces "agent" → "build"
// (custom-command modeOverrides coerce too). Do not dispatch on "agent".
export const ChatModeSchema = z.enum(["build", "ask", "agent"]);

/** v5.1: Fine-grained work mode (tools + Blueprint tier alignment). */
export const WorkModeSchema = z.enum([
  "ask",
  "plan",
  "build",
  "debug",
  "review",
]);
export type WorkMode = z.infer<typeof WorkModeSchema>;

/** v2.1: Agent mode (Direct / Guided / Autonomous). */
export const AgentModeSchema = z.enum(["direct", "guided", "autonomous"]);

/** v2.1: Guided mode config. */
export const GuidedConfigSchema = z.object({
  maxDelegationsPerTurn: z.number().min(1).max(10).default(3),
  agentModel: z.enum(["same", "custom"]).default("same"),
  customAgentModel: LargeLanguageModelSchema.optional(),
});

/** @deprecated Migrated to DelegationConfigSchema; kept for settings JSON compatibility. */
export const AutonomousConfigSchema = z.object({
  maxDelegationDepth: z.number().min(1).max(5).default(2),
  maxDelegationsPerTurn: z.number().min(1).max(10).default(3),
  tokenBudgetPerTurn: z.number().default(50_000),
  requireApprovalForNested: z.boolean().default(true),
});

/**
 * Unified delegation limits (all work modes).
 *
 * ONLY `tokenBudgetPerTurn` IS READ — `ChatInputControls.tsx` is its single consumer.
 * The other three parse and are then ignored: the real per-turn and concurrency cap is
 * `MAX_SUBAGENTS_PER_TURN` (`lib/agents/agent-runtime.ts`), and there is no UI writing
 * any of them.
 *
 * Said out loud because a fourth field here, `maxConcurrentDelegations`, WAS read —
 * `register-delegation-tools` took it off the stream context — while neither
 * build-branch nor ask-branch ever passed it, so the setting appeared wired and did
 * nothing. It was deleted in v14.44. Do not attach behaviour to a field below without
 * first following it to a caller that actually supplies it.
 */
export const DelegationConfigSchema = z.object({
  maxDelegationDepth: z.number().min(1).max(5).default(2),
  maxDelegationsPerTurn: z.number().min(1).max(10).default(3),
  tokenBudgetPerTurn: z.number().optional(),
  enableParallelPrefetch: z.boolean().optional(),
});

/** v2.1: Self-review config. */
export const SelfReviewConfigSchema = z.object({
  enabled: z.boolean().default(false),
  strategy: z.enum(["runtime", "agentLightning", "both"]).default("both"),
  maxIterations: z.number().min(1).max(3).default(2),
  qualityThreshold: z.number().min(0.7).max(0.95).default(0.85),
  reviewModel: z.enum(["same", "custom"]).default("same"),
  customReviewModel: LargeLanguageModelSchema.optional(),
  criteria: z
    .array(z.string())
    .default([
      "completeness",
      "correctness",
      "clarity",
      "safety",
      "best_practices",
    ]),
  showInActivityStream: z.boolean().default(true),
});

/** v2.1: Context and summarization config. */
export const ContextSummarizationConfigSchema = z.object({
  summarizationModel: z.enum(["same", "custom"]).default("same"),
  customSummarizationModel: LargeLanguageModelSchema.optional(),
  compactionThreshold: z.number().min(0.6).max(0.9).default(0.75),
  adaptiveThreshold: z.boolean().default(true),
  summarizationStrategy: z
    .enum(["preserve_details", "balanced", "aggressive"])
    .default("balanced"),
  adaptivePromptSizing: z.boolean().default(true),
});

/** v2.1: Activity stream config. */
export const ActivityStreamConfigSchema = z.object({
  position: z
    .enum(["right_panel", "overlay", "bottom_bar"])
    .default("right_panel"),
  autoCollapseAfterMs: z
    .union([z.literal(3000), z.literal(10000), z.literal(0)])
    .default(10000),
  showTokenCosts: z
    .enum(["always", "autonomous_only", "never"])
    .default("always"),
});

/**
 * v2.1: AI Configuration (agents, self-review, context).
 * v12 2.6 wire-or-remove: `agentLightning` (12-LOC trace stub, never UI-wired),
 * `projectUnderstanding` (zero logic reads), and `activityStream.detailLevel`
 * (unused) were DELETED — lying knobs. Persisted rows carrying them still
 * parse (plain z.object strips unknown keys). `autonomous` stays for settings
 * JSON compatibility only (see its @deprecated note); delegation/selfReview/
 * contextSummarization are enforced.
 */
export const AIConfigurationSchema = z.object({
  delegation: DelegationConfigSchema.optional(),
  guided: GuidedConfigSchema.optional(),
  autonomous: AutonomousConfigSchema.optional(),
  selfReview: SelfReviewConfigSchema.optional(),
  contextSummarization: ContextSummarizationConfigSchema.optional(),
  activityStream: ActivityStreamConfigSchema.optional(),
});

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

export const ZoomLevelSchema = z.enum(["90", "100", "110", "125", "150"]);
export type ZoomLevel = z.infer<typeof ZoomLevelSchema>;

/** v3.6: Stored DB connection config (persisted in settings). Password stored in config. */
export const DBConnectionConfigStoredSchema = z.object({
  host: z.string().optional(),
  port: z.number().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  database: z.string().optional(),
  ssl: z.boolean().optional(),
  filename: z.string().optional(),
  connectionString: z.string().optional(),
});
export const DBConnectionStoredSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["postgresql", "sqlite", "mysql"]),
  config: DBConnectionConfigStoredSchema,
  isProd: z.boolean().optional(),
  scope: z.enum(["global", "workspace"]).optional(),
  workspaceId: z.number().nullable().optional(),
});

/**
 * Zod schema for user settings
 */
export const UserSettingsSchema = z.object({
  selectedModel: LargeLanguageModelSchema,
  providerSettings: z.record(z.string(), ProviderSettingSchema),
  /**
   * REMOVED: `githubUser` and `githubAccessToken`.
   *
   * `githubAccessToken` was written only by the GitHub device flow, which
   * existed only for the clone dialog — a GitHub-shaped path that could never
   * reach GitLab, Bitbucket or plain SSH. `githubUser` was already dead: its
   * only writer set it to `undefined` and nothing read it.
   *
   * `SecretSchema` stays — provider API keys and the Vertex service-account key
   * share it, and `main/settings.ts` still encrypts/decrypts those.
   *
   * Signing in with GitHub is unaffected; that is a Supabase credential.
   */
  telemetryConsent: z.enum(["opted_in", "opted_out", "unset"]).optional(),
  telemetryUserId: z.string().optional(),
  /**
   * When the user accepted Atlarix Auto's terms (ISO time), or absent.
   *
   * Auto is served from OpenAI's complimentary tokens, which exist only for
   * traffic shared with OpenAI to improve its models — so a user must say yes
   * to that ONCE, knowingly, before their first Auto turn. Checked in MAIN at
   * dispatch (get_model_client), not only in the picker: a saved selection or a
   * synced setting must never send a prompt the user did not agree to share.
   */
  atlarixAutoConsentAt: z.string().optional(),
  hasRunBefore: z.boolean().optional(),
  // Activation-funnel markers (analytics): epoch ms of the first agent turn
  // started / completed, so first_task_* events each fire exactly once.
  firstTaskStartedAt: z.number().optional(),
  firstTaskCompletedAt: z.number().optional(),
  /** Supabase user ids this install has already sent a PostHog `alias` for.
   * The merge is permanent on PostHog's side, so re-sending is noise; a list
   * (not a boolean) because two accounts can share one machine. */
  analyticsAliasedUserIds: z.array(z.string()).optional(),
  /** Local YYYY-MM-DD of the last `active_day` event, so it fires at most once
   * per calendar day. Retention was previously only inferable from incidental
   * event presence, which made it move when instrumentation changed rather than
   * when behaviour did. */
  lastActiveDay: z.string().optional(),
  /** How many distinct calendar days this install has been active. `lastActiveDay`
   * alone can't answer "is this their Nth day", which the PeerPush prompt needs. */
  activeDayCount: z.number().optional(),
  /** Local providers already counted into the activation funnel. They need no
   * API key, so they never hit the key handler that fires `model_connected`. */
  analyticsLocalProvidersSeen: z.array(z.string()).optional(),
  /**
   * Answer to "where did you hear about Atlarix?" — the one attribution question
   * analytics structurally cannot answer, because the referrer chain dies at the
   * installer download. Scoped to `userId` (like `lastKnownEntitlement`) so a
   * second account on the same machine is still asked, and stored locally only
   * as the "don't ask again" gate — the durable record is a PostHog person
   * property set with `$set_once`.
   */
  acquisitionSource: z
    .object({
      userId: z.string(),
      /** One of ACQUISITION_SOURCES, or "other". */
      source: z.string(),
      /** Free text, only when source === "other". */
      detail: z.string().optional(),
      answeredAt: z.number(),
    })
    .optional(),
  /**
   * PeerPush review prompt. `asked` and `clickedThrough` are deliberately
   * SEPARATE: we can see that someone opened the review page, never that they
   * actually reviewed. Conflating them would overstate the conversion.
   */
  peerPushPrompt: z
    .object({
      askedAt: z.number().optional(),
      clickedThroughAt: z.number().optional(),
      dismissedAt: z.number().optional(),
    })
    .optional(),
  /**
   * Last plan the SERVER confirmed, so an offline user isn't silently downgraded.
   *
   * `getUserPlan` returns `'free'` on any error and the in-memory tier cache dies
   * with the process, so before this a Pro user who opened the app without a
   * network lost Pro for the session. Read ONLY when the server is unreachable —
   * a reachable server always wins. Honoured until `subscriptionEndsAt` passes;
   * scoped to `userId` so a different account on the same machine can't inherit
   * it. Cleared on sign-out.
   */
  lastKnownEntitlement: z
    .object({
      userId: z.string(),
      plan: z.enum(["free", "pro"]),
      effectiveTier: z.enum(["free", "pro"]),
      /** ISO date. Absent = not honourable (never grant an unbounded entitlement). */
      subscriptionEndsAt: z.string().nullable().optional(),
      cachedAt: z.number(),
    })
    .optional(),
  lastShownReleaseNotesVersion: z.string().optional(),
  // `maxChatTurnsInContext` + `enableContextAutoSummarize` REMOVED (v14.18.0).
  // They configured a fixed 11-turn history cap that deleted older messages
  // outright — no summary, no marker, and no signal to the model, which then
  // confabulated over the gap. It ran regardless of the setting that claimed to
  // gate it, and turning that setting off ALSO disabled compaction, so the only
  // way to "opt out" was to get blunt deletion with no summarization at all.
  // Context is now bounded solely by the token budget + compaction, which is
  // always on. Both keys are simply stripped from an existing settings.json
  // (this schema is non-strict), so no migration is needed.
  /**
   * Voice dictation: which BYOK provider transcribes, by provider id.
   *
   * Unset means "no preference" — the composer takes the first provider the user
   * has a speech-capable key for, or, failing that, sends the clip to the
   * selected chat model when it accepts audio.
   *
   * `"local"` used to be the value AND the default, naming a free on-device
   * Whisper engine. That engine is deleted (it materialised ~285 MB in the
   * renderer on composer mount and exhausted an 8 GB machine's memory), so a
   * persisted `"local"` names nothing. It is READ AS UNSET rather than migrated
   * away: this schema is non-strict, every reader already has to handle a
   * provider id it does not recognise — a key can be removed at any time — and a
   * settings migration for a value with a correct interpretation is machinery
   * for nothing.
   *
   * Free-form rather than an enum: the handler resolves the endpoint and STT
   * model from the live catalog, so a new provider needs no schema change.
   */
  voiceTranscriptionProvider: z.string().optional(),
  // `voiceInputMode` REMOVED. Its "live" value streamed a re-transcription of a
  // growing buffer every 1.5s, which was only viable against the local WebGPU
  // pipeline; against a metered API it would bill every 1.5s for the same audio.
  // Simply stripped from an existing settings.json (this schema is non-strict).
  /** Spoken language as an ISO-639-1 code ("en", "sw", …), or "auto" to let the
   * engine detect it per clip. Unset = derive from the OS locale.
   *
   * Detection is the accuracy problem this exists to avoid: it re-runs on every
   * clip, it is unreliable on short dictation, and a wrong guess mis-transcribes
   * the whole utterance. Free-form rather than an enum so a new language never
   * needs a schema change (same reasoning as `voiceTranscriptionProvider`). */
  voiceLanguage: z.string().optional(),
  /**
   * UI language AND the language the assistant replies in.
   *
   * An ENUM, unlike `voiceLanguage` directly above, and the divergence is
   * deliberate: that one is free-form because any ISO-639-1 code is meaningful to
   * a speech model, so a new language needs no schema change. A value HERE
   * selects a bundled catalog, so an unrecognised tag renders a blank UI rather
   * than a degraded one.
   *
   * Unset means "derive from the OS locale", resolved at READ time rather than
   * defaulted at first launch — so a user who changes their system language sees
   * Atlarix follow, instead of being frozen to whatever it was when they
   * installed. That is why there is no entry in DEFAULT_SETTINGS.
   */
  appLanguage: z.enum(SUPPORTED_LOCALES).optional(),
  /**
   * The Core model this user was last known to be running on.
   *
   * A RESOLVED MODEL ID, not a tier: which model sits behind a slot changes without
   * an app update, and this exists to notice exactly that. Comparing tiers would see
   * nothing when `core-3` was reassigned; comparing the resolved id also catches a
   * substituted slot and a moved new-install default, because it is what the turn
   * really ran on.
   *
   * NO ENTRY IN DEFAULT_SETTINGS, for the reason `appLanguage` above records: absent
   * has to mean "no baseline yet, say nothing", and a default would make every fresh
   * install announce a change it never experienced. Advancing it IS the dismissal, so
   * there is no second store to drift against.
   */
  lastSeenCoreModel: z.string().optional(),
  /** @deprecated superseded by the binary `deepThinking` toggle (v14.8.5). */
  thinkingBudget: z.enum(["low", "medium", "high"]).optional(),
  /**
   * Reasoning is a flat `medium` baseline for every model/provider/mode. This
   * single toggle raises it to the model's max reasoning ("high") on demand.
   */
  deepThinking: z.boolean().optional(),
  enableSupabaseWriteSqlMigration: z.boolean().optional(),
  selectedChatMode: ChatModeSchema.optional(),
  /** @deprecated Ignored — unified runtime always enables delegation. */
  agentMode: AgentModeSchema.optional(),
  /** Intent: ask (read-only) | build (full access) | auto (model may switch). */
  intentMode: z.enum(["ask", "build", "auto"]).optional(),
  /** v5.1: Work mode for Blueprint tier + UX; maps to ask/build tools (see work-mode.ts). */
  workModePreference: WorkModeSchema.optional(),
  /** v12 7A: active user-defined agent (.atlarix/agents/<name>.md); empty = none. */
  selectedAgent: z.string().optional(),
  /** v2.1: AI Configuration (agents, self-review, context, project understanding). */
  aiConfiguration: AIConfigurationSchema.optional(),
  acceptedCommunityCode: z.boolean().optional(),
  zoomLevel: ZoomLevelSchema.optional(),

  /** Optional per-provider token budget cap (e.g. { openai: 32000 }) to control costs */
  tokenBudgetOverrides: z.record(z.string(), z.number()).optional(),

  /** After autonomous task_complete: parallel reviewer + debugger on files written. */
  buildVerification: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),

  /** F1: play a sound (+ OS notification when unfocused) when a turn waits on the user (approval / ask_user). */
  notificationSound: z
    .object({
      enabled: z.boolean().optional(),
      /** 0..1 playback volume. */
      volume: z.number().min(0).max(1).optional(),
    })
    .optional(),

  /** When true (default), commits made via Atlarix include Co-authored-by: atlarix-agent <agent@atlarix.dev> */
  includeAtlarixCoAuthor: z.boolean().optional(),

  /** v10: first-run setup wizard (providers → model → workspace) completed or skipped. */
  firstRunWizardCompleted: z.boolean().optional(),

  /** v10: interactive PTY terminal for user shell tabs (default true). Kill-switch per platform. */
  enablePtyTerminal: z.boolean().optional(),
  /**
   * Keep the machine awake (prevent idle/display sleep) while an agent run is in
   * flight, so away-from-keyboard tasks keep progressing. Default true. Cannot
   * override OS lid-close suspend (see power-blocker.ts).
   */
  keepAwakeDuringRuns: z.boolean().optional(),
  /** Linux: wrap stdio MCP servers in firejail when available. Default false. */
  sandboxMcpStdio: z.boolean().optional(),
  mcpStdioFirejail: z
    .object({
      allowNetwork: z.boolean().optional(),
      customBinaryPath: z.string().optional(),
    })
    .optional(),
  /**
   * Confine agent `run_command` file writes to the workspace + caches via the
   * per-OS sandbox (macOS Seatbelt / Linux bubblewrap / Windows AppContainer).
   * Network stays on. Default ON where a sandbox is available; falls back to
   * unsandboxed when the OS tool is missing (unless `enforce`).
   */
  sandboxRunCommand: z.boolean().optional(),
  sandboxRunCommandConfig: z
    .object({
      /** Additional absolute paths the sandboxed command may write to. */
      extraWritablePaths: z.array(z.string()).optional(),
      /** Fail commands instead of falling back when no sandbox is available. */
      enforce: z.boolean().optional(),
    })
    .optional(),
  enableAutoUpdate: z.boolean(),
  releaseChannel: ReleaseChannelSchema,
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

  /** v3.6: DB extension — persisted connections (Global + one per workspace). */
  dbConnections: z.array(DBConnectionStoredSchema).optional(),
  dbActiveGlobalId: z.string().nullable().optional(),
  dbActiveByWorkspace: z.record(z.string(), z.string()).optional(),

  ////////////////////////////////
  // E2E TESTING ONLY.
  ////////////////////////////////

  ////////////////////////////////
  // DEPRECATED.
  ////////////////////////////////
  enableProSaverMode: z.boolean().optional(),
  runtimeMode: RuntimeModeSchema.optional(),
});

/**
 * Type derived from the UserSettingsSchema
 */
export type UserSettings = z.infer<typeof UserSettingsSchema>;

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
}

export interface CodeProposal {
  type: "code-proposal";
  title: string;
  securityRisks: SecurityRisk[];
  filesChanged: FileChange[];
  packagesAdded: string[];
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
