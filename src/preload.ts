// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer, webFrame } from "electron";

// Whitelist of valid channels
const validInvokeChannels = [
  "voice:transcribe-cloud",
  "voice:transcribe-model",
  "voice:list-transcription-providers",
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
  "chat:abort", // User can stop AI to save tokens
  "chat:submit-user-question-answer", // ask_user tool: submit answer from UI
  "chat:interject", // mid-turn user message: record for delivery on the next step
  "chat:interject-cancel", // withdraw one still-undelivered mid-turn message
  "chat:interject-list", // authoritative pending queue (main owns it, not the renderer)
  "chat:interject-flush", // take-once drain for the stream-end fallback turn
  "workspace:open-in-new-window",
  "workspace:bind-window", // tells main which workspace THIS window is showing
  "window:open-blank",
  "workspace:consume-pending-cli",
  "chat:edit-message", // v3.9: edit user message and truncate after
  "chat:revert-to-message", // v3.9: revert conversation to assistant message
  "autonomous:revert-op",
  "autonomous:accept-all",
  "revert:snapshot",
  "revert:snapshot-range",
  "snapshot:exists",
  "snapshot:files",
  "snapshot:take-reverted-files",
  "providers:check-key",
  "chat:compact",
  "snapshot:files-range",
  "stream:open", // v3.9: open terminal/pipeline stream
  "stream:close", // v3.9: close stream
  "stream:get-lines", // v3.9: get collected lines
  "stream:feed-terminal", // v3.9: feed terminal output (main process)
  "chat:count-tokens",
  "sessions:list",
  "sessions:hydrate-transport",
  "automations:list",
  "automations:create",
  "automations:update",
  "automations:delete",
  "automations:toggle",
  "automations:run-now",
  "automations:runs",
  "automations:mark-read",
  "automations:archive",
  "sessions:start",
  "sessions:allocate-transport",
  "sessions:continue-in-terminal",
  "sessions:open-in-editor",
  "sessions:resolve-for-transport",
  "sessions:create",
  "sessions:rename",
  "sessions:set-work-mode",
  "sessions:delete",
  "sessions:prune-if-empty",
  "sessions:get",
  "sessions:generate-title",
  // Rehydrates the revert-turn affordance after a relaunch. It was MISSING, and
  // its caller (SimpleInlineChat's `rehydrateSnapshots`) swallows errors — so the
  // feature silently never worked across restarts, which is the exact thing its
  // own comment says it was added to fix.
  "sessions:snapshot-turn-ids",
  // Diagnostics. EVERY new invoke channel has to be listed here or the renderer
  // throws "Invalid channel: <name>" at runtime — the handler being registered in
  // `ipc_host` is not enough, and nothing at build time catches the omission.
  "doctor:run",
  "doctor:copy-report",
  "messages:add",
  "messages:mark-complete",
  "messages:save-display-snapshot",
  "session-messages:save-display-snapshot",
  "chat:set-display-snapshot",
  "copy-app",
  "get-chat",
  "list-apps",
  "get-app",
  "get-app-env-vars",
  "set-app-env-vars",
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
  "settings:secret-encryption-available",
  "workspace:list-paths",
  "get-env-vars",
  "get-db-ready",
  "open-external-url",
  "show-item-in-folder",
  "reset-all",
  "nodejs-status",
  "install-node",
  "select-node-folder",
  "get-app-version",
  "whats-new:get",
  "get-sentry-config",
  "perf:tool-snapshot",
  "get-posthog-config",
  "reload-env-path",
  "get-proposal",
  "approve-proposal",
  "reject-proposal",
  "get-system-debug-info",
  "local-models:list-ollama",
  "local-models:list-lmstudio",
  "window:minimize",
  "window:maximize",
  "window:close",
  "get-system-platform",
  "upload-to-signed-url",
  "start-chat-stream",
  "does-release-note-exist",
  "import-app",
  "apps:touch-last-opened",
  "select-app-folder",
  "check-app-name",
  "rename-branch",
  "clear-session-data",
  "get-user-budget",
  "respond-mode-change",
  "restart-atlarix",
  "portal:migrate-create",
  // MCP
  "mcp:list-servers",
  "mcp:list-orphaned-servers",
  "mcp:create-server",
  "mcp:discover-external",
  "mcp:import-external",
  "mcp:update-server",
  "mcp:delete-server",
  "mcp:list-tools",
  "mcp:test-connection",
  "mcp:sandbox-diagnostics",
  "mcp:get-tool-consents",
  "mcp:start-oauth",
  "mcp:cancel-oauth",
  "mcp:oauth-status",
  "mcp:revoke-oauth",
  "mcp:set-tool-consent",
  "mcp:add-pasted",
  "mcp:limit",
  "mcp:verified-status",
  // MCP marketplace (official MCP Registry, cached in main)
  "mcp-catalog:search",
  "mcp-catalog:icon",
  "mcp:server-icon",
  "mcp-catalog:install",
  // Web MCP servers on the account (shared by every surface)
  "connectors:list",
  "connectors:set-enabled",
  "connectors:remove",
  "connectors:set-secret",
  "connectors:sign-in",
  // Suggestion cards: the agent asks the user to connect a server
  "mcp-suggest:list",
  "mcp-suggest:connect",
  "mcp-suggest:finish",
  "mcp-suggest:dismiss",
  // Skills — read only since v14.45 (the marketplace is gone).
  "skills:list-repo-skills",
  "skills:read-repo-skill",
  // MCP consent response from renderer to main
  "mcp:tool-consent-response",
  // "Done responding" desktop notification (renderer → main at turn-end)
  "notify:turn-done",
  // Help
  "take-screenshot",
  // adding app to favorite
  "add-to-favorite",
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
  // The Core slot-change notice: which model sits behind a slot changes without an
  // app update, so the renderer has to ask whether it moved since the user last saw.
  "compass:get-slot-change-notice",
  "compass:ack-slot-change",
  "edit-stats:summary",
  "recap:generate",
  // Models.dev (dynamic model catalog)
  "models-dev:refresh",
  // Codebase search
  "search-codebase",
  // Workspace snapshots (Pro)
  "workspace-snapshot:create",
  "workspace-snapshot:list",
  "workspace-snapshot:restore",
  "workspace-snapshot:get-metadata",
  "plans:update",
  "plans:get",
  "plans:list-by-session",
  "plans:list-by-workspace",
  "plans:copy-to-session",
  "relics:read-local",
  "relics:list",
  "relics:delete",
  "relics:set-visibility",
  "plans:set-status",
  // Dialog
  "dialog:openDirectory",
  // Typed destination folder validation (clone dialog)
  // SearxNG
  "searxng:health-check",
  "searxng:validate-url",
  "searxng:search",
  "searxng:get-config",
  "searxng:set-config",
  "searxng:delete-config",
  // Permission system (Build mode)
  "execute-permission",
  "reject-permission",
  "execute-all-permissions",
  "approve-all-for-turn",
  "reject-all-permissions",
  "get-pending-permissions",
  "command-permissions:list",
  "command-permissions:defaults",
  "command-permissions:upsert",
  "command-permissions:revoke",
  "file-permissions:list",
  "file-permissions:upsert",
  "file-permissions:revoke",
  "file-permissions:list-granted-folders",
  "file-permissions:grant-folder",
  "file-permissions:revoke-granted-folder",
  "terminal:run",
  "pty:spawn", // v10 interactive terminal
  "pty:kill",
  "pty:scrollback:save", // v10.1 scrollback persists across restarts
  "pty:scrollback:load",
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
  // Dev Server (Live Preview)
  "dev-server:is-frontend",
  "dev-server:start",
  "dev-server:stop",
  "dev-server:status",
  "dev-server:list-running",
  // Chrome-extension connection status (Settings → Browser)
  "bridge:status",
  // Background jobs (v14)
  "chat:background-jobs-list",
  "chat:background-job-cancel",
  "chat:background-job-output",
  "chat:subagent-jobs-list",
  "chat:subagent-job-cancel",
  "chat:subagent-job-output",
  "chat:background-has-pending-results",
  "chat:subagent-has-pending-results",
  "chat:approval-has-pending-results",
  // File operations (Live Code Editor)
  "file:read-content",
  "file:write-content",
  "file:get-stats",
  // Auth (OAuth Sign-In)
  "auth:sign-in",
  "auth:sign-out",
  "auth:get-current-user",
  "auth:get-plan-info",
  "auth:upgrade",
  "auth:add-credit", // PAYG: open a credit top-up checkout
  "auth:get-credit-balance", // PAYG: read the user's Core credit balance (cents)
  "auth:refresh-plan",
  "auth:manage-subscription",
  "auth:cancel-subscription",
  "onboarding:get-completed",
  "onboarding:set-completed",
  "tour:get-state",
  "tour:set-state",
  // Community (Discord)
  "discord:get-invite-info",
  // Community asks: "where did you hear about Atlarix?" + the PeerPush prompt.
  // Both write the local gate AND the PostHog person property in main.
  "community:record-acquisition-source",
  "community:peerpush-prompt",
  // Auto-updater
  "update:defer", // write defer flag to userData; install on next cold start
  "update:install-now", // quit and install downloaded update immediately
  "update:get-status", // read current update diagnostics
  "update:check-now", // manual "check for updates now"
];

