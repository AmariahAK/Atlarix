/**
 * Messages between the extension host and the chat webview. Types only, so
 * both bundles import it (the host in Node, the webview in the browser).
 *
 * The host speaks ACP to `atlarix acp`; the webview never sees the protocol
 * plumbing, only what it draws: the session, each ACP update as it arrives, the
 * questions it must answer (an approval), and the end of a turn.
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
  /** Absolute path; empty for what isn't a file (a pasted image, the Problems list, terminal output). */
  path: string;
  /** Shown on the chip: the path relative to the workspace. */
  label: string;
  /** 1-based, inclusive. */
  startLine?: number;
  endLine?: number;
  /** The selected text, for a selection. */
  text?: string;
  /** An image, base64, sent as an image block. */
  image?: { data: string; mimeType: string };
}

/** A provider on the Models & keys screen. */
export interface ProviderRow {
  id: string;
  name: string;
  hasKey: boolean;
  /** "sk-…a91f" */
  keyHint?: string;
  keyUrl?: string;
  custom?: boolean;
}

export type KeyStatus = "works" | "rejected" | "unchecked" | "unreachable";

export interface PastSession {
  sessionId: string;
  title: string | null;
  updatedAt: string;
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
  | { type: "sessions"; sessions: PastSession[] }
  | { type: "add-context"; item: ContextItem }
  | { type: "chrome"; status: string }
  | { type: "recap"; text: string }
  | { type: "recap-setting"; on: boolean }
  | { type: "host-info"; appName: string; version: string; where: "sidebar" | "tab" }
  | {
      type: "account";
      email: string | null;
      kind: "signed-out" | "free" | "pro" | "payg" | null;
      balanceCents: number | null;
      usage: { tokens: number; cachedTokens: number; costUsd: number; contextPercent: number | null } | null;
      providers: Array<{ id: string; name: string; hasKey: boolean }>;
      mcp: Array<{ id: number; name: string; transport: string; enabled: boolean }>;
    }
  | { type: "toast"; text: string; tone?: "info" | "error" }
  /** The Models & keys screen: every provider, saved keys first. */
  | { type: "keys"; providers: ProviderRow[] }
  | { type: "key-status"; providerId: string; status: KeyStatus | "checking"; detail: string }
  /** Open a screen or picker from outside the view (a command, the status bar). */
  | { type: "open"; what: "keys" | "model-picker" | "history" }
  /** Files matching what follows an @ in the box. */
  | { type: "files"; query: string; files: Array<{ path: string; label: string }> }
  /** The file open in the editor, offered as context unless removed. */
  | { type: "active-file"; item: ContextItem | null }
  | { type: "undo-list"; messages: Array<{ id: number; text: string }> }
  | { type: "undo-preview"; messageId: number; files: string[] };

export type ViewMessage =
  | { type: "ready" }
  | { type: "send"; text: string; context: ContextItem[]; answers?: string[] }
  | { type: "cancel" }
  | { type: "set-mode"; mode: string }
  /** The model, or another of the agent's options (thinking). */
  | { type: "set-model"; value: string; configId?: string }
  | { type: "permission"; requestId: string; optionId: string | null }
  | { type: "open-diff"; requestId: string }
  | { type: "build" }
  | { type: "new-chat" }
  | { type: "history" }
  | { type: "load-session"; sessionId: string }
  | { type: "pick-file" }
  | { type: "pick-image" }
  | { type: "open-file"; path: string; line?: number }
  | { type: "sign-in" }
  | { type: "open-in-tab" }
  | { type: "visible"; visible: boolean; focused: boolean }
  | { type: "recap-setting"; on: boolean }
  | { type: "show-log" }
  | { type: "account" }
  | { type: "continue-in-app" }
  | { type: "continue-in-terminal" }
  | { type: "checkout"; kind: "pro" | "credit" }
  | { type: "manage-subscription" }
  | { type: "sign-out" }
  | { type: "connect-key" }
  | { type: "mcp-set"; id: number; enabled: boolean }
  | { type: "mcp-add" }
  | { type: "mcp-remove"; id: number }
  | { type: "mcp-test"; id: number }
  | { type: "keys" }
  | { type: "key-test"; providerId: string }
  | { type: "key-remove"; providerId: string }
  /** Add or replace: the host asks for the key in a masked input box. */
  | { type: "key-set"; providerId: string; name: string; keyUrl?: string }
  | { type: "key-custom" }
  | { type: "find-files"; query: string }
  | { type: "add-problems" }
  | { type: "copy"; text: string }
  | { type: "undo-list" }
  | { type: "undo-preview"; messageId: number }
  | { type: "undo-resend"; messageId: number; text: string; restore: boolean }
  | { type: "session-rename"; sessionId: string; title: string }
  | { type: "session-delete"; sessionId: string };
