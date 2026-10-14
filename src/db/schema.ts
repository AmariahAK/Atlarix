import { sql } from "drizzle-orm";
import {
  index,
  primaryKey,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
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

/**
 * Per-workspace allow/deny for file paths (file, directory, or extension scope).
 * Also hosts `sandbox_path` rows: absolute OS paths the user granted the command
 * sandbox write access to via escalation-on-denial (reused here to avoid a
 * parallel table; the file-write gate ignores this scope — see
 * `resolveFilePermissionGate`). No SQL migration: the column is plain TEXT
 * (drizzle `enum` is TS-only, no CHECK — see drizzle/0057).
 */
export const workspaceFilePermissions = sqliteTable(
  "workspace_file_permissions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    scopeType: text("scope_type", {
      enum: ["file", "directory", "extension", "sandbox_path"],
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
  /**
   * Who named this session.
   *
   * "auto" — generated from the first exchange, so it should FOLLOW that
   * exchange: editing the first prompt regenerates it, the way every other
   * chat app behaves. "user" — typed by hand, and never overwritten.
   *
   * Re-titling used to be gated on the title still being a DEFAULT ("Untitled" /
   * "New chat"), which meant that once a session had any name at all — including
   * one we generated ourselves — editing the prompt it came from could never
   * update it.
   */
  titleSource: text("title_source", { enum: ["auto", "user"] })
    .notNull()
    .default("auto"),
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
  /**
   * The work mode this session runs in — Explore / Plan / Build / Debug / Review.
   *
   * The mode used to live ONLY in global settings, so reopening a session you had
   * been planning in, from a window whose global preference was Build, silently
   * made the next turn a Build turn: writes allowed on a thread you were only
   * exploring. Two sessions open at once could not disagree, which is the same
   * global-vs-scoped confusion that caused the v14.32.0 and v14.34.0 bugs. The
   * session is the honest owner — it is what the user thinks they are choosing a
   * mode FOR.
   *
   * NULL means "no stored mode", which is every row written before this column
   * existed. Those keep resolving from the global preference exactly as they did,
   * and the first deliberate pick inside the session stamps it here. Defaulting
   * them on open instead would hand every old session a mode it was never given.
   */
  workMode: text("work_mode", {
    enum: ["ask", "plan", "build", "debug", "review"],
  }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * What sort of row this is. THE source of truth — import this rather than
 * re-declaring the union, which is how it drifted before.
 *
 * "compaction_marker" (v14.39.1) is the durable summary row compaction writes.
 * Before it, a marker was a plain "message" recognised only by its content
 * starting with `[COMPACTION MARKER]` — so any tool output, pasted text or file
 * beginning with those bytes was indistinguishable from one, and
 * `sliceFromLastCompactionSummary` would cut the model's history there.
 * `flattenNativeForCompaction` makes that concrete: it turns tool results into
 * `{ role: "user", content: "<tool_result …>" }`, exactly the shape the detector
 * keys on.
 */
export type SessionMessageKind = "message" | "plan" | "compaction_marker";
export type PlanArtifactStatus = "plan" | "building" | "built";

export const sessionMessages = sqliteTable("session_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => chatSessions.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant", "tool"] }).notNull(),
  content: text("content").notNull(),
  /**
   * See `SessionMessageKind`. Plain-TEXT column (SQLite doesn't enforce the
   * enum) → adding a value needs no migration, same as `status` gaining
   * "waiting" below.
   */
  kind: text("kind", { enum: ["message", "plan", "compaction_marker"] })
    .notNull()
    .default("message"),
  /**
   * "interrupted" marks an assistant turn whose stream was cut off (compass
   * stop, app quit/suspend, crash) before completing. Such rows hold partial
   * content and render a "Continue" affordance. Normal turns are "complete".
   * v14.7: "waiting" marks a turn PARKED on a human wait (pending approval or an
   * `ask_user` question) — NOT an error; renders the wait/question affordance on
   * reopen. Plain-TEXT column (SQLite doesn't enforce the enum) → no migration.
   */
  status: text("status", { enum: ["complete", "interrupted", "waiting"] })
    .notNull()
    .default("complete"),
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
  /**
   * Shadow-git revert checkpoint for this assistant turn. Persisted so the
   * revert-turn affordance survives an app restart (the snapshots themselves
   * already live on disk; this couples them to the message history).
   */
  snapshotTurnId: text("snapshot_turn_id"),
  /**
   * The provider's REAL total token usage for this assistant turn.
   *
   * The token meter prefers this over its own estimate, and the in-memory
   * stream transport already carried it — but it was never persisted here, so a
   * restart lost it and the meter silently fell back to the client-side
   * estimate. That estimate counts only the flat persisted messages: no system
   * prompt, and none of the native tool history that dominates an agentic
   * session. Measured on one session, the two disagreed by ~2× the whole way
   * (417k reported vs 211k estimated), so reopening the app appeared to halve
   * the context. Nothing had been summarised; the ruler changed.
   */
  maxTokensUsed: integer("max_tokens_used"),
  /**
   * `kind: "plan"` rows only — the plan's name, as the model supplied it.
   *
   * Previously a plan had no title column at all: `createPlanArtifact` prepended
   * the supplied title into `content` as an H1, and every reader scraped it back
   * out of the markdown. The prepend was guarded on
   * `!content.trim().startsWith("#")`, which is true of a `## Goal` section
   * heading as much as of a real title — so any model that opened its plan with
   * a section heading (the natural shape of a plan document, and what most of
   * them write) had its title silently DISCARDED, and the scraper then returned
   * the literal word "Goal" as the plan's name.
   *
   * Storing it makes the title data instead of a substring, which deletes the
   * prepend branch and the scrape for every new row. Nullable, because rows
   * written before this migration have none — `planArtifactTitleFromContent`
   * remains as their fallback and only theirs.
   */
  title: text("title"),
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
  enabled: integer("enabled", { mode: "boolean" })
    .notNull()
    .default(sql`1`),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/** Workspace-scoped slash commands: expand user message before stream. */
export const versions = sqliteTable(
  "versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    commitHash: text("commit_hash").notNull(),
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

export const chatSessionsRelations = relations(
  chatSessions,
  ({ one, many }) => ({
    workspace: one(apps, {
      fields: [chatSessions.workspaceId],
      references: [apps.id],
    }),
    messages: many(sessionMessages),
  }),
);

export const sessionMessagesRelations = relations(
  sessionMessages,
  ({ one }) => ({
    session: one(chatSessions, {
      fields: [sessionMessages.sessionId],
      references: [chatSessions.id],
    }),
  }),
);

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
  filesModified: text("files_modified", { mode: "json" }).$type<
    string[] | null
  >(),
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
  modificationsSummarized: integer("modifications_summarized")
    .notNull()
    .default(0),
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
  /**
   * Request headers for a server reached by URL (`X-Api-Key`, `X-Org-Id`, …),
   * values encrypted like `envJson`. From pasted or imported configs, registry
   * entries and editors' ACP `mcpServers`. `apiKey` still means
   * `Authorization: Bearer`.
   */
  headersJson: text("headers_json", { mode: "json" }).$type<Record<
    string,
    string
  > | null>(),
  apiKey: text("api_key"),
  enabled: integer("enabled", { mode: "boolean" })
    .notNull()
    .default(sql`0`),
  /**
   * Always "workspace" in practice. Global MCP servers were retired and their
   * rows purged by migration `0049_workspace_only_remote.sql`.
   *
   * THE DEFAULT IS STILL THE RETIRED VALUE, and that is deliberate rather than
   * an oversight. It is a latent trap — every read filters `scope =
   * 'workspace'`, so an insert that omitted `scope` would write a server that
   * saves successfully and is then invisible everywhere, with nothing to explain
   * why. It is UNREACHABLE today: both insert paths bind it explicitly
   * (`mcp_handlers.ts:127` and `:435`, each `const scope = "workspace"`).
   *
   * Why it is not simply flipped: SQLite has no `ALTER COLUMN SET DEFAULT`, so
   * changing it means rebuilding the table — the same cost as dropping the
   * column, for a path nothing can currently take. Changing it here WITHOUT a
   * migration would be worse still: new installs would get one default and
   * existing installs the other, so the schema would describe neither.
   *
   * If a third insert path is ever added, bind `scope` explicitly like the other
   * two. That is the enforcement; this comment is the warning.
   */
  scope: text("scope").notNull().default("global"),
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
  enabled: integer("enabled", { mode: "boolean" })
    .notNull()
    .default(sql`0`),
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
  microChanges: text("micro_changes", { mode: "json" }).$type<
    string[] | null
  >(),

  // SELECTIVE logging - only state-changing tools
  significantActions: text("significant_actions", { mode: "json" }).$type<
    | {
        tool: string;
        target?: string;
        summary: string;
        timestamp: string; // ISO string
      }[]
    | null
  >(),

  filesTouched: text("files_touched", { mode: "json" }).$type<
    string[] | null
  >(),
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
    filesJson: text("files_json", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull(),
    promptContent: text("prompt_content"),
    chatMessagesJson: text("chat_messages_json", { mode: "json" }).$type<
      Array<{ role: string; content: string }>
    >(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("workspace_snapshots_app_id_idx").on(table.appId)],
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
    metadata: text("metadata", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
  },
  (table) => [
    index("pivot_nodes_workspace_idx").on(table.workspaceId),
    unique("pivot_nodes_workspace_external_unique").on(
      table.workspaceId,
      table.externalId,
    ),
  ],
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
    metadata: text("metadata", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
  },
  (table) => [index("pivot_edges_workspace_idx").on(table.workspaceId)],
);

export const pivotContainers = sqliteTable("pivot_containers", {
  id: text("id").primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  intent: text("intent"),
  position: text("position", { mode: "json" }).$type<{
    x: number;
    y: number;
  }>(),
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
  position: text("position", { mode: "json" }).$type<{
    x: number;
    y: number;
  }>(),
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
  (table) => [index("blueprint_snapshots_workspace_idx").on(table.workspaceId)],
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
      enum: [
        "blueprint_change",
        "plan_update",
        "build_complete",
        "session_end",
      ],
    }).notNull(),
  },
  (table) => [
    index("project_snapshots_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
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
    primaryKey({
      columns: [table.workspaceId, table.key],
      name: "project_memory_pk",
    }),
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
  (table) => [index("review_patterns_workspace_idx").on(table.workspaceId)],
);

// --- Skills ---
//
// There is no skills table. The in-app marketplace and its `installed_skills` table were
// deleted in v14.45 (migration `0076`); skills are `.atlarix/skills/*.md` files in the
// user's own repo, read from disk by `priority-skill-loader.ts`. Nothing about them is
// persisted here, deliberately — the files ARE the state.

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

export const pivotContainersRelations = relations(
  pivotContainers,
  ({ one, many }) => ({
    workspace: one(apps, {
      fields: [pivotContainers.workspaceId],
      references: [apps.id],
    }),
    beacons: many(pivotBeacons),
  }),
);

export const pivotBeaconsRelations = relations(pivotBeacons, ({ one }) => ({
  container: one(pivotContainers, {
    fields: [pivotBeacons.containerId],
    references: [pivotContainers.id],
  }),
}));

export const blueprintSnapshotsRelations = relations(
  blueprintSnapshots,
  ({ one }) => ({
    workspace: one(apps, {
      fields: [blueprintSnapshots.workspaceId],
      references: [apps.id],
    }),
  }),
);

export const projectSnapshotsRelations = relations(
  projectSnapshots,
  ({ one }) => ({
    workspace: one(apps, {
      fields: [projectSnapshots.workspaceId],
      references: [apps.id],
    }),
  }),
);

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

/**
 * Automations — persisted, locally-executed recurring agent runs (Codex-app
 * model): a schedule or deterministic poller (GitHub / MCP) fires, the runner
 * executes an unattended agent turn, and the result lands in the triage feed.
 */
export const automations = sqliteTable("automations", {
  id: text("id").primaryKey(),
  /** Nullable for future global automations; v1 requires a workspace. */
  workspaceId: integer("workspace_id").references(() => apps.id, {
    onDelete: "cascade",
  }),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** JSON AutomationTrigger (zod-validated at the IPC boundary). */
  trigger: text("trigger").notNull(),
  prompt: text("prompt").notNull(),
  /**
   * notify-only (default at the zod layer): fired triggers post to the feed
   * with no model turn; read-only spends tokens on an ask-mode turn. The old
   * "worktree-write" mode was removed in v14.21.0 with the sub-agent worktree;
   * migration 0070 downgrades any surviving row to read-only.
   * (Enum is drizzle-type-level only — the 0066 column has no CHECK.)
   */
  runMode: text("run_mode", { enum: ["notify-only", "read-only"] })
    .notNull()
    .default("read-only"),
  /**
   * Does a finished run reach the AGENT, or only the user?
   *
   * Distinct from `runMode`, and the pair is the point. `runMode` decides
   * whether a fired trigger runs the model UNATTENDED; `notifyAgent` decides
   * whether the outcome is delivered into the interactive session for the agent
   * to act on. An automation with `notifyAgent` false can never cost tokens in
   * chat no matter how often it fires — which is what makes "watch Slack" and
   * "watch CI" different kinds of thing rather than the same thing at different
   * intervals.
   *
   * Required at the zod layer for anything new (user OR agent must choose);
   * the column default covers only rows that predate the field.
   */
  notifyAgent: integer("notify_agent", { mode: "boolean" })
    .notNull()
    .default(false),
  /** JSON {provider,name} model override; null → settings.selectedModel. */
  model: text("model"),
  /** JSON poller state (github cursors / mcp result hash); null until first poll. */
  cursor: text("cursor"),
  lastRunAt: integer("last_run_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * One row per automation occurrence that some Atlarix process claimed (0077).
 * The desktop app and the CLI share this database and both run automations;
 * the primary key lets exactly one of them take each occurrence.
 */
export const automationLeases = sqliteTable(
  "automation_leases",
  {
    automationId: text("automation_id").notNull(),
    slotKey: text("slot_key").notNull(),
    owner: text("owner").notNull(),
    claimedAt: integer("claimed_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [primaryKey({ columns: [t.automationId, t.slotKey] })],
);

export const automationRuns = sqliteTable("automation_runs", {
  id: text("id").primaryKey(),
  automationId: text("automation_id")
    .notNull()
    .references(() => automations.id, { onDelete: "cascade" }),
  /** Transcript lives in a chat_sessions row with kind="background". */
  sessionId: text("session_id").references(() => chatSessions.id, {
    onDelete: "set null",
  }),
  status: text("status", {
    enum: ["running", "ok", "nothing-to-report", "error"],
  }).notNull(),
  summary: text("summary"),
  error: text("error"),
  unread: integer("unread", { mode: "boolean" }).notNull().default(true),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  /** The fired trigger's context (notify-only runs) — fuels "Send to chat". */
  triggerContext: text("trigger_context"),
  /**
   * DEPRECATED (v14.21.0) — the worktree-write run mode that populated these is
   * gone; nothing reads or writes them. Kept rather than dropped because a
   * failed DROP COLUMN on a user's database is a boot failure, and three unused
   * columns cost nothing. Remove only alongside a table rebuild.
   */
  proposalDiff: text("proposal_diff"),
  proposalFiles: text("proposal_files"),
  proposalAppliedAt: integer("proposal_applied_at", { mode: "timestamp" }),
  /** The process running it (runner.ts PROCESS_OWNER); null on rows from before 0077. */
  owner: text("owner"),
  /** Refreshed while the owner is alive; a stale beat means the run was interrupted. */
  heartbeatAt: integer("heartbeat_at", { mode: "timestamp" }),
  startedAt: integer("started_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
});

export const automationsRelations = relations(automations, ({ one, many }) => ({
  workspace: one(apps, {
    fields: [automations.workspaceId],
    references: [apps.id],
  }),
  runs: many(automationRuns),
}));

export const automationRunsRelations = relations(automationRuns, ({ one }) => ({
  automation: one(automations, {
    fields: [automationRuns.automationId],
    references: [automations.id],
  }),
  session: one(chatSessions, {
    fields: [automationRuns.sessionId],
    references: [chatSessions.id],
  }),
}));

// --- Edit stats -------------------------------------------------------------
// How much the agent has actually written, per workspace and per model.
//
// A daily ROLLUP rather than a row per edit: the counts are gross and only ever
// accumulate, so there is nothing a per-edit history would let us compute that a
// sum over these rows does not — and this shape stays bounded for the life of the
// install with no pruning job, and never puts a file path on disk.
export const editStats = sqliteTable(
  "edit_stats",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    /**
     * LOCAL calendar day, `YYYY-MM-DD`.
     *
     * Text, and local rather than UTC, because this column exists to be grouped by
     * and shown to a person: "today" has to mean the user's today. A UTC bucket
     * silently moves work done in the evening into tomorrow for most of the world.
     */
    day: text("day").notNull(),
    /**
     * The provider as DISPATCHED — `compass` for Atlarix Core, the vendor id for
     * BYOK. This is the whole discriminator behind "DeepSeek V4 Pro (Core)" vs
     * "DeepSeek V4 Pro (deepseek)": the two are the same model reached two ways,
     * and nothing else in the row can tell them apart.
     */
    provider: text("provider").notNull(),
    /**
     * The RESOLVED model id, never a Core tier id.
     *
     * Storing `core-3` would mean every past row silently relabels itself the next
     * time the Core lineup is repointed — last month's DeepSeek work would start
     * claiming to be whatever model took that slot. Resolving once, at write time,
     * makes each row permanently true.
     */
    modelId: text("model_id").notNull(),
    linesAdded: integer("lines_added").notNull().default(0),
    linesRemoved: integer("lines_removed").notNull().default(0),
    /** Accepted write operations, so an average edit size is derivable. */
    edits: integer("edits").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    unique("edit_stats_bucket_unique").on(
      table.workspaceId,
      table.day,
      table.provider,
      table.modelId,
    ),
    index("edit_stats_workspace_idx").on(table.workspaceId),
  ],
);

export const editStatsRelations = relations(editStats, ({ one }) => ({
  workspace: one(apps, {
    fields: [editStats.workspaceId],
    references: [apps.id],
  }),
}));
