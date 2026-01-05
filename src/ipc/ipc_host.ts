import { registerAppHandlers } from "./handlers/app_handlers";
import { registerChatHandlers } from "./handlers/chat_handlers";
import { registerChatStreamHandlers } from "./handlers/chat_stream_handlers";
import { registerSettingsHandlers } from "./handlers/settings_handlers";
import { registerShellHandlers } from "./handlers/shell_handler";
import { registerGithubHandlers } from "./handlers/github_handlers";
import { registerVercelHandlers } from "./handlers/vercel_handlers";
import { registerNodeHandlers } from "./handlers/node_handlers";
import { registerProposalHandlers } from "./handlers/proposal_handlers";
import { registerDebugHandlers } from "./handlers/debug_handlers";
import { registerSupabaseHandlers } from "./handlers/supabase_handlers";
import { registerNeonHandlers } from "./handlers/neon_handlers";
import { registerLocalModelHandlers } from "./handlers/local_model_handlers";
import { registerTokenCountHandlers } from "./handlers/token_count_handlers";
import { registerWindowHandlers } from "./handlers/window_handlers";
import { registerUploadHandlers } from "./handlers/upload_handlers";
import { registerVersionHandlers } from "./handlers/version_handlers";
import { registerLanguageModelHandlers } from "./handlers/language_model_handlers";
import { registerProviderApiKeyHandlers } from "./handlers/provider_api_key_handlers";
import { registerOpenRouterFavoritesHandlers } from "./handlers/openrouter_favorites_handlers";
import { registerReleaseNoteHandlers } from "./handlers/release_note_handlers";
import { registerImportHandlers } from "./handlers/import_handlers";
import { registerSessionHandlers } from "./handlers/session_handlers";
import { registerProHandlers } from "./handlers/pro_handlers";
import { registerContextPathsHandlers } from "./handlers/context_paths_handlers";
import { registerAppUpgradeHandlers } from "./handlers/app_upgrade_handlers";
import { registerCapacitorHandlers } from "./handlers/capacitor_handlers";
import { registerProblemsHandlers } from "./handlers/problems_handlers";
import { registerAppEnvVarsHandlers } from "./handlers/app_env_vars_handlers";
import { registerTemplateHandlers } from "./handlers/template_handlers";
import { registerPortalHandlers } from "./handlers/portal_handlers";
import { registerPromptHandlers } from "./handlers/prompt_handlers";
import { registerHelpBotHandlers } from "./handlers/help_bot_handlers";
import { registerMcpHandlers } from "./handlers/mcp_handlers";
import { registerSecurityHandlers } from "./handlers/security_handlers";
import { registerVisualEditingHandlers } from "../pro/main/ipc/handlers/visual_editing_handlers";
import { registerFolderDialogHandler } from "./handlers/atlarix_handlers";
import { registerSearxngHandlers } from "./handlers/searxng_handlers";
import { registerSearxngSetupHandlers, registerSearxngAutoStop } from "./handlers/searxng_setup_handlers";
import { registerDiagramTimelineHandlers } from "./handlers/diagram_timeline_handlers";
import "./handlers/diagram_handlers"; // Auto-registers on import
import "./handlers/dev_server_handlers"; // Auto-registers on import (Lovable-style live preview)

export function registerIpcHandlers() {
  // Register all IPC handlers by category
  registerAppHandlers();
  registerChatHandlers();
  registerChatStreamHandlers();
  registerSettingsHandlers();
  registerShellHandlers();
  registerGithubHandlers();
  registerVercelHandlers();
  registerNodeHandlers();
  registerProblemsHandlers();
  registerProposalHandlers();
  registerDebugHandlers();
  registerSupabaseHandlers();
  registerNeonHandlers();
  registerLocalModelHandlers();
  registerTokenCountHandlers();
  registerWindowHandlers();
  registerUploadHandlers();
  registerVersionHandlers();
  registerLanguageModelHandlers();
  registerProviderApiKeyHandlers();
  registerOpenRouterFavoritesHandlers();
  registerReleaseNoteHandlers();
  registerImportHandlers();
  registerSessionHandlers();
  registerProHandlers();
  registerContextPathsHandlers();
  registerAppUpgradeHandlers();
  registerCapacitorHandlers();
  registerAppEnvVarsHandlers();
  registerTemplateHandlers();
  registerPortalHandlers();
  registerPromptHandlers();
  registerHelpBotHandlers();
  registerMcpHandlers();
  registerSecurityHandlers();
  registerVisualEditingHandlers();
  // Atlarix handlers
  registerFolderDialogHandler();
  registerSearxngHandlers();
  registerSearxngSetupHandlers();
  registerSearxngAutoStop(); // Auto-stop Docker container when app quits
  registerDiagramTimelineHandlers(); // Diagram timeline system
}
