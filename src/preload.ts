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
  "chat:stream:reconnect", // FIX 4: re-dispatch the last chat:stream after silent retries failed
  "chat:abort",  // User can stop AI to save tokens
  "chat:submit-user-question-answer", // ask_user tool: submit answer from UI
  "workspace:prewarm-cache",
  "workspace:open-in-new-window",
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
  "chat:clear-ephemeral-messages",
  "chat:hydrate-ephemeral-messages",
  "sessions:list",
  "sessions:create",
  "sessions:rename",
  "sessions:delete",
  "sessions:get",
  "sessions:generate-title",
  "messages:add",
  "messages:save-display-snapshot",
  "session-messages:save-display-snapshot",
  "chat:set-display-snapshot",
  "create-app",
  "copy-app",
  "get-chat",
  "get-chats",
  "search-chats",
  "get-chat-logs",
  "list-apps",
  "get-app",
  "get-app-files",
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
  "perf:tool-snapshot",
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
  "ollama:llm-checker-available",
  "ollama:pull-model",
  "ollama:remove-model",
  "upload-to-signed-url",
  "delete-chat",
  "update-chat",
  "delete-messages",
  "start-chat-stream",
  "does-release-note-exist",
  "import-app",
  "apps:touch-last-opened",
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
  "is-capacitor",
  "sync-capacitor",
  "open-ios",
  "open-android",
  "restart-atlarix",
  "get-templates",
  "list-templates",
  "portal:migrate-create",
  // MCP
  "mcp:list-servers",
  "mcp:list-orphaned-servers",
  "mcp:create-server",
  "mcp:update-server",
  "mcp:delete-server",
  "mcp:list-tools",
  "mcp:test-connection",
  "mcp:get-tool-consents",
  "mcp:set-tool-consent",
  "mcps:fetch-registry",
  "mcps:install-from-registry",
  // Skills
  "skills:fetch-registry",
  "skills:install",
  "skills:uninstall",
  "skills:list",
  "skills:list-orphaned",
  "skills:get-active-for-session",
  "skills:list-repo-skills",
  // MCP consent response from renderer to main
  "mcp:tool-consent-response",
  // Help
  "take-screenshot",
  // Help bot
  "help:chat:start",
  "help:chat:cancel",
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
  "plans:create",
  "plans:update",
  "plans:get",
  "plans:list-by-session",
  "plans:set-status",
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
  "terminal:run",
  "terminal-instances:list",
  "terminal-instances:read",
  "terminal-instances:open",
  "terminal-instances:close",
  "terminal-instances:get-scope",
  "terminal-instances:sync-scope",
  "terminal-instances:clear-all",
  "cli:install",
  "cli:uninstall",
  "cli:check-installed",
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
  // PASS6: Blueprint (Phase 7 Additive Blueprint) — restored.
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
  "blueprint:commit-snapshot",
  "blueprint:snapshot-exists",
  "pivot:run-analysis",
  // File operations (Live Code Editor)
  "file:read-content",
  "lsp:subscribe",
  "lsp:unsubscribe",
  "lsp:openDocument",
  "lsp:change",
  "lsp:close",
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
  // FIX 4: mid-stream network drop UX
  "chat:stream:disconnected",   // backend exhausted silent retries
  "chat:stream:reset-partial",  // backend will (re)start streaming; clear in-flight buffer
  "theme:system-updated",
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
  "apps:status-changed",       // Main: workspace folder presence changed (focus refresh)
  // Help bot
  "help:chat:response:chunk",
  "help:chat:response:end",
  "help:chat:response:error",
  // MCP consent request from main to renderer
  "mcp:tool-consent-request",
  // Permission system (Build mode)
  "permission-request",
  "user-question-request", // ask_user: show question + options in chat UI
  "mode_change_requested",
  "mode:changed",
  "terminal-output",
  "terminal-instances:updated",
  "terminal-instances:cleared",
  "workspace:opened-from-cli",
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
  // v2.1: Activity Stream (model selection, delegation, compaction, tool use)
  "chat:activity",
  "plan:artifact-activated",
  "plan:artifact-updated",
  "plan:file-updated",
  "lsp:diagnostics",
  "counsel:participant-update",
  "counsel:complete",
  "autonomous:session-complete",
  "chat:auto-self-correct", // main → renderer: synthetic fix prompt inserted; continue stream
  // PASS6: Blueprint AI-editing event channels — restored.
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
  "update:available",     // notify-only: newer release on GitHub; payload: { currentVersion, latestVersion, releaseUrl }
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
    send: (channel: ValidReceiveChannel, ...args: unknown[]) => {
      if (channel === "plan:artifact-activated") {
        ipcRenderer.send(channel, ...args);
        return;
      }
      throw new Error(`Invalid channel: ${channel}`);
    },
  },
  webFrame: {
    setZoomFactor: (factor: number) => {
      webFrame.setZoomFactor(factor);
    },
    getZoomFactor: () => webFrame.getZoomFactor(),
  },
});
