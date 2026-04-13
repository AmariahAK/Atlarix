// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer, webFrame } from "electron";

// Whitelist of valid channels
const validInvokeChannels = [
  "analyze-component",
  "apply-visual-editing-changes",
  "get-language-models",
  "get-language-models-by-providers",
  "create-custom-language-model",
  "get-language-model-providers",
  "delete-custom-language-model-provider",
  "create-custom-language-model-provider",
  "edit-custom-language-model-provider",
  "delete-custom-language-model",
  "delete-custom-model",
  "chat:add-dep",
  "chat:message",
  "chat:cancel",
  "chat:stream",
  "chat:abort",  // User can stop AI to save tokens
  "chat:submit-question-answers",  // v3.9: submit clarifying-question answers and continue
  "chat:submit-user-question-answer", // ask_user tool: submit answer from UI
  "workspace:prewarm-cache",
  "chat:edit-message",             // v3.9: edit user message and truncate after
  "chat:revert-to-message",        // v3.9: revert conversation to assistant message
  "autonomous:revert-op",
  "autonomous:accept-all",
  "revert:snapshot",
  "snapshot:exists",
  "stream:open",                  // v3.9: open terminal/pipeline stream
  "stream:close",                 // v3.9: close stream
  "stream:get-lines",             // v3.9: get collected lines
  "stream:feed-terminal",         // v3.9: feed terminal output (main process)
  "github-actions:list-runs",
  "github-actions:get-jobs",
  "github-actions:get-logs",
  "github-actions:start-stream",
  "github-actions:stop-stream",
  "chat:count-tokens",
  "create-chat",
  "create-chat-only",
  "create-app",
  "copy-app",
  "get-chat",
  "get-chats",
  "search-chats",
  "get-chat-logs",
  "list-apps",
  "get-app",
  "get-app-env-vars",
  "set-app-env-vars",
  "edit-app-file",
  "read-app-file",
  "run-app",
  "stop-app",
  "restart-app",
  "respond-to-app-input",
  "search-app",
  "list-versions",
  "revert-version",
  "checkout-version",
  "get-current-branch",
  "delete-app",
  "rename-app",
  "get-user-settings",
  "set-user-settings",
  "routing:preview",
  "hooks:list",
  "hooks:create",
  "hooks:update",
  "hooks:delete",
  "hooks:toggle",
  "commands:list",
  "commands:create",
  "commands:update",
  "commands:delete",
  "counsel:start",
  "counsel:cancel",
  "get-env-vars",
  "get-db-ready",
  "open-external-url",
  "show-item-in-folder",
  "reset-all",
  "nodejs-status",
  "install-node",
  "select-node-folder",
  "github:start-flow",
  "github:list-repos",
  "github:get-repo-branches",
  "github:is-repo-available",
  "github:create-repo",
  "github:connect-existing-repo",
  "github:push",
  "github:disconnect",
  "neon:create-project",
  "neon:get-project",
  "neon:delete-branch",
  "vercel:save-token",
  "vercel:list-projects",
  "vercel:is-project-available",
  "vercel:create-project",
  "vercel:connect-existing-project",
  "vercel:get-deployments",
  "vercel:disconnect",
  "get-app-version",
  "get-sentry-config",
  "get-posthog-config",
  "reload-env-path",
  "get-proposal",
  "approve-proposal",
  "reject-proposal",
  "get-system-debug-info",
  "supabase:list-projects",
  "supabase:list-branches",
  "supabase:set-app-project",
  "supabase:unset-app-project",
  "local-models:list-ollama",
  "local-models:list-lmstudio",
  "window:minimize",
  "window:maximize",
  "window:close",
  "get-system-platform",
  "system:get-hardware-profile",
  "ollama:get-recommendations",
  "ollama:pull-model",
  "upload-to-signed-url",
  "delete-chat",
  "update-chat",
  "delete-messages",
  "start-chat-stream",
  "does-release-note-exist",
  "import-app",
  "select-app-folder",
  "check-app-name",
  "rename-branch",
  "clear-session-data",
  "get-user-budget",
  "get-context-paths",
  "set-context-paths",
  "get-app-upgrades",
  "execute-app-upgrade",
  "respond-mode-change",
  "respond-workspace-permissions",
  "is-capacitor",
  "sync-capacitor",
  "open-ios",
  "open-android",
  "check-problems",
  "restart-dyad",
  "get-templates",
  "list-templates",
  "portal:migrate-create",
  // MCP
  "mcp:list-servers",
  "mcp:create-server",
  "mcp:update-server",
  "mcp:delete-server",
  "mcp:list-tools",
  "mcp:test-connection",
  "mcp:get-tool-consents",
  "mcp:set-tool-consent",
  // MCP consent response from renderer to main
  "mcp:tool-consent-response",
  // Help
  "take-screenshot",
  // Help bot
  "help:chat:start",
  "help:chat:cancel",
  // Prompts (Global + Workspace system)
  "prompts:get-global",
  "prompts:set-global",
  "prompts:delete-global",
  "prompts:get-workspace",
  "prompts:set-workspace",
  "prompts:delete-workspace",
  "prompts:delete",
  "prompts:list-workspaces-with-status",
  // Legacy (deprecated)
  "prompts:list",
  "prompts:create",
  "prompts:update",
  // adding app to favorite
  "add-to-favorite",
  "github:clone-repo-from-url",
  "get-latest-security-review",
  // Provider API Keys
  "provider:get-api-key",
  "provider:set-api-key",
  "provider:delete-api-key",
  "provider:get-configured",
  // OpenRouter Favorites
  "openrouter:get-favorites",
  "openrouter:set-favorites",
  "openrouter:add-favorite",
  "openrouter:remove-favorite",
  "openrouter:is-favorited",
  "compass:is-build-configured",
  "compass:get-usage",
  // Models.dev (dynamic model catalog)
  "models-dev:refresh",
  // Codebase search
  "search-codebase",
  // Workspace snapshots (Pro)
  "workspace-snapshot:create",
  "workspace-snapshot:list",
  "workspace-snapshot:restore",
  "workspace-snapshot:get-metadata",
  // Dialog
  "dialog:openDirectory",
  // SearxNG
  "searxng:health-check",
  "searxng:validate-url",
  "searxng:search",
  "searxng:get-config",
  "searxng:set-config",
  "searxng:delete-config",
  // SearxNG Auto-Setup
  "searxng:check-docker",
  "searxng:check-status",
  "searxng:setup",
  "searxng:stop",
  "searxng:logs",
  // Test-only channels
  // These should ALWAYS be guarded with IS_TEST_BUILD in the main process.
  // We can't detect with IS_TEST_BUILD in the preload script because
  // it's a separate process from the main process.
  "supabase:fake-connect-and-set-project",
  // Permission system (Build mode)
  "execute-permission",
  "reject-permission",
  "execute-all-permissions",
  "reject-all-permissions",
  "get-pending-permissions",
  // Diagram system
  "diagram:list",
  "diagram:get",
  "diagram:generate",
  "diagram:generate-ai",
  "diagram:update",
  "diagram:delete",
  "diagram:check-staleness",
  "diagram:mark-stale",
  // Dev Server (Live Preview)
  "dev-server:is-frontend",
  "dev-server:start",
  "dev-server:stop",
  "dev-server:status",
  "dev-server:list-running",
  // Diagram Timeline (Project Evolution)
  "diagram:capture-snapshot",
  "diagram:get-timeline",
  "diagram:get-detailed-timeline",
  "diagram:get-snapshot",
  "diagram:annotate-snapshot",
  "diagram:delete-snapshot",
  "diagram:compress-old",
  "diagram:compress-all",
  "diagram:queue-capture",
  "diagram:flush-pending",
  "diagram:capture-initial",
  "snapshots:diagram-timeline",
  "snapshots:revert-diagram",
  // Blueprint (Phase 7 Additive Blueprint)
  "blueprint:get",
  "blueprint:set",
  "blueprint:get-reference-paths",
  "blueprint:set-reference-paths",
  "blueprint:refresh-from-code",
  "blueprint:get-atlarixignore",
  "blueprint:set-atlarixignore",
  "blueprint:analyze-workspace",
  "blueprint:generate-combined",
  "blueprint:codegen",
  "blueprint:simplify-description",
  "blueprint:simplify-room",
  "blueprint:simplify-architecture",
  "blueprint:layout-containers",
  "blueprint:layout-beacons",
  "blueprint:cluster",
  "pivot:run-analysis",
  "pivot:get-nodes-edges",
  "pivot:get-snapshots",
  "pivot:restore-snapshot",
  // File operations (Live Code Editor)
  "file:read-content",
  "file:write-content",
  "file:get-stats",
  // Auth (OAuth Sign-In)
  "auth:sign-in",
  "auth:sign-out",
  "auth:get-current-user",
  "auth:can-create-workspace",
  "auth:check-workspace-limit",  // Workspace limit check for Free tier
  "auth:enforce-workspace-limit", // Enforce workspace limit on login
  "auth:get-plan-info",
  "auth:upgrade",
  "auth:upgrade-workforce",
  "auth:refresh-plan",
  "auth:manage-subscription",
  "auth:cancel-subscription",
  "onboarding:get-completed",
  "onboarding:set-completed",
  "tour:get-state",
  "tour:set-state",
  // DB Extension (Pro / Workforce preview)
  "db:list-connections",
  "db:save-connection",
  "db:delete-connection",
  "db:connect",
  "db:disconnect",
  "db:get-schema",
  "db:run-query",
  "db:get-table-data",
  "db:set-active-connection",
  "db:test-connection",
  "db:parse-connection-string",
  // v4.0 Token Vault (Workforce)
  "token-vault:get-token",
  "token-vault:revoke",
  "token-vault:list-services",
  "token-vault:start-connect",
  "token-vault:clear-all-sessions",
  "workforce:session:get",
  "workforce:session:set-scope",
  "workforce:session:clear",
  "workforce:session:complete-prompt",
  // v4.0 Teams (Workforce)
  "team:get",
  "team:list-members",
  "team:get-pending-invites",
  "team:invite",
  "team:accept-invite",
  "team:reject-invite",
  "team:leave",
  "team:remove-member",
  "team:add-seats",
  "team:send-test-email",
  // Community (Discord)
  "discord:get-invite-info",
  // Auto-updater
  "update:defer",        // write defer flag to userData; install on next cold start
  "update:install-now",  // quit and install downloaded update immediately
];