const validReceiveChannels = [
  "chat:response:chunk",
  "chat:response:end",
  "chat:response:error",
  "chat:stream:pulse",
  "chat:stream:tool-input", // live partial tool-call args for a streaming preview
  "chat:stream:write-preview", // display-only old/new content for an auto-approved write
  "chat:tool:start",
  "chat:tool:end",
  "chat:stream:phase",
  // FIX 4: mid-stream network drop UX
  "chat:stream:disconnected", // backend exhausted silent retries
  "chat:stream:reset-partial", // backend will (re)start streaming; clear in-flight buffer
  "theme:system-updated",
  "models-dev:status",
  "mcp:suggestion", // main → every surface: an MCP suggestion card was added or answered
  "mcp:servers-changed", // main → renderer: the agent turned a server on or off
  "core-models:changed",
  "whats-new:changed",
  "window:fullscreen-changed",
  "app:output",
  "deep-link-received",
  "plan-changed", // Realtime plan updates from Supabase
  "settings:changed", // main → EVERY renderer: user settings were written. Without it a second window keeps a stale copy (useSettings loads once per window into an atom) — the reason zoom drifted between windows.
  "auth:resolved", // main → renderer: the startup session restore SETTLED (user or null). Unlike plan-changed this always fires — a restore that found nothing is still an answer the renderer needs.
  "oauth-callback-success", // OAuth callback from main process
  "force-close-detected",
  "db-ready", // Main: DB initialized, renderer can show app
  "apps:status-changed", // Main: workspace folder presence changed (focus refresh)
  "workspace:deleted", // Main: a workspace was removed — other windows must stop pretending it exists
  // Help bot
  // MCP consent request from main to renderer
  "command-permission-blocked",
  "file-permission-blocked",
  "mcp:oauth-redirect",
  "mcp:oauth-success",
  "mcp:oauth-error",
  "mcp:oauth-required",
  "mcp:auth-required",
  "mcp:auth-updated",
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
  "session:handoff-open", // the CLI handed a session to the app (/handoff app)
  "operation-status", // Permission queue status updates
  "auto-recovery-needed", // AI self-healing on failures
  // AI-controlled right panel (Hybrid Intent System)
  "right-panel:set-intent", // New: semantic intent-based
  "right-panel:set-view", // Legacy: kept for backwards compatibility
  // Dev server output streaming
  "dev-server:output", // Live dev server console output
  // Browser console error capture (CDP debugger)
  // Smart Agentic Loop (iteration progress)
  "chat:iteration:progress", // Progress updates (iteration count, tools)
  "chat:iteration:warning", // Warning: task running long, continue?
  "chat:iteration:limit-reached", // Hit max iterations
  "chat:iteration:timeout", // Hit time limit (10 min)
  // v2.1: Activity Stream (model selection, delegation, compaction, tool use)
  "chat:activity",
  "chat:context-report", // v10: context meter (per-section sizes + trims)
  "chat:token-usage", // live per-turn token usage (real per-step + stream estimate)
  "voice:transcript-partial", // dictation: streamed transcript preview (model route)
  "core:auto-status", // Atlarix Auto: served model + free share left (proxy headers)
  // v10 PTY terminal (pty:data/exit/cwd received; pty:input/resize sent via send())
  "pty:data",
  "pty:exit",
  "pty:cwd",
  "pty:input",
  "pty:resize",
  "plan:artifact-activated",
  "plan:artifact-updated",
  "plan:file-updated",
  "chat:background-job-update", // main → renderer: background job started/finished/cancelled
  "sessions:title-updated", // main → renderer: a session was named (placeholder, then generated title)
  "chat:interjections", // main → renderer: the pending mid-turn-message queue changed
  "automation:run-update", // main → renderer: automation run started/finished (triage feed refresh)
  "automations:changed", // main → renderer: a definition was created/updated/deleted (incl. by the agent)
  "automations:focus-feed", // main → renderer: OS-notification click → open the automations tab
  "autonomous:session-complete",
  "chat:auto-self-correct", // main → renderer: synthetic fix prompt inserted; continue stream
  // OAuth callback from main process
  "open-community-dialog",
  // Auto-updater
  "update:downloading", // update is being fetched in background; payload: { version: string }
  "update:downloaded", // update ready to install; payload: { version: string }
  "update:available", // notify-only: newer release on GitHub; payload: { currentVersion, latestVersion, releaseUrl }
  "update:status", // live update diagnostics for the Settings panel
  "cli:launcher-stale", // the installed `atlarix` launcher is stale + root-owned; offer a one-click reinstall
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
      if (
        channel === "plan:artifact-activated" ||
        // v10 PTY terminal: high-frequency keystrokes/resizes use send (no reply).
        channel === "pty:input" ||
        channel === "pty:resize"
      ) {
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
