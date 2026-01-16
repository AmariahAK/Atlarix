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
  "get-env-vars",
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
  "upload-to-signed-url",
  "delete-chat",
  "update-chat",
  "delete-messages",
  "start-chat-stream",
  "does-release-note-exist",
  "import-app",
  "check-ai-rules",
  "select-app-folder",
  "check-app-name",
  "rename-branch",
  "clear-session-data",
  "get-user-budget",
  "get-context-paths",
  "set-context-paths",
  "get-app-upgrades",
  "execute-app-upgrade",
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
  "diagram:history",
  "diagram:restore",
  "diagram:check-staleness",
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
  "auth:refresh-plan",
  "auth:manage-subscription",
  "auth:cancel-subscription",
];

const validReceiveChannels = [
  "chat:response:chunk",
  "chat:response:end",
  "chat:response:error",
  "app:output",
  "github:flow-update",
  "github:flow-success",
  "github:flow-error",
  "deep-link-received",
  "plan-changed",              // Realtime plan updates from Supabase
  "oauth-callback-success",    // OAuth callback from main process
  "force-close-detected",
  // Help bot
  "help:chat:response:chunk",
  "help:chat:response:end",
  "help:chat:response:error",
  // MCP consent request from main to renderer
  "mcp:tool-consent-request",
  // Permission system (Build mode)
  "permission-request",
  "terminal-output",
  "operation-status",         // Permission queue status updates
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
  // OAuth callback from main process
  "oauth-callback-success",
] as const;

type ValidInvokeChannel = (typeof validInvokeChannels)[number];
type ValidReceiveChannel = (typeof validReceiveChannels)[number];

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electron", {
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
