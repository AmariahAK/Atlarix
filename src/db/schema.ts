import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

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
  lastOpenedAt: integer("last_opened_at", { mode: "timestamp" }),
  workspaceKind: text("workspace_kind", {
    enum: ["local", "remote-ssh"],
  })
    .notNull()
    .default("local"),
  remoteConnection: text("remote_connection", { mode: "json" }),
});

/** Per-workspace allow/deny for terminal command categories (first token). */
export const workspaceCommandPermissions = sqliteTable(
  "workspace_command_permissions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    decision: text("decision", {
      enum: ["always_allow", "always_deny"],
    }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    unique("workspace_command_permissions_app_category").on(
      table.appId,
      table.category,
    ),
    index("workspace_command_permissions_app_id_idx").on(table.appId),
  ],
);

/** Per-workspace allow/deny for file paths (file, directory, or extension scope). */
export const workspaceFilePermissions = sqliteTable(
  "workspace_file_permissions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    scopeType: text("scope_type", {
      enum: ["file", "directory", "extension"],
    }).notNull(),
    scopeValue: text("scope_value").notNull(),
    decision: text("decision", {
      enum: ["always_allow", "always_deny"],
    }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    unique("workspace_file_permissions_app_scope").on(
      table.appId,
      table.scopeType,
      table.scopeValue,
    ),
    index("workspace_file_permissions_app_id_idx").on(table.appId),
  ],
);

/** Workspace-scoped chat sessions (local persistence). */
export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("Untitled"),
  /** In-memory stream transport id (negative); survives app restart mapping. */
  streamChatId: integer("stream_chat_id"),
  /** v12 2.3: "background" for detached agent sessions, else "normal". */
  kind: text("kind", { enum: ["normal", "background"] })
    .notNull()
    .default("normal"),
  /** v12 2.3: background-agent run status (null for normal sessions). */
  status: text("status", { enum: ["running", "done", "error"] }),
  /** v12 2.3: error detail when status="error". */
  statusError: text("status_error"),
  /**
   * v12 S16: background-agent run metadata, JSON
   * `{mode, snapshotTurnId, changedFiles, reverted}` — restores the
   * keep/revert approval gate across app restarts. Null for normal sessions.
   */
  agentMeta: text("agent_meta"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type SessionMessageKind = "message" | "plan";
export type PlanArtifactStatus = "plan" | "building" | "built";

export const sessionMessages = sqliteTable("session_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => chatSessions.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant", "tool"] }).notNull(),
  content: text("content").notNull(),
  kind: text("kind", { enum: ["message", "plan"] })
    .notNull()
    .default("message"),
  planStatus: text("plan_status", { enum: ["plan", "building", "built"] }),
  /** Frozen sub-agent / tool UI for session resume (JSON DisplaySnapshotV1). */
  displaySnapshot: text("display_snapshot"),
  /** Model-facing user text (attachment bodies). */
  modelContent: text("model_content"),
  pasteAttachments: text("paste_attachments", { mode: "json" }).$type<
    import("../ipc/ipc_types").PasteAttachmentMeta[] | null
  >(),
  fileAttachments: text("file_attachments", { mode: "json" }).$type<
    import("../ipc/ipc_types").StoredFileAttachment[] | null
  >(),
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
    unique("versions_app_commit_unique").on(table.appId, table.commitHash),
  ],
);

export const appsRelations = relations(apps, ({ many }) => ({
  chatSessions: many(chatSessions),
  versions: many(versions),
  // Pass 7: Blueprint + PIVOT relations removed (tables dropped in migration 0043).
  projectSnapshots: many(projectSnapshots),
  projectMemoryRows: many(projectMemory),
  commandPermissions: many(workspaceCommandPermissions),
  filePermissions: many(workspaceFilePermissions),
}));

export const workspaceCommandPermissionsRelations = relations(
  workspaceCommandPermissions,
  ({ one }) => ({
    workspace: one(apps, {
      fields: [workspaceCommandPermissions.appId],
      references: [apps.id],
    }),
  }),
);

export const workspaceFilePermissionsRelations = relations(
  workspaceFilePermissions,
  ({ one }) => ({
    workspace: one(apps, {
      fields: [workspaceFilePermissions.appId],
      references: [apps.id],
    }),
  }),
);

export const chatSessionsRelations = relations(chatSessions, ({ one, many }) => ({
  workspace: one(apps, {
    fields: [chatSessions.workspaceId],
    references: [apps.id],
  }),
  messages: many(sessionMessages),
}));

export const sessionMessagesRelations = relations(sessionMessages, ({ one }) => ({
  session: one(chatSessions, {
    fields: [sessionMessages.sessionId],
    references: [chatSessions.id],
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
  apiKey: text("api_key"),
  enabled: integer("enabled", { mode: "boolean" })
    .notNull()
    .default(sql`0`),
  scope: text("scope").notNull().default("global"), // 'global' | 'workspace'
  appId: integer("app_id").references(() => apps.id, { onDelete: "cascade" }),
  /** Pass 7: when true, this server was installed from the marketplace registry. */
  fromRegistry: integer("from_registry", { mode: "boolean" })
    .notNull()
    .default(sql`0`),
  /** How this server authenticates: none | env | api_key | oauth */
  authType: text("auth_type").notNull().default("none"),
  /** Encrypted OAuth token blob (access_token, refresh_token, expires_in). */
  oauthTokensJson: text("oauth_tokens_json"),
  /** Encrypted dynamic OAuth client registration payload. */
  oauthClientJson: text("oauth_client_json"),
  /** Cached OAuth discovery metadata (RFC 9728 / auth server). */
  oauthDiscoveryJson: text("oauth_discovery_json"),
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

// Diagram tables removed with the diagram subsystem. The legacy `diagrams` /
// `workspace_diagrams` SQLite tables are DROPPED by migration 0062 — `diagrams`
// kept a dead FK to the 0058-dropped `chats` table, which made SQLite unable to
// even PREPARE `DELETE FROM apps` (workspace deletion failed with
// "no such table: main.chats").

// --- Daily Logs ---
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

export const dailyLogsRelations = relations(dailyLogs, ({ one }) => ({
  workspace: one(apps, {
    fields: [dailyLogs.workspaceId],
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
    chatMessagesJson: text("chat_messages_json", { mode: "json" }).$type<Array<{ role: string; content: string }>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("workspace_snapshots_app_id_idx").on(table.appId),
  ],
);

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

// PASS6: PIVOT tables restored. Legacy `blueprints` SQLite table dropped in 0047.

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