const validReceiveChannels = [
  "chat:response:chunk",
  "chat:response:end",
  "chat:response:error",
  "chat:tool:start",
  "chat:tool:end",
  "chat:stream:phase",
  "models-dev:status",
  "window:fullscreen-changed",
  "app:output",
  "github:flow-update",
  "github:flow-success",
  "github:flow-error",
  "deep-link-received",
  "plan-changed",              // Realtime plan updates from Supabase
  "oauth-callback-success",    // OAuth callback from main process
  "force-close-detected",
  "db-ready",                  // Main: DB initialized, renderer can show app
  // Help bot
  "help:chat:response:chunk",
  "help:chat:response:end",
  "help:chat:response:error",
  // MCP consent request from main to renderer
  "mcp:tool-consent-request",
  // Permission system (Build mode)
  "permission-request",
  "workforce:prompt-session-scope",
  "user-question-request", // ask_user: show question + options in chat UI
  "mode_change_requested",
  "mode:changed",
  "terminal-output",
  "operation-status",         // Permission queue status updates
  // v4.0 Token Vault (Workforce)
  "token-vault:consent-required",
  "token-vault:fallback-warning",
  "token-vault:connected",
  "auto-recovery-needed",     // AI self-healing on failures
  "chat:workspace-diagram",
  // AI-controlled right panel (Hybrid Intent System)
  "right-panel:set-intent",  // New: semantic intent-based
  "right-panel:set-view",    // Legacy: kept for backwards compatibility
  // Dev server output streaming
  "dev-server:output",       // Live dev server console output
  // Browser console error capture (CDP debugger)
  "browser-console-error",   // Console errors from Electron debugger
  "browser-console-cleared", // Console buffer cleared after success (Fix 2: errors not clearing)
  // Diagram staleness notification
  "diagram:staleness-detected", // Diagram outdated due to code changes
  "diagram:initial-ready",      // Cold start: initial diagram generated
  // Smart Agentic Loop (iteration progress)
  "chat:iteration:progress",    // Progress updates (iteration count, tools)
  "chat:iteration:warning",     // Warning: task running long, continue?
  "chat:iteration:limit-reached", // Hit max iterations
  "chat:iteration:timeout",     // Hit time limit (10 min)
  // v2.1: Activity Stream (model selection, delegation, compaction, tool use)
  "chat:activity",
  "chat:plan-update",
  "counsel:participant-update",
  "counsel:complete",
  "autonomous:session-complete",
  // v3.9: Clarifying questions from AI (render QuestionsWidget)
  "chat:questions",
  "chat:auto-self-correct", // main → renderer: synthetic fix prompt inserted; continue stream
  // Blueprint: AI editing indicator (Diagram tab)
  "blueprint:ai-editing",
  "blueprint:updated",
  "blueprint:rte-running",
  "blueprint:edges-updated",
  // OAuth callback from main process
  "oauth-callback-success",
  // v3.9: GitHub Actions log stream
  "github-actions:log-chunk",
  "open-community-dialog",
  // Auto-updater
  "update:downloading",   // update is being fetched in background; payload: { version: string }
  "update:downloaded",    // update ready to install; payload: { version: string }
] as const;

