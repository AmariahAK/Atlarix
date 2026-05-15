import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

/**
 * Prompts Table - Global + Workspace Prompts
 * ==========================================
 * - Global (1 max): Used in incognito chats
 * - Workspace (1 per workspace): Used when chatting with workspace
 * 
 * 750 character limit enforced in app logic.
 */
export const prompts = sqliteTable("prompts", {
  id: integer("id").primaryKey({ autoIncrement: true }),

  // Type discriminator: 'global' or 'workspace'
  type: text("type", {
    enum: ["global", "workspace"]
  }).notNull(),

  // FK to apps (workspace) - only for workspace prompts
  // Cascade delete: prompt deleted when workspace deleted
  workspaceId: integer("workspace_id"),

  // Content: 750 char limit (enforced in handlers)
  content: text("content").notNull(),

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  // Unique: only 1 prompt per workspace (null workspaceId = global)
  unique("prompts_workspace_unique").on(table.workspaceId),
]);

export const apps = sqliteTable("apps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  path: text("path").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  githubOrg: text("github_org"),
  githubRepo: text("github_repo"),
  githubBranch: text("github_branch"),
  supabaseProjectId: text("supabase_project_id"),
  // If supabaseProjectId is a branch, then the parent project id set.
  // This is because there's no way to retrieve ALL the branches for ALL projects
  // in a single API call
  // This is only used for display purposes but is NOT used for any actual
  // supabase management logic.
  supabaseParentProjectId: text("supabase_parent_project_id"),
  neonProjectId: text("neon_project_id"),
  neonDevelopmentBranchId: text("neon_development_branch_id"),
  neonPreviewBranchId: text("neon_preview_branch_id"),
  vercelProjectId: text("vercel_project_id"),
  vercelProjectName: text("vercel_project_name"),
  vercelTeamId: text("vercel_team_id"),
  vercelDeploymentUrl: text("vercel_deployment_url"),
  installCommand: text("install_command"),
  startCommand: text("start_command"),
  chatContext: text("chat_context", { mode: "json" }),
  isFavorite: integer("is_favorite", { mode: "boolean" })
    .notNull()
    .default(sql`0`),
  preferredDiagramType: text("preferred_diagram_type", {
    enum: ["architecture", "dependencies", "flows"],
  }).default("architecture"),
});

export const chats = sqliteTable("chats", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  appId: integer("app_id")
    .references(() => apps.id, { onDelete: "cascade" }), // Nullable for chat-only sessions
  title: text("title"),
  initialCommitHash: text("initial_commit_hash"),
  /** v3.9: When true, the AI has already received answers to clarifying questions in this chat; omit <questions> instruction. */
  hasAnsweredQuestions: integer("has_answered_questions", { mode: "boolean" })
    .notNull()
    .default(false),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  approvalState: text("approval_state", {
    enum: ["approved", "rejected"],
  }),
  // The commit hash of the codebase at the time the message was created
  sourceCommitHash: text("source_commit_hash"),
  // The commit hash of the codebase at the time the message was sent
  commitHash: text("commit_hash"),
  requestId: text("request_id"),
  // Max tokens used for this message (only for assistant messages)
  maxTokensUsed: integer("max_tokens_used"),
  /** v3.9: 0-based exchange index (user+assistant pair). */
  exchangeIndex: integer("exchange_index"),
  /** v3.9: Snapshot id taken before this assistant message (for revert). */
  snapshotId: integer("snapshot_id"),
  /** v3.9: Paths written in this exchange (Build mode). */
  filesWritten: text("files_written", { mode: "json" }).$type<string[]>(),
  /** Non-destructive revert: message stays visible, styled as reverted in UI. */
  isReverted: integer("is_reverted", { mode: "boolean" })
    .notNull()
    .default(sql`0`),
  /** When the turn used Auto model routing, the resolved tier (fast / balanced / thinking). */
  autoRoutedTier: text("auto_routed_tier", {
    enum: ["fast", "balanced", "thinking"],
  }),
  /** Compaction continuation: system-inserted user line (hide or style softly in UI). */
  isSynthetic: integer("is_synthetic", { mode: "boolean" })
    .notNull()
    .default(sql`0`),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/** Persisted multi-model counsel sessions (optional history). */
export const counselSessions = sqliteTable("counsel_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  chatId: integer("chat_id").notNull(),
  turnId: text("turn_id").notNull(),
  trigger: text("trigger").notNull(),
  mode: text("mode").notNull(),
  question: text("question").notNull(),
  fastResponse: text("fast_response"),
  balancedResponse: text("balanced_response"),
  thinkingResponse: text("thinking_response"),
  synthesis: text("synthesis"),
  status: text("status").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  completedAt: integer("completed_at", { mode: "number" }),
});

