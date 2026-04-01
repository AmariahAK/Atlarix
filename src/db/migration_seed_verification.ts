import type Database from "better-sqlite3";

/**
 * When `__drizzle_migrations` is empty but the DB already has legacy tables, we must not
 * insert every journal hash (that skips real migrations). We only mark a migration as
 * applied when its effects are visible in sqlite_master / PRAGMA table_info.
 *
 * Add a branch here whenever a new file is appended to drizzle/meta/_journal.json.
 */
export function tableExists(sqlite: Database.Database, name: string): boolean {
  return !!sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

export function columnExists(
  sqlite: Database.Database,
  table: string,
  column: string,
): boolean {
  if (!tableExists(sqlite, table)) return false;
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

/** True if this journal migration's DDL is already reflected in the database. */
export function isJournalMigrationApplied(
  tag: string,
  sqlite: Database.Database,
): boolean {
  switch (tag) {
    case "0000_nebulous_proemial_gods":
      return (
        tableExists(sqlite, "apps") &&
        tableExists(sqlite, "chats") &&
        tableExists(sqlite, "messages")
      );
    case "0001_hesitant_roland_deschain":
      return columnExists(sqlite, "messages", "approval_state");
    case "0002_unique_morlocks":
      return columnExists(sqlite, "apps", "supabase_project_id");
    case "0003_open_bucky":
      return columnExists(sqlite, "messages", "commit_hash");
    case "0004_flawless_jigsaw":
      return columnExists(sqlite, "chats", "initial_commit_hash");
    case "0005_clumsy_namor":
      return (
        tableExists(sqlite, "language_model_providers") &&
        tableExists(sqlite, "language_models")
      );
    case "0006_mushy_squirrel_girl":
      return columnExists(sqlite, "apps", "chat_context");
    case "0007_dapper_overlord":
      return columnExists(sqlite, "apps", "github_branch");
    case "0008_medical_vulcan":
      return columnExists(sqlite, "apps", "vercel_project_id");
    case "0009_previous_misty_knight":
      return (
        tableExists(sqlite, "versions") && columnExists(sqlite, "apps", "neon_project_id")
      );
    case "0010_nappy_fat_cobra":
      return columnExists(sqlite, "apps", "install_command");
    case "0011_light_zeigeist":
      return tableExists(sqlite, "prompts");
    case "0012_bouncy_fenris":
      return tableExists(sqlite, "mcp_servers") && tableExists(sqlite, "mcp_tool_consents");
    case "0013_damp_mephistopheles":
      return columnExists(sqlite, "apps", "is_favorite");
    case "0014_needy_vertigo":
      return columnExists(sqlite, "messages", "request_id");
    case "0015_complete_old_lace":
      return columnExists(sqlite, "apps", "supabase_parent_project_id");
    case "0016_petite_thanos":
      return columnExists(sqlite, "messages", "source_commit_hash");
    case "0017_sharp_corsair":
      return columnExists(sqlite, "messages", "max_tokens_used");
    case "0018_slim_rictor":
      return tableExists(sqlite, "provider_api_keys");
    case "0019_pale_aqueduct":
      return tableExists(sqlite, "openrouter_favorites");
    case "0020_luxuriant_exiles":
      return (
        tableExists(sqlite, "cleanup_log") &&
        tableExists(sqlite, "workspace_modifications") &&
        columnExists(sqlite, "chats", "last_used_at")
      );
    case "0021_search_providers":
      return tableExists(sqlite, "search_providers");
    case "0022_add_diagrams":
      return tableExists(sqlite, "diagrams") && tableExists(sqlite, "diagram_versions");
    case "0023_faulty_diamondback":
      return (
        tableExists(sqlite, "daily_logs") &&
        tableExists(sqlite, "workspace_diagrams") &&
        columnExists(sqlite, "apps", "preferred_diagram_type") &&
        columnExists(sqlite, "diagram_versions", "trigger")
      );
    case "0024_workspace_snapshots":
      return tableExists(sqlite, "workspace_snapshots");
    case "0025_chat_context_summaries":
      return tableExists(sqlite, "chat_context_summaries");
    case "0026_mcp_workspace_scope":
      return (
        columnExists(sqlite, "mcp_servers", "scope") &&
        columnExists(sqlite, "mcp_servers", "app_id")
      );
    case "0027_workflow_templates":
      return tableExists(sqlite, "workflow_templates");
    case "0028_blueprints":
      return tableExists(sqlite, "blueprints");
    case "0029_v39_clarify_revert":
      return (
        columnExists(sqlite, "chats", "has_answered_questions") &&
        columnExists(sqlite, "messages", "exchange_index") &&
        columnExists(sqlite, "messages", "snapshot_id") &&
        columnExists(sqlite, "messages", "files_written")
      );
    case "0030_v40_tool_session_loads":
      return tableExists(sqlite, "tool_session_loads");
    case "0031_project_memory":
      return tableExists(sqlite, "project_snapshots") && tableExists(sqlite, "project_memory");
    case "0032_prompts_type_workspace":
      return (
        columnExists(sqlite, "prompts", "type") &&
        columnExists(sqlite, "prompts", "workspace_id")
      );
    default:
      return false;
  }
}
