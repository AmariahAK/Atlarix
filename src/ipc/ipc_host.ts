import { registerAppHandlers } from "./handlers/app_handlers";
import { registerChatHandlers } from "./handlers/chat_handlers";
import { registerChatStreamHandlers } from "./handlers/chat_stream_handlers";
import { registerSettingsHandlers } from "./handlers/settings_handlers";
import { registerShellHandlers } from "./handlers/shell_handler";
import { registerTerminalHandlers } from "./handlers/terminal_handlers";
import { registerTerminalInstancesHandlers } from "./handlers/terminal_instances_handlers";
import { registerPtyHandlers } from "./handlers/pty_handlers";
import { registerCliHandlers } from "./handlers/cli_handlers";
import { registerGithubHandlers } from "./handlers/github_handlers";
import { registerNodeHandlers } from "./handlers/node_handlers";
import { registerProposalHandlers } from "./handlers/proposal_handlers";
import { registerDebugHandlers } from "./handlers/debug_handlers";
import { registerLocalModelHandlers } from "./handlers/local_model_handlers";
import { registerTokenCountHandlers } from "./handlers/token_count_handlers";
import { registerWindowHandlers } from "./handlers/window_handlers";
import { registerUploadHandlers } from "./handlers/upload_handlers";
import { registerVersionHandlers } from "./handlers/version_handlers";
import { registerLanguageModelHandlers } from "./handlers/language_model_handlers";
import { registerProviderApiKeyHandlers } from "./handlers/provider_api_key_handlers";
import { registerOpenRouterFavoritesHandlers } from "./handlers/openrouter_favorites_handlers";
import { registerCompassHandlers } from "./handlers/compass_handlers";
import { registerReleaseNoteHandlers } from "./handlers/release_note_handlers";
import { registerImportHandlers } from "./handlers/import_handlers";
import { registerSessionHandlers } from "./handlers/session_handlers";
import { registerWorkspaceSessionHandlers } from "./handlers/workspace_session_handlers";
import { registerDisplaySnapshotHandlers } from "./handlers/display_snapshot_handlers";
import { registerProHandlers } from "./handlers/pro_handlers";
import { registerAppEnvVarsHandlers } from "./handlers/app_env_vars_handlers";
import { registerPortalHandlers } from "./handlers/portal_handlers";
import { registerHelpBotHandlers } from "./handlers/help_bot_handlers";
import { registerMcpHandlers } from "./handlers/mcp_handlers";
import { registerMcpOAuthHandlers } from "./handlers/mcp_oauth_handlers";
import { registerBrowserHandlers } from "./handlers/browser_handlers";
import { registerBackgroundHandlers } from "./handlers/background_handlers";
import { registerAutomationHandlers } from "./handlers/automation_handlers";
import { registerVoiceHandlers } from "./handlers/voice_handlers";
import { registerSkillsHandlers } from "./handlers/skills_handlers";
import { registerVisualEditingHandlers } from "../pro/main/ipc/handlers/visual_editing_handlers";
import { registerFolderDialogHandler } from "./handlers/atlarix_handlers";
import { registerSearxngHandlers } from "./handlers/searxng_handlers";
import { registerFileHandlers } from "./handlers/file_handlers";
import { registerAuthHandlers } from "./handlers/auth_handlers";
import { registerCodebaseSearchHandlers } from "./handlers/codebase_search_handlers";
import { registerWorkspaceSnapshotHandlers } from "./handlers/workspace_snapshot_handlers";
import { registerStreamHandlers } from "./handlers/stream_handlers";
import { registerTourHandlers } from "./handlers/tour_handlers";
import { registerCommunityHandlers } from "./handlers/community_handlers";
import { registerCommandPermissionHandlers } from "./handlers/command_permission_handlers";
import { registerFilePermissionHandlers } from "./handlers/file_permission_handlers";
import { registerPlanArtifactHandlers } from "./handlers/plan_artifact_handlers";
import { registerRemoteSshHandlers } from "../main/remote-ssh/remote_ssh_handlers";
import "./handlers/dev_server_handlers"; // Auto-registers on import (Lovable-style live preview)

export function registerIpcHandlers() {
  // Register all IPC handlers by category
  registerAppHandlers();
  registerChatHandlers();
  registerWorkspaceSessionHandlers();
  registerDisplaySnapshotHandlers();
  registerChatStreamHandlers();
  registerSettingsHandlers();
  registerShellHandlers();
  registerTerminalHandlers();
  registerTerminalInstancesHandlers();
  registerPtyHandlers(); // v10 interactive terminal
  registerCliHandlers();
  registerGithubHandlers();
  registerNodeHandlers();
  registerProposalHandlers();
  registerDebugHandlers();
  registerLocalModelHandlers();
  registerTokenCountHandlers();
  registerWindowHandlers();
  registerUploadHandlers();
  registerVersionHandlers();
  registerLanguageModelHandlers();
  registerProviderApiKeyHandlers();
  registerOpenRouterFavoritesHandlers();
  registerCompassHandlers();
  registerReleaseNoteHandlers();
  registerImportHandlers();
  registerRemoteSshHandlers();
  registerSessionHandlers();
  registerProHandlers();
  registerAppEnvVarsHandlers();
  registerPortalHandlers();
  registerHelpBotHandlers();
  registerMcpHandlers();
  registerMcpOAuthHandlers();
  registerSkillsHandlers();
  registerVisualEditingHandlers();
  // Atlarix handlers
  registerFolderDialogHandler();
  registerSearxngHandlers();
  registerFileHandlers(); // File read/write for live code editor
  registerAuthHandlers(); // OAuth & user plan management
  registerCodebaseSearchHandlers(); // Codebase semantic search
  registerWorkspaceSnapshotHandlers(); // Workspace snapshots (Pro)
  registerStreamHandlers(); // v3.9 Stream tools (terminal/pipeline)
  registerTourHandlers(); // Shepherd tour state (electron-store–style local JSON)
  registerCommunityHandlers(); // Discord invite metadata for Community dialog
  registerPlanArtifactHandlers();
  registerCommandPermissionHandlers();
  registerFilePermissionHandlers();
  registerBrowserHandlers(); // v11 in-app browser (WebContentsView) + WebMCP
  registerBackgroundHandlers(); // v14 background-job indicator/cancel + auto-wake
  registerAutomationHandlers(); // Automations: definitions CRUD + triage feed + proposal apply
  registerVoiceHandlers(); // BYOK cloud transcription (optional; local Whisper is default)
}
