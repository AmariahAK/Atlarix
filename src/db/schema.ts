import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
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
  createdAt: integer("created_at", { mode: "timestamp" })
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
}));

export const chatsRelations = relations(chats, ({ many, one }) => ({
  messages: many(messages),
  app: one(apps, {
    fields: [chats.appId],
    references: [apps.id],
  }),
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

// OpenRouter Favorite Models - Store user's favorite models (max 7)
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
  // Store typed JSON for args and environment variables
  args: text("args", { mode: "json" }).$type<string[] | null>(),
  envJson: text("env_json", { mode: "json" }).$type<Record<
    string,
    string
  > | null>(),
  url: text("url"),
  enabled: integer("enabled", { mode: "boolean" })
    .notNull()
    .default(sql`0`),
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
  type: text("type", {
    enum: ["mermaid", "plantuml", "architecture", "sequence", "class", "flowchart"],
  }).notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(), // Mermaid/PlantUML code
  metadata: text("metadata", { mode: "json" }).$type<{
    files?: string[];
    entities?: string[];
    focus?: string;
  } | null>(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Diagram Versions - Track history of diagram modifications
// Enhanced for Diagram-First Context System
export const diagramVersions = sqliteTable("diagram_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  diagramId: integer("diagram_id")
    .notNull()
    .references(() => diagrams.id, { onDelete: "cascade" }),
  content: text("content").notNull(), // Previous Mermaid/PlantUML code
  changeDescription: text("change_description"), // AI: "Added authentication flow"
  // New fields for Diagram-First Context System
  trigger: text("trigger", {
    enum: ["user_request", "auto_sync", "template_clone", "file_change"],
  }),
  summary: text("summary"), // AI-generated: "Refactored auth to use JWT"
  createdAt: integer("created_at", { mode: "timestamp" })
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
export const diagramsRelations = relations(diagrams, ({ one, many }) => ({
  workspace: one(apps, {
    fields: [diagrams.workspaceId],
    references: [apps.id],
  }),
  chat: one(chats, {
    fields: [diagrams.chatId],
    references: [chats.id],
  }),
  versions: many(diagramVersions),
}));

export const diagramVersionsRelations = relations(diagramVersions, ({ one }) => ({
  diagram: one(diagrams, {
    fields: [diagramVersions.diagramId],
    references: [diagrams.id],
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