/** Advisory shell hooks: before/after file writes and run_command (non-blocking). */
export const atlarixHooks = sqliteTable("atlarix_hooks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  trigger: text("trigger").notNull(),
  command: text("command").notNull(),
  argsJson: text("args_json"),
  workspaceId: integer("workspace_id"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(sql`1`),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/** Workspace-scoped slash commands: expand user message before stream. */
export const customCommands = sqliteTable("custom_commands", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  promptTemplate: text("prompt_template").notNull(),
  modeOverride: text("mode_override"),
  workspaceId: integer("workspace_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const versions = sqliteTable(
  "versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    commitHash: text("commit_hash").notNull(),
    neonDbTimestamp: text("neon_db_timestamp"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    // Unique constraint to prevent duplicate versions
    unique("versions_app_commit_unique").on(table.appId, table.commitHash),
  ],
);

// Define relations
export const appsRelations = relations(apps, ({ many }) => ({
  chats: many(chats),
  versions: many(versions),
  workspaceDiagrams: many(workspaceDiagrams),
  // Pass 7: Blueprint + PIVOT relations removed (tables dropped in migration 0043).
  projectSnapshots: many(projectSnapshots),
  projectMemoryRows: many(projectMemory),
}));

export const chatsRelations = relations(chats, ({ many, one }) => ({
  messages: many(messages),
  app: one(apps, {
    fields: [chats.appId],
    references: [apps.id],
  }),
  toolSessionLoads: many(toolSessionLoads),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  chat: one(chats, {
    fields: [messages.chatId],
    references: [chats.id],
  }),
}));

export const language_model_providers = sqliteTable(
  "language_model_providers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    api_base_url: text("api_base_url").notNull(),
    env_var_name: text("env_var_name"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
);

export const language_models = sqliteTable("language_models", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  displayName: text("display_name").notNull(),
  apiName: text("api_name").notNull(),
  builtinProviderId: text("builtin_provider_id"),
  customProviderId: text("custom_provider_id").references(
    () => language_model_providers.id,
    { onDelete: "cascade" },
  ),
  description: text("description"),
  max_output_tokens: integer("max_output_tokens"),
  context_window: integer("context_window"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Provider API Keys - Store API keys locally (not in .env)
export const providerApiKeys = sqliteTable("provider_api_keys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  providerId: text("provider_id").notNull().unique(),
  apiKey: text("api_key").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Chat Context Summaries - Phase 6 context bar + auto-summarize
// One row per chat; newer compactions prepend `<summary id="N">` and nest prior text.
export const chatContextSummaries = sqliteTable("chat_context_summaries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id")
    .notNull()
    .unique()
    .references(() => chats.id, { onDelete: "cascade" }),
  summaryText: text("summary_text").notNull(),
  lastMessageId: integer("last_message_id").notNull(),
  compactionGeneration: integer("compaction_generation").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const chatContextSummariesRelations = relations(chatContextSummaries, ({ one }) => ({
  chat: one(chats, {
    fields: [chatContextSummaries.chatId],
    references: [chats.id],
  }),
}));

// OpenRouter Favorite Models - Store user's favorite models (max 3: Fast/Balanced/Deep)
export const openrouterFavorites = sqliteTable("openrouter_favorites", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  modelId: text("model_id").notNull().unique(),
  displayOrder: integer("display_order").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Workspace Modifications - Track changes with auto-summarization
export const workspaceModifications = sqliteTable("workspace_modifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workspacePath: text("workspace_path").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  isSummary: integer("is_summary", { mode: "boolean" })
    .notNull()
    .default(sql`0`),
  summaryOfPeriod: text("summary_of_period"),
  todoReference: text("todo_reference"),
  filesModified: text("files_modified", { mode: "json" }).$type<string[] | null>(),
  changesDescription: text("changes_description"),
  aiSummary: text("ai_summary"),
});

// Cleanup Log - Track automated cleanup operations
export const cleanupLog = sqliteTable("cleanup_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cleanupDate: integer("cleanup_date", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  sessionsDeleted: integer("sessions_deleted").notNull().default(0),
  modificationsSummarized: integer("modifications_summarized").notNull().default(0),
});

// Define relations for new tables
export const languageModelProvidersRelations = relations(
  language_model_providers,
  ({ many }) => ({
    languageModels: many(language_models),
  }),
);

export const languageModelsRelations = relations(
  language_models,
  ({ one }) => ({
    provider: one(language_model_providers, {
      fields: [language_models.customProviderId],
      references: [language_model_providers.id],
    }),
  }),
);

export const versionsRelations = relations(versions, ({ one }) => ({
  app: one(apps, {
    fields: [versions.appId],
    references: [apps.id],
  }),
}));

// --- MCP (Model Context Protocol) tables ---
export const mcpServers = sqliteTable("mcp_servers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  transport: text("transport").notNull(),
  command: text("command"),
  args: text("args", { mode: "json" }).$type<string[] | null>(),
  envJson: text("env_json", { mode: "json" }).$type<Record<
    string,
    string
  > | null>(),
  url: text("url"),
  enabled: integer("enabled", { mode: "boolean" })
    .notNull()
    .default(sql`0`),
  scope: text("scope").notNull().default("global"), // 'global' | 'workspace'
  appId: integer("app_id").references(() => apps.id, { onDelete: "cascade" }),
  /** Pass 7: when true, this server was installed from the marketplace registry. */
  fromRegistry: integer("from_registry", { mode: "boolean" })
    .notNull()
    .default(sql`0`),
  /** Pass 7: corresponds to `McpRegistryEntry.id` when installed via marketplace. */
  registryId: text("registry_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const mcpToolConsents = sqliteTable(
  "mcp_tool_consents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    serverId: integer("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    consent: text("consent").notNull().default("ask"), // ask | always | denied
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [unique("uniq_mcp_consent").on(table.serverId, table.toolName)],
);

// Search Providers - Store search provider configurations (SearxNG, etc.)
export const searchProviders = sqliteTable("search_providers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull().unique(), // 'searxng', 'tavily', 'serper', etc.
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(sql`0`),
  config: text("config", { mode: "json" }).$type<{
    url?: string;
    apiKey?: string;
  } | null>(), // JSON for flexibility
  priority: integer("priority").notNull().default(0), // for fallback order
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// --- Diagrams tables ---

// Diagrams - Store AI-generated architecture/class/sequence diagrams
export const diagrams = sqliteTable("diagrams", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workspaceId: integer("workspace_id").references(() => apps.id, { onDelete: "cascade" }),
  chatId: integer("chat_id").references(() => chats.id, { onDelete: "set null" }),
  diagramType: text("diagram_type", {
    enum: ["mermaid", "architecture", "sequence", "class", "flowchart"],
  }).notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(), // Mermaid diagram code
  /** MD5 map path → hash at last diagram generation (staleness; replaces metadata.diagramGitCommit). */
  lastSnapshotHashes: text("last_snapshot_hashes", { mode: "json" }).$type<
    Record<string, string> | null
  >(),
  metadata: text("metadata", { mode: "json" }).$type<{
    files?: string[];
    entities?: string[];
    focus?: string;
    summary?: string;
    /** @deprecated Legacy internal-git commit; use lastSnapshotHashes + .atlarix/snapshot_hashes.json */
    diagramGitCommit?: string;
    /** Git commit when diagram was saved (for update vs regenerate decision) */
    gitCommit?: string;
    /** 'regenerate' | 'update' */
    updateType?: string;
    workflow?: { nodes?: unknown[]; connections?: unknown };
    nodeMessages?: Array<{ nodeId: string; message: string; createdAt: number; updatedAt: number }>;
  } | null>(),
  // Fingerprint fields for staleness detection
  fingerprintHash: text("fingerprint_hash"), // Quick comparison hash
  fingerprintData: text("fingerprint_data", { mode: "json" }).$type<{
    fileCount: number;
    directoryCount: number;
    fileTypes: Record<string, number>;
    totalSize: number;
    lastModified: number;
    hash: string;
  } | null>(),
  createdFromFileCount: integer("created_from_file_count"), // For fast checks
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// --- Daily Logs (Diagram-First Context System) ---
// AI-generated micro-changelog for workspace activity
// Replaces chat history as context source

export const dailyLogs = sqliteTable("daily_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  date: integer("date", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),

  // AI-generated summary bullets (3-5 items)
  microChanges: text("micro_changes", { mode: "json" }).$type<string[] | null>(),

  // SELECTIVE logging - only state-changing tools
  significantActions: text("significant_actions", { mode: "json" }).$type<{
    tool: string;
    target?: string;
    summary: string;
    timestamp: string; // ISO string
  }[] | null>(),

  filesTouched: text("files_touched", { mode: "json" }).$type<string[] | null>(),
  diagramChanged: integer("diagram_changed", { mode: "boolean" })
    .notNull()
    .default(sql`0`),

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Diagram relations
export const diagramsRelations = relations(diagrams, ({ one }) => ({
  workspace: one(apps, {
    fields: [diagrams.workspaceId],
    references: [apps.id],
  }),
  chat: one(chats, {
    fields: [diagrams.chatId],
    references: [chats.id],
  }),
}));

export const dailyLogsRelations = relations(dailyLogs, ({ one }) => ({
  workspace: one(apps, {
    fields: [dailyLogs.workspaceId],
    references: [apps.id],
  }),
}));

// --- Workspace Diagrams (Diagram Timeline System) ---
// Save timestamped diagram snapshots to show project evolution
// Like financial charts, but for code architecture

export const workspaceDiagrams = sqliteTable(
  "workspace_diagrams",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),

    // Diagram content (multiple types per snapshot)
    architecture: text("architecture").notNull(), // Always present
    dependencies: text("dependencies"), // Optional - captured on package.json change
    flows: text("flows", { mode: "json" }).$type<Record<string, string> | null>(), // User-created

    // Capture trigger
    trigger: text("trigger", {
      enum: ["auto", "ai_change", "user_request", "structural"],
    }).notNull(),

    // Metadata
    summary: text("summary"), // AI-generated: "Added AuthModule, refactored DB"
    annotation: text("annotation"), // User-provided: "Before v2.0 refactor"
    filesChanged: text("files_changed", { mode: "json" }).$type<string[] | null>(),

    // Deduplication
    hash: text("hash").notNull(), // For duplicate detection

    // Protection (annotated snapshots never auto-deleted)
    protected: integer("protected", { mode: "boolean" })
      .notNull()
      .default(sql`0`),

    // Compression flag (old snapshots marked as compressed)
    compressed: integer("compressed", { mode: "boolean" })
      .notNull()
      .default(sql`0`),

    // Timestamps
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    // Index for fast timeline queries
    index("workspace_diagrams_app_id_created_at_idx").on(
      table.appId,
      table.createdAt
    ),
  ]
);

// Workspace Diagrams relations
export const workspaceDiagramsRelations = relations(workspaceDiagrams, ({ one }) => ({
  app: one(apps, {
    fields: [workspaceDiagrams.appId],
    references: [apps.id],
  }),
}));

// --- Workspace Snapshots (Pro) ---
// One-click save/restore of workspace state (files, prompt, diagram, chat)
export const workspaceSnapshots = sqliteTable(
  "workspace_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    filesJson: text("files_json", { mode: "json" }).$type<Record<string, string>>().notNull(),
    promptContent: text("prompt_content"),
    diagramContent: text("diagram_content"),
    chatMessagesJson: text("chat_messages_json", { mode: "json" }).$type<Array<{ role: string; content: string }>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("workspace_snapshots_app_id_idx").on(table.appId),
  ]
);

// --- v4.0: Tool session loads (analytics - which tools first called per chat) ---
export const toolSessionLoads = sqliteTable(
  "tool_session_loads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    firstCalledAt: integer("first_called_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("tool_session_loads_chat_id_idx").on(table.chatId)],
);

export const toolSessionLoadsRelations = relations(toolSessionLoads, ({ one }) => ({
  chat: one(chats, {
    fields: [toolSessionLoads.chatId],
    references: [chats.id],
  }),
}));

// --- Workflow Templates (Atlaflow template library) ---
// Save/load named workflow templates (e.g. "API + DB", "Webhook → Slack")
export const workflowTemplates = sqliteTable("workflow_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  workflow: text("workflow", { mode: "json" })
    .$type<{ nodes: unknown[]; connections: unknown }>()
    .notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// PASS6: Blueprint + PIVOT tables restored. Migration 0043 was dropped.
// --- Blueprint (Phase 7 Additive Blueprint) ---
// One blueprint per workspace: rooms, edges, functions per room
export const blueprints = sqliteTable(
  "blueprints",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    content: text("content", { mode: "json" })
      .$type<{ rooms: unknown[]; edges: unknown[]; envRefs?: string[] }>()
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [unique("blueprints_workspace_unique").on(table.workspaceId)]
);

export const blueprintsRelations = relations(blueprints, ({ one }) => ({
  workspace: one(apps, {
    fields: [blueprints.workspaceId],
    references: [apps.id],
  }),
}));

// --- PIVOT (Full PIVOT: nodes, edges, containers, beacons, blueprint_snapshots) ---
export const pivotNodes = sqliteTable(
  "pivot_nodes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    nodeType: text("node_type", {
      enum: ["file", "function", "class", "module"],
    }).notNull(),
    label: text("label").notNull(),
    filePath: text("file_path").notNull(),
    rangeStart: integer("range_start"),
    rangeEnd: integer("range_end"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    index("pivot_nodes_workspace_idx").on(table.workspaceId),
    unique("pivot_nodes_workspace_external_unique").on(table.workspaceId, table.externalId),
  ]
);

export const pivotEdges = sqliteTable(
  "pivot_edges",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    fromId: text("from_id").notNull(),
    toId: text("to_id").notNull(),
    edgeType: text("edge_type", {
      enum: ["import", "call", "extends", "api"],
    }).notNull(),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [index("pivot_edges_workspace_idx").on(table.workspaceId)]
);

export const pivotContainers = sqliteTable("pivot_containers", {
  id: text("id").primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  intent: text("intent"),
  position: text("position", { mode: "json" }).$type<{ x: number; y: number }>(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const pivotBeacons = sqliteTable("pivot_beacons", {
  id: text("id").primaryKey(),
  containerId: text("container_id")
    .notNull()
    .references(() => pivotContainers.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  kind: text("kind", {
    enum: ["api", "webhook", "function", "feature"],
  }).notNull(),
  description: text("description"),
  filePath: text("file_path"),
  position: text("position", { mode: "json" }).$type<{ x: number; y: number }>(),
});

export const blueprintSnapshots = sqliteTable(
  "blueprint_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    snapshotAt: integer("snapshot_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    blueprintJson: text("blueprint_json").notNull(),
    source: text("source", {
      enum: ["rte", "user", "ai_cluster"],
    }).notNull(),
  },
  (table) => [index("blueprint_snapshots_workspace_idx").on(table.workspaceId)]
);

/** v5.0 Section 2: project memory snapshots */
export const projectSnapshots = sqliteTable(
  "project_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    blueprintJson: text("blueprint_json").notNull(),
    planMd: text("plan_md"),
    diagramMermaid: text("diagram_mermaid"),
    gitCommitHash: text("git_commit_hash"),
    sessionSummary: text("session_summary"),
    trigger: text("trigger", {
      enum: ["blueprint_change", "plan_update", "build_complete", "session_end"],
    }).notNull(),
  },
  (table) => [
    index("project_snapshots_workspace_created_idx").on(table.workspaceId, table.createdAt),
  ],
);

export const projectMemory = sqliteTable(
  "project_memory",
  {
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.key], name: "project_memory_pk" }),
    index("project_memory_workspace_idx").on(table.workspaceId),
  ],
);

/** v3.6: Lightning review memory — learn from past fixes per workspace */
export const reviewPatterns = sqliteTable(
  "review_patterns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    issueRule: text("issue_rule").notNull(),
    issueContext: text("issue_context"),
    fixApplied: text("fix_applied").notNull(),
    accepted: integer("accepted", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("review_patterns_workspace_idx").on(table.workspaceId)]
);

// --- Skills (Community registry installs) ---
// Same skill id can exist in both global and workspace scope, so uniqueness is composite.
export const installedSkills = sqliteTable(
  "installed_skills",
  {
    id: text("id").notNull(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    author: text("author").notNull(),
    description: text("description").notNull(),
    tags: text("tags").notNull(), // JSON: string[]
    compatibleModes: text("compatible_modes").notNull(), // JSON: string[]
    installedAt: integer("installed_at", { mode: "timestamp" }).notNull(),
    scope: text("scope").notNull(), // "global" | "workspace"
    workspacePath: text("workspace_path"), // null when scope === "global"
    cachedFiles: text("cached_files").notNull(), // JSON: { name, localPath }[]
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.scope, table.workspacePath] }),
  }),
);

// PASS6: pivot* + blueprintSnapshots relations restored.
export const pivotNodesRelations = relations(pivotNodes, ({ one }) => ({
  workspace: one(apps, {
    fields: [pivotNodes.workspaceId],
    references: [apps.id],
  }),
}));

export const pivotEdgesRelations = relations(pivotEdges, ({ one }) => ({
  workspace: one(apps, {
    fields: [pivotEdges.workspaceId],
    references: [apps.id],
  }),
}));

export const pivotContainersRelations = relations(pivotContainers, ({ one, many }) => ({
  workspace: one(apps, {
    fields: [pivotContainers.workspaceId],
    references: [apps.id],
  }),
  beacons: many(pivotBeacons),
}));

export const pivotBeaconsRelations = relations(pivotBeacons, ({ one }) => ({
  container: one(pivotContainers, {
    fields: [pivotBeacons.containerId],
    references: [pivotContainers.id],
  }),
}));

export const blueprintSnapshotsRelations = relations(blueprintSnapshots, ({ one }) => ({
  workspace: one(apps, {
    fields: [blueprintSnapshots.workspaceId],
    references: [apps.id],
  }),
}));

export const projectSnapshotsRelations = relations(projectSnapshots, ({ one }) => ({
  workspace: one(apps, {
    fields: [projectSnapshots.workspaceId],
    references: [apps.id],
  }),
}));

export const projectMemoryRelations = relations(projectMemory, ({ one }) => ({
  workspace: one(apps, {
    fields: [projectMemory.workspaceId],
    references: [apps.id],
  }),
}));

export const reviewPatternsRelations = relations(reviewPatterns, ({ one }) => ({
  workspace: one(apps, {
    fields: [reviewPatterns.workspaceId],
    references: [apps.id],
  }),
}));
