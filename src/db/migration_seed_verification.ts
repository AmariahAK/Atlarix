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
    case "0032_pivot_tables":
      return (
        tableExists(sqlite, "pivot_nodes") &&
        tableExists(sqlite, "pivot_edges") &&
        tableExists(sqlite, "pivot_containers") &&
        tableExists(sqlite, "pivot_beacons") &&
        tableExists(sqlite, "blueprint_snapshots")
      );
    case "0033_rename_type_columns":
      return (
        columnExists(sqlite, "pivot_nodes", "node_type") &&
        columnExists(sqlite, "pivot_edges", "edge_type") &&
        columnExists(sqlite, "diagrams", "diagram_type")
      );
    case "0034_prompts_new_schema":
      return (
        columnExists(sqlite, "prompts", "type") &&
        !columnExists(sqlite, "prompts", "title")
      );
    case "0035_unified_snapshots_revert":
      return (
        columnExists(sqlite, "diagram_versions", "chat_turn_id") &&
        columnExists(sqlite, "diagrams", "last_snapshot_hashes") &&
        columnExists(sqlite, "messages", "is_reverted")
      );
    case "0036_auto_routed_tier":
      return columnExists(sqlite, "messages", "auto_routed_tier");
    case "0037_compaction_nested_and_synthetic":
      return (
        columnExists(sqlite, "chat_context_summaries", "compaction_generation") &&
        columnExists(sqlite, "messages", "is_synthetic")
      );
    case "0038_counsel_sessions":
      return tableExists(sqlite, "counsel_sessions");
    case "0039_atlarix_hooks":
      return tableExists(sqlite, "atlarix_hooks");
    case "0040_custom_commands":
      return tableExists(sqlite, "custom_commands");
    case "0041_drop_diagram_versions":
      return !tableExists(sqlite, "diagram_versions");
    case "0042_installed_skills":
      return columnExists(sqlite, "installed_skills", "scope");
    case "0043_mcp_registry_columns":
      return columnExists(sqlite, "mcp_servers", "from_registry");
    case "0044_messages_work_mode":
      return columnExists(sqlite, "messages", "work_mode");
    case "0045_chat_sessions":
      return (
        tableExists(sqlite, "chat_sessions") &&
        tableExists(sqlite, "session_messages")
      );
    case "0046_mcp_api_key":
      return columnExists(sqlite, "mcp_servers", "api_key");
    case "0047_drop_blueprints_table":
      return !tableExists(sqlite, "blueprints");
    case "0048_session_plan_artifacts":
      return (
        columnExists(sqlite, "session_messages", "kind") &&
        columnExists(sqlite, "session_messages", "plan_status")
      );
    case "0049_workspace_only_remote":
      return true;
    case "0050_drop_prompts_table":
      return !tableExists(sqlite, "prompts");
    case "0051_display_snapshot":
      return (
        columnExists(sqlite, "messages", "display_snapshot") &&
        columnExists(sqlite, "session_messages", "display_snapshot")
      );
    case "0052_message_model_content":
      return columnExists(sqlite, "messages", "model_content");
    case "0053_message_paste_attachments":
      return columnExists(sqlite, "messages", "paste_attachments");
    case "0054_message_file_attachments":
      return columnExists(sqlite, "messages", "file_attachments");
    case "0055_session_message_attachments":
      return (
        columnExists(sqlite, "session_messages", "model_content") &&
        columnExists(sqlite, "session_messages", "file_attachments")
      );
    case "0056_workspace_command_permissions":
      return tableExists(sqlite, "workspace_command_permissions");
    case "0057_workspace_file_permissions":
      return tableExists(sqlite, "workspace_file_permissions");
    case "0058_session_stream_and_drop_legacy_chats":
      return (
        columnExists(sqlite, "chat_sessions", "stream_chat_id") &&
        !tableExists(sqlite, "chats") &&
        !tableExists(sqlite, "messages")
      );
    case "0059_mcp_oauth_columns":
      return (
        columnExists(sqlite, "mcp_servers", "auth_type") &&
        columnExists(sqlite, "mcp_servers", "oauth_tokens_json") &&
        columnExists(sqlite, "mcp_servers", "oauth_client_json") &&
        columnExists(sqlite, "mcp_servers", "oauth_discovery_json")
      );
    case "0060_background_agent_session_status":
      return (
        columnExists(sqlite, "chat_sessions", "kind") &&
        columnExists(sqlite, "chat_sessions", "status") &&
        columnExists(sqlite, "chat_sessions", "status_error")
      );
    case "0061_background_agent_meta":
      return columnExists(sqlite, "chat_sessions", "agent_meta");
    case "0062_drop_legacy_diagram_tables":
      return (
        !tableExists(sqlite, "diagrams") &&
        !tableExists(sqlite, "workspace_diagrams")
      );
    case "0063_session_message_snapshot_turn":
      return columnExists(sqlite, "session_messages", "snapshot_turn_id");
    case "0071_automation_notify_agent":
      return columnExists(sqlite, "automations", "notify_agent");
    case "0072_automation_pipeline_trigger":
      // A data migration, not DDL — "applied" means no legacy github trigger
      // is left. Vacuously true on a fresh DB, which is correct.
      return (
        tableExists(sqlite, "automations") &&
        !(
          sqlite
            .prepare(
              "SELECT 1 FROM automations WHERE json_valid(trigger) AND json_extract(trigger,'$.kind')='github' LIMIT 1",
            )
            .get() as unknown
        )
      );
    case "0073_session_message_plan_title":
      return columnExists(sqlite, "session_messages", "title");
    case "0074_chat_session_work_mode":
      return columnExists(sqlite, "chat_sessions", "work_mode");
    default:
      return false;
  }
}
