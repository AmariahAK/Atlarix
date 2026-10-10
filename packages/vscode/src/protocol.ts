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

/** Something attached to the next message: a file, or lines of one. */
export interface ContextItem {
  /** Absolute path. */
  path: string;
  /** Shown on the chip: the path relative to the workspace. */
  label: string;
  /** 1-based, inclusive. */
  startLine?: number;
  endLine?: number;
  /** The selected text, for a selection. */
  text?: string;
}

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
  | { type: "host-info"; appName: string; version: string };

export type ViewMessage =
  | { type: "ready" }
  | { type: "send"; text: string; context: ContextItem[]; answers?: string[] }
  | { type: "cancel" }
  | { type: "set-mode"; mode: string }
  | { type: "set-model"; value: string }
  | { type: "permission"; requestId: string; optionId: string | null }
  | { type: "open-diff"; requestId: string }
  | { type: "build" }
  | { type: "new-chat" }
  | { type: "history" }
  | { type: "load-session"; sessionId: string }
  | { type: "pick-file" }
  | { type: "open-file"; path: string; line?: number }
  | { type: "sign-in" }
  | { type: "open-in-tab" }
  | { type: "visible"; visible: boolean; focused: boolean }
  | { type: "recap-setting"; on: boolean }
  | { type: "show-log" };
