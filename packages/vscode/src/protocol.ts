/**
 * Messages between the extension host and the chat webview. Types only, so
 * both bundles import it (the host in Node, the webview in the browser).
 *
 * The host speaks ACP to `atlarix acp`; the webview never sees the protocol
 * plumbing, only what it draws: the session, each ACP update as it arrives, the
 * questions it must answer (an approval), and the end of a turn. Screens that
 * only read or change Atlarix's own data (keys, past chats, MCP, permissions)
 * ask through `rpc`, which the host forwards to an allow-listed `_atlarix/*`
 * method.
 */
import type {
  PermissionOption,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";

/** Something attached to the next message: a file, lines of one, an image, or text from the editor. */
export interface ContextItem {
  /** Absolute path; empty for what isn't a file (a pasted image, Problems, terminal output, git). */
  path: string;
  /** Shown on the chip: the path relative to the workspace. */
  label: string;
  /** 1-based, inclusive. */
  startLine?: number;
  endLine?: number;
  /** The selected text, for a selection; the text itself for Problems, the terminal or git. */
  text?: string;
  /** An image, base64, sent as an image block. */
  image?: { data: string; mimeType: string };
  /** A folder rather than a file. */
  folder?: boolean;
}

/** A provider on the Models & keys screens (`_atlarix/providers`). */
export interface ProviderRow {
  id: string;
  name: string;
  hasKey: boolean;
  /** "sk-…a91f" */
  keyHint?: string;
  keyUrl?: string;
  custom?: boolean;
  /** Switched off: key kept, models hidden. */
  off?: boolean;
  baseUrl?: string;
}

export type KeyStatus = "works" | "rejected" | "unchecked" | "unreachable";

/** The `_atlarix/*` methods the webview may call through the host. */
export const RPC_METHODS = [
  "_atlarix/account",
  "_atlarix/checkout",
  "_atlarix/providers",
  "_atlarix/provider_key",
  "_atlarix/provider_test",
  "_atlarix/provider_custom",
  "_atlarix/provider_enabled",
  "_atlarix/local_providers",
  "_atlarix/models",
  "_atlarix/favorite",
  "_atlarix/plan_model",
  "_atlarix/star",
  "_atlarix/sessions",
  "_atlarix/session",
  "_atlarix/undo",
  "_atlarix/checkpoint",
  "_atlarix/permissions",
  "_atlarix/mcp",
  "_atlarix/status",
  "_atlarix/recap_setting",
  "_atlarix/tasks",
] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];

/** Settings the extension keeps itself (not Atlarix's shared ones). */
export interface HostSettings {
  /** Offer the open file as context (atlarix.attachOpenFile). */
  attachOpenFile: boolean;
  /** Send with Ctrl/Cmd+Enter; Enter adds a line. */
  ctrlEnterSends: boolean;
  /** A VS Code notification when Atlarix waits for you while the panel is hidden. */
  notifyWhenNeeded: boolean;
}

export type HostMessage =
  | { type: "status"; status: "starting" | "ready" | "signed-out" | "error" | "no-folder"; detail?: string }
  | {
      type: "session";
      sessionId: string;
      title: string | null;
      modes: SessionModeState | null;
      configOptions: SessionConfigOption[];
      /** A past session loaded: its updates replay next. */
      replay: boolean;
    }
  | { type: "update"; update: SessionUpdate }
  | { type: "permission"; requestId: string; toolCall: ToolCallUpdate; options: PermissionOption[]; hasDiff: boolean }
  | { type: "permission-done"; requestId: string }
  | { type: "turn-start" }
  | { type: "turn-end"; stopReason: string | null; error?: string }
  | { type: "add-context"; item: ContextItem }
  | { type: "chrome"; status: string }
  | { type: "recap"; text: string }
  | { type: "recap-setting"; on: boolean }
  | { type: "host-info"; appName: string; version: string; where: "sidebar" | "tab"; workspace: string | null; settings: HostSettings }
  | { type: "toast"; text: string; tone?: "info" | "error" }
  | { type: "rpc-result"; id: number; result?: unknown; error?: string; data?: unknown }
  /** Open a screen or picker from outside the view (a command, the status bar). */
  | { type: "open"; what: "keys" | "model-picker" | "history" | "settings" | "account" | "mcp" | "approve" }
  /** Files matching what follows an @ in the box. */
  | { type: "files"; query: string; files: Array<{ path: string; label: string }> }
  /** The file open in the editor, offered as context unless removed. */
  | { type: "active-file"; item: ContextItem | null }
  | { type: "host-settings"; settings: HostSettings }
  /** What is running in this chat changed (sub-agents, background commands): `count` of them. */
  | { type: "tasks-changed"; count: number };

export type ViewMessage =
  | { type: "ready" }
  | { type: "send"; text: string; context: ContextItem[]; answers?: string[] }
  | { type: "cancel" }
  /** A config option: mode, model or thinking. */
  | { type: "set-option"; configId: string; value: string }
  | { type: "permission"; requestId: string; optionId: string | null }
  | { type: "open-diff"; requestId: string }
  | { type: "build" }
  | { type: "new-chat" }
  /** A past chat; from another folder, that folder opens in a new window. */
  | { type: "load-session"; sessionId: string; folder?: string }
  | { type: "pick-file" }
  | { type: "pick-image" }
  | { type: "pick-folder" }
  | { type: "add-url" }
  | { type: "add-git"; what: "changes" | "commit" }
  | { type: "add-problems" }
  | { type: "add-terminal" }
  | { type: "open-file"; path: string; line?: number }
  | { type: "open-url"; url: string }
  | { type: "sign-in" }
  | { type: "sign-out" }
  | { type: "open-in-tab" }
  | { type: "visible"; visible: boolean; focused: boolean }
  | { type: "show-log" }
  | { type: "continue-in-app" }
  | { type: "continue-in-terminal" }
  | { type: "checkout"; kind: "pro" | "credit" }
  | { type: "manage-subscription" }
  | { type: "find-files"; query: string }
  | { type: "copy"; text: string }
  /** Compare at a checkpoint: a file's version from before a turn against now. */
  | { type: "compare"; turnId: string; path: string }
  /** Go back to an earlier message and send it again, edited (a long request, like send). */
  | { type: "undo-resend"; messageId: number; text: string; restore: boolean }
  | { type: "rpc"; id: number; method: RpcMethod; params: Record<string, unknown> }
  | { type: "host-setting"; key: keyof HostSettings; value: boolean }
  | { type: "needs-you"; what: string };