type ValidInvokeChannel = (typeof validInvokeChannels)[number];
type ValidReceiveChannel = (typeof validReceiveChannels)[number];

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electron", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  ipcRenderer: {
    invoke: (channel: ValidInvokeChannel, ...args: unknown[]) => {
      if (validInvokeChannels.includes(channel)) {
        return ipcRenderer.invoke(channel, ...args);
      }
      throw new Error(`Invalid channel: ${channel}`);
    },
    on: (
      channel: ValidReceiveChannel,
      listener: (...args: unknown[]) => void,
    ) => {
      if (validReceiveChannels.includes(channel)) {
        const subscription = (
          _event: Electron.IpcRendererEvent,
          ...args: unknown[]
        ) => listener(...args);
        ipcRenderer.on(channel, subscription);
        return () => {
          ipcRenderer.removeListener(channel, subscription);
        };
      }
      throw new Error(`Invalid channel: ${channel}`);
    },
    removeAllListeners: (channel: ValidReceiveChannel) => {
      if (validReceiveChannels.includes(channel)) {
        ipcRenderer.removeAllListeners(channel);
      }
    },
    removeListener: (
      channel: ValidReceiveChannel,
      listener: (...args: unknown[]) => void,
    ) => {
      if (validReceiveChannels.includes(channel)) {
        ipcRenderer.removeListener(channel, listener);
      }
    },
  },
  webFrame: {
    setZoomFactor: (factor: number) => {
      webFrame.setZoomFactor(factor);
    },
    getZoomFactor: () => webFrame.getZoomFactor(),
  },
});
