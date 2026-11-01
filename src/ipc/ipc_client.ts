import {
  type ChatSummary,
  type UserSettings,
  AppSearchResultsSchema,
} from "../lib/schemas";
import type { PluginListItem, PluginPreviewView } from "./handlers/plugin_handlers";
import type { ModNode, ModUiEvent } from "@/lib/plugins/mod-host";
import {
  applyLiveTextPatch,
  type LiveTextPatch,
} from "@/lib/chat/live-text-patch";
import type { RelicSummary } from "@/lib/relics/relic-store";
import type {
  AppOutput,
  AutonomousSessionCompletePayload,
  Chat,
  ChatResponseEnd,
  RevertSnapshotResult,
  ChatProblemsEvent,
  ListAppsResponse,
  NodeSystemInfo,
  Message,
  Version,
  SystemDebugInfo,
  LocalModelListResponse,
  TokenCountParams,
  TokenCountResult,
  BranchResult,
  LanguageModelProvider,
  LanguageModel,
  CreateCustomLanguageModelProviderParams,
  CreateCustomLanguageModelParams,
  DoesReleaseNoteExistParams,
  ApproveProposalResult,
  ImportAppResult,
  ImportAppParams,
  RenameBranchParams,
  UserBudgetInfo,
  CopyAppParams,
  App,
  GetAppEnvVarsParams,
  SetAppEnvVarsParams,
  UpdateChatParams,
  FileAttachment,
  RevertVersionResponse,
  RevertVersionParams,
  RespondToAppInputParams,
  McpServerUpdate,
  CreateMcpServer,
  SelectNodeFolderResult,
  PlanUpdatePayload,
  ListRepoSkillsResult,
  ChatTokenUsage,
  ComputerUsePermissions,
} from "./ipc_types";
import type {
  AppSearchResult,
  ChatSearchResult,
  ProposalResult,
} from "@/lib/schemas";
import { showError } from "@/lib/toast";
import { classifyContent } from "@/lib/file-content-type";
import { DeepLinkData } from "./deep_link_data";
import { getDefaultStore } from "jotai";
import { autonomousSessionReviewAtom, zenithOfferChatIdsAtom } from "@/atoms/chatAtoms";

export interface ChatStreamCallbacks {
  onUpdate: (messages: Message[]) => void;
  onEnd: (response: ChatResponseEnd) => void;
  onError: (error: string) => void;
}

export interface AppStreamCallbacks {
  onOutput: (output: AppOutput) => void;
}

interface DeleteCustomModelParams {
  providerId: string;
  modelApiName: string;
}

/**
 * The MIME type to record for an attachment, decided from its CONTENT.
 *
 * The OS's `File.type` is not authoritative for source files: macOS registers
 * `.ts` as an MPEG transport stream, so a TypeScript file arrives claiming
 * `video/mp2t`. Trusting that produced an attachment handled as video rather than
 * text — a confidently wrong answer derived from the filename.
 *
 * So classify the bytes (`classifyContent`), and consult `file.type` only for the
 * one thing content cannot settle: which specific ZIP-based Office format a
 * document is. Everything else — images by magic bytes, text by strict UTF-8 —
 * comes from the file itself.
 */
function attachmentMimeType(file: File, bytes: Uint8Array): string {
  const classified = classifyContent(bytes);
  if (classified.kind === "document" && classified.mime === "application/zip") {
    // .docx/.xlsx/.pptx/.odt are all ZIPs; only the name distinguishes them, so
    // prefer whatever the OS says before falling back to the generic container.
    return file.type?.trim() || classified.mime;
  }
  return classified.mime;
}

/** Base64 without FileReader — avoids renderer failures on some PDFs in Electron. */
function uint8ToBase64(bytes: Uint8Array): string {
  const B = (
    globalThis as unknown as {
      Buffer?: {
        from: (input: Uint8Array) => { toString: (enc: string) => string };
      };
    }
  ).Buffer;
  if (B) {
    return B.from(bytes).toString("base64");
  }
  const chunk = 0x8000;
  const binaryChunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binaryChunks.push(
      String.fromCharCode.apply(null, sub as unknown as number[]),
    );
  }
  return btoa(binaryChunks.join(""));
}

/** SHA-256 (hex, 32 chars) of the file bytes — a stable content id. */
async function contentHashId(buffer: ArrayBuffer): Promise<string | undefined> {
  try {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 32);
    }
  } catch {
    /* fall through to random id */
  }
  return undefined;
}

/** Last-resort id when content hashing is unavailable. */
function randomAttachmentId(): string | undefined {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : undefined;
}

async function encodeFileAttachmentForStream(
  attachment: FileAttachment,
): Promise<{
  id?: string;
  name: string;
  type: string;
  data: string;
  attachmentType: "upload-to-codebase" | "chat-context";
}> {
  const file = attachment.file;
  if (!file) {
    throw new Error("Attachment is missing file data");
  }
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to read file: ${file.name} (${reason})`);
  }
  const bytes = new Uint8Array(buffer);
  let base64Data: string;
  try {
    base64Data = uint8ToBase64(bytes);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to encode file: ${file.name} (${reason})`);
  }
  const mime = attachmentMimeType(file, bytes);
  const raw = `data:${mime};base64,${base64Data}`;
  // Deterministic content-hash id: the same file encoded twice (double-add,
  // edit/resend) resolves to the SAME id, so AttachmentStore + the server-side
  // backstop collapse it to one record instead of two random-UUID copies.
  const id =
    attachment.id ?? (await contentHashId(buffer)) ?? randomAttachmentId();

  import("@/lib/attachment-store")
    .then(({ AttachmentStore }) => {
      if (id) {
        AttachmentStore.add({
          id,
          filename: file.name,
          mimeType: mime,
          data: base64Data,
          size: file.size,
          addedAt: Date.now(),
        });
      }
    })
    .catch(() => {});

  return {
    id,
    name: file.name,
    type: mime,
    data: raw,
    attachmentType: attachment.type,
  };
}

/**
 * Shape of the preload-exposed `electron.ipcRenderer` wrapper. Its `on` strips the
 * Electron event and forwards only the payload to listeners, so listeners are
 * `(payload) => void` (not Electron's `(event, ...args) => void`).
 */
interface PreloadIpcRenderer {
  invoke(channel: string, ...args: any[]): Promise<any>;
  /**
   * ONE parameter, deliberately.
   *
   * The preload `on` strips the Electron event and forwards only the payload, so
   * a listener must be `(payload) => …`. This was typed `(...args: any[])`, which
   * accepts anything — and nine handlers had been written Electron-style as
   * `(_e, payload)`, so `_e` silently received the payload, `payload` was
   * `undefined`, and every `"chatId" in payload` guard failed. Nine features were
   * dead in the shipped app with no error anywhere: stream phase/status, stream
   * pulse, tool-input progress, write preview, reset-partial, models.dev status,
   * fullscreen changes, plan file-updated, autonomous session-complete.
   *
   * TypeScript rejects a two-parameter function against a one-parameter
   * signature, so this typing turns that mistake into a compile error instead of
   * a silent no-op.
   */
  on(channel: string, listener: (payload: any) => void): (() => void) | void;
  send(channel: string, ...args: any[]): void;
  removeListener(channel: string, listener: (payload: any) => void): void;
  removeAllListeners(channel: string): void;
}

export type UpdateResultKind =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error"
  | "unsupported";

export interface UpdateStatusPayload {
  currentVersion: string;
  lastCheckAt: number | null;
  lastResult: UpdateResultKind;
  detail?: string;
  availableVersion?: string;
}

/**
 * Broadcast on `chat:background-job-update` for BOTH background commands and
 * background sub-agent tasks (discriminated by `source`). Commands carry
 * `operationId`; sub-agents carry `taskId`. `"stalled"` is the output-idle
 * advisory (commands only). One channel → one renderer wake closure.
 */
export interface BackgroundJobUpdatePayload {
  chatId: number;
  /** "peer": another Atlarix session messaged this chat (lib/peers). */
  source: "command" | "subagent" | "scheduled" | "peer";
  operationId?: string;
  taskId?: string;
  status:
    | "running"
    | "finished"
    | "cancelled"
    | "stalled"
    | "scheduled"
    | "condition_met"
    | "peer_message";
  running?: number;
}

/**
 * One pending mid-turn user message. Renderer-side view of
 * `UserInterjection` — declared here rather than imported from
 * `@/lib/agent/user-interjections` so the renderer bundle does not pull in a
 * main-process module for a three-field shape.
 */
export interface UserInterjectionView {
  id: string;
  text: string;
  ts: number;
}

/** An open suggestion card: what the agent suggested, the catalog entry, and where the server stands. */
export type McpSuggestionView = import("@/lib/mcp/mcp-suggestions").McpSuggestion & {
  entry?: import("@/shared/mcp-catalog").CatalogEntry | null;
  status?: import("@/lib/mcp/mcp-suggestions").McpServerStatus | null;
};

/** What a rating or /feedback says about the session: never a prompt or code. */
export interface FeedbackSessionInfo {
  mode?: string;
  effort?: string;
  provider?: string;
  model?: string;
  turns?: number;
  startedAt?: number;
}

export class IpcClient {
  private static instance: IpcClient;
  private ipcRenderer: PreloadIpcRenderer;
  private chatStreams: Map<number, ChatStreamCallbacks>;
  /**
   * The last full message list main sent for each streaming chat. During a turn
   * main sends the list once and then `patch` chunks carrying only the live
   * row's text; each patch makes a new list from this one in which only that row
   * is a new object, so every other row keeps its identity (and its memo).
   */
  private streamMessages = new Map<number, Message[]>();
  // v14.8.10 Fix S: stream-leg identity. The backend stamps every
  // chat:response:* event with the leg's monotonic streamId and returns that id
  // from the chat:stream invoke. A superseded (older) leg's late error/end must
  // NOT wipe the live leg's state (observed: frozen inline chat after an
  // error + model-switch continue crossed in flight).
  private currentStreamIdByChat: Map<number, number> = new Map();
  private pendingStreamDispatch: Map<number, number> = new Map();
  /** Chats the user just clicked Stop on — chunks drop instantly until the
   * turn's response:end (or a new dispatch) clears the flag. */
  private optimisticallyCancelled: Set<number> = new Set();
  private appStreams: Map<number, AppStreamCallbacks>;
  private mcpConsentHandlers: Map<string, (payload: any) => void>;
  /**
   * Chat-scoped subscriber SETS, not single handlers — `InlinePermissionApprovals`
   * is rendered per ASSISTANT MESSAGE (`AssistantMessageBody.tsx`), so a chat has as
   * many live subscribers as it has messages, and `permission-request` additionally
   * has a second, unrelated subscriber in `useStreamChat`.
   *
   * As one-slot Maps these silently lost events: `set()` meant last-registration-wins,
   * and the unsubscribe returned to an OLD instance did `delete(chatId)` — removing
   * whichever handler happened to hold the slot rather than its own. An unmounting
   * message could therefore leave a chat with NO handler at all. Observed as a turn
   * hanging forever on an outside-workspace write: the `sandbox_escalation` card never
   * reached the screen, so nothing could approve it and only Stop recovered.
   *
   * `userQuestionHandlers` and `mcpConsentHandlers` are deliberately NOT sets:
   * `onUserQuestionRequest` is subscribed only from `useStreamChat` (one per chat) and
   * `mcpConsentHandlers` has no subscriber outside this file, so neither can collide.
   */
  private permissionHandlers: Map<number, Set<(payload: any) => void>>;
  private commandPermissionBlockedHandlers: Map<
    number,
    Set<
      (payload: { chatId: number; category?: string; message?: string }) => void
    >
  >;
  private filePermissionBlockedHandlers: Map<
    number,
    Set<(payload: { chatId: number; message?: string }) => void>
  >;
  private userQuestionHandlers: Map<number, (payload: any) => void>;
  private modeChangeHandler:
    | ((payload: {
        chatId: number;
        requestedMode: string;
        reason: string;
      }) => void)
    | null = null;
  private terminalHandlers: Map<number, Set<(payload: any) => void>>;
  private toolStartHandlers: Set<
    (payload: {
      chatId: number;
      toolName: string;
      toolId?: string;
      toolCallId?: string;
      toolArgs?: Record<string, unknown>;
    }) => void
  > = new Set();
  private toolEndHandlers: Set<
    (payload: {
      chatId: number;
      toolId?: string;
      toolCallId?: string;
      toolName?: string;
      status?: "success" | "error";
    }) => void
  > = new Set();
  private streamPhaseHandlers: Set<
    (payload: {
      chatId: number;
      phase: string;
      label: string;
      /** v13 waiting_on_command / command_done payloads. */
      commandId?: string;
      command?: string;
      startedAt?: number;
    }) => void
  > = new Set();
  private streamPulseHandlers: Set<
    (payload: { chatId: number; timestamp: number }) => void
  > = new Set();
  private streamResetPartialHandlers: Set<
    (payload: { chatId: number }) => void
  > = new Set();
  private streamToolInputHandlers: Set<
    (payload: {
      chatId: number;
      toolCallId: string;
      toolName: string;
      argsTextSoFar: string;
    }) => void
  > = new Set();
  private streamWritePreviewHandlers: Set<
    (payload: {
      chatId: number;
      path: string;
      operation: string;
      oldContent: string;
      content: string;
      /** Hunks computed in main — keeps the Myers diff off the UI thread. */
      hunks?: unknown[];
      addedCount?: number;
      removedCount?: number;
    }) => void
  > = new Set();
  private modelsDevStatusHandlers: Set<
    (payload: { message: string; timedOut?: boolean }) => void
  > = new Set();
  private coreModelsChangedHandlers: Set<() => void> = new Set();
  private windowFullscreenHandlers: Set<
    (payload: { fullscreen: boolean }) => void
  > = new Set();
  private chatActivityHandlers: Set<
    (payload: { label?: string; status?: string; chatId?: number }) => void
  > = new Set();
  private updateDownloadingHandlers: Set<
    (payload: { version: string }) => void
  > = new Set();
  private updateAvailableHandlers: Set<
    (payload: {
      currentVersion: string;
      latestVersion: string;
      releaseUrl: string;
    }) => void
  > = new Set();
  private updateDownloadedHandlers: Set<
    (payload: { version: string }) => void
  > = new Set();
  private updateStatusHandlers: Set<(payload: UpdateStatusPayload) => void> =
    new Set();
  private cliLauncherStaleHandlers: Set<() => void> = new Set();
  private planUpdateHandlers = new Map<
    number,
    Set<(payload: PlanUpdatePayload) => void>
  >();
  private planArtifactHandlers = new Set<
    (payload: import("./utils/emit_plan_artifact").PlanArtifactPayload) => void
  >();
  private planArtifactUpdatedHandlers = new Set<
    (payload: import("./utils/emit_plan_artifact").PlanArtifactPayload) => void
  >();
  private planFileUpdatedHandlers = new Set<
    (payload: { workspacePath: string; mtime: number | null }) => void
  >();
  private contextReportHandlers = new Set<
    (payload: import("./ipc_types").ChatContextReport) => void
  >();
  private tokenUsageHandlers = new Set<(payload: ChatTokenUsage) => void>();
  private constructor() {
    this.ipcRenderer = (window as any).electron
      .ipcRenderer as PreloadIpcRenderer;
    this.chatStreams = new Map();
    this.appStreams = new Map();
    this.mcpConsentHandlers = new Map();
    this.permissionHandlers = new Map();
    this.commandPermissionBlockedHandlers = new Map();
    this.filePermissionBlockedHandlers = new Map();
    this.userQuestionHandlers = new Map();
    this.terminalHandlers = new Map();
    // Set up listeners for stream events
    this.ipcRenderer.on("chat:response:chunk", (data) => {
      if (data && typeof data === "object" && "chatId" in data) {
        const { chatId } = data as { chatId: number };

        // Optimistic stop: the user clicked Stop; drop further CHUNKS instantly
        // (kills the streaming re-render flood that makes Stop feel laggy) while
        // still letting the eventual response:end finalize + clear this flag.
        if (this.optimisticallyCancelled.has(chatId)) return;

        // Fix S: ignore updates from a superseded stream leg.
        if (
          this.shouldDropStreamEvent(
            chatId,
            (data as { streamId?: unknown }).streamId,
          )
        ) {
          return;
        }

        // Handle permission-request type. Second delivery path (in-band on the chat
        // stream rather than the dedicated channel) — it must fan out to every
        // subscriber exactly like the one above, or the same card goes missing here.
        if ("type" in data && (data as any).type === "permission-request") {
          this.notifyChatSubscribers(
            this.permissionHandlers,
            chatId,
            data,
            "permission-request",
          );
          return;
        }

        // The live row's text only (see streamMessages).
        if ("patch" in data) {
          const { patch } = data as { patch?: LiveTextPatch };
          const base = this.streamMessages.get(chatId);
          if (!base || !patch) return;
          const idx = base.findIndex((m) => m.id === patch.messageId);
          if (idx < 0) return;
          const content = applyLiveTextPatch(base[idx]!.content ?? "", patch);
          if (content === null || content === base[idx]!.content) return;
          const next = base.slice();
          next[idx] = { ...base[idx]!, content };
          this.streamMessages.set(chatId, next);
          this.chatStreams.get(chatId)?.onUpdate(next);
          return;
        }

        // Handle normal message updates
        if ("messages" in data) {
          const { messages } = data as { chatId: number; messages: Message[] };
          this.streamMessages.set(chatId, messages);
          const callbacks = this.chatStreams.get(chatId);
          if (callbacks) {
            callbacks.onUpdate(messages);
          } else {
            console.warn(
              `[IPC] No callbacks found for chat ${chatId}`,
              this.chatStreams,
            );
          }
        }
      } else {
        showError(new Error(`[IPC] Invalid chunk data received: ${data}`));
      }
    });

    this.ipcRenderer.on("app:output", (data) => {
      if (
        data &&
        typeof data === "object" &&
        "type" in data &&
        "message" in data &&
        "appId" in data
      ) {
        const { type, message, appId } = data as unknown as AppOutput;
        const callbacks = this.appStreams.get(appId);
        if (callbacks) {
          callbacks.onOutput({ type, message, appId, timestamp: Date.now() });
        }
      } else {
        showError(new Error(`[IPC] Invalid app output data received: ${data}`));
      }
    });

    this.ipcRenderer.on("chat:response:end", (payload) => {
      const { chatId, streamId } = payload as unknown as ChatResponseEnd;
      // Optimistic-stop resolved: the turn actually ended, so re-enable chunk
      // delivery for any future turn on this chat.
      this.optimisticallyCancelled.delete(chatId);
      // Fix S: a superseded leg's late end must not tear down the live leg's
      // callbacks/state (observed: frozen inline chat after an error +
      // model-switch continue crossed in flight).
      if (this.shouldDropStreamEvent(chatId, streamId)) return;
      // Atlarix Auto's top rung kept failing: the chat shows the Zenith offer.
      if ((payload as unknown as ChatResponseEnd).zenithOffer === true) {
        getDefaultStore().set(zenithOfferChatIdsAtom, (prev) => new Set([...prev, chatId]));
      }
      this.streamMessages.delete(chatId);
      this.streamPhaseHandlers.forEach((h) =>
        h({ chatId, phase: "done", label: "" }),
      );
      const callbacks = this.chatStreams.get(chatId);
      if (callbacks) {
        callbacks.onEnd(payload as unknown as ChatResponseEnd);
        this.chatStreams.delete(chatId);
      }
    });

    this.ipcRenderer.on("chat:tool:start", (payload: unknown) => {
      if (
        payload &&
        typeof payload === "object" &&
        "chatId" in payload &&
        "toolName" in payload
      ) {
        const { chatId, toolName, toolId, toolCallId, toolArgs } = payload as {
          chatId: number;
          toolName: string;
          toolId?: string;
          toolCallId?: string;
          toolArgs?: Record<string, unknown>;
        };
        this.toolStartHandlers.forEach((h) =>
          h({ chatId, toolName, toolId, toolCallId, toolArgs }),
        );
      }
    });
    this.ipcRenderer.on("chat:tool:end", (payload: unknown) => {
      if (payload && typeof payload === "object" && "chatId" in payload) {
        const { chatId, toolId, toolCallId, status } = payload as {
          chatId: number;
          toolId?: string;
          toolCallId?: string;
          status?: "success" | "error";
        };
        this.toolEndHandlers.forEach((h) =>
          h({ chatId, toolId, toolCallId, status }),
        );
      }
    });

    this.ipcRenderer.on("chat:stream:phase", (payload: unknown) => {
      if (
        payload &&
        typeof payload === "object" &&
        "chatId" in payload &&
        "phase" in payload
      ) {
        const p = payload as {
          chatId: number;
          phase: string;
          label?: string;
          commandId?: string;
          command?: string;
          startedAt?: number;
        };
        this.streamPhaseHandlers.forEach((h) =>
          h({
            chatId: p.chatId,
            phase: p.phase,
            label: p.label ?? "",
            commandId: p.commandId,
            command: p.command,
            startedAt: p.startedAt,
          }),
        );
      }
    });

    this.ipcRenderer.on("chat:stream:pulse", (payload: unknown) => {
      if (
        payload &&
        typeof payload === "object" &&
        "chatId" in payload &&
        "timestamp" in payload
      ) {
        const p = payload as { chatId: number; timestamp: number };
        this.streamPulseHandlers.forEach((h) => h(p));
      }
    });

    // Emitted by the backend ONLY when it actually retries a dropped/stalled
    // round (genuine reconnect). Drives the honest "Reconnecting…" indicator.
    this.ipcRenderer.on("chat:stream:reset-partial", (payload: unknown) => {
      if (payload && typeof payload === "object" && "chatId" in payload) {
        const p = payload as { chatId: number };
        this.streamResetPartialHandlers.forEach((h) => h(p));
      }
    });

    this.ipcRenderer.on("chat:stream:tool-input", (payload: unknown) => {
      if (
        payload &&
        typeof payload === "object" &&
        "chatId" in payload &&
        "argsTextSoFar" in payload
      ) {
        const p = payload as {
          chatId: number;
          toolCallId: string;
          toolName: string;
          argsTextSoFar: string;
        };
        this.streamToolInputHandlers.forEach((h) => h(p));
      }
    });
    this.ipcRenderer.on("chat:stream:write-preview", (payload: unknown) => {
      if (
        payload &&
        typeof payload === "object" &&
        "chatId" in payload &&
        "path" in payload
      ) {
        const p = payload as {
          chatId: number;
          path: string;
          operation: string;
          oldContent: string;
          content: string;
          // Computed in main so the renderer never runs a Myers diff on the UI
          // thread; absent on paths that don't supply it, and the card falls
          // back to computing locally.
          hunks?: unknown[];
          addedCount?: number;
          removedCount?: number;
        };
        this.streamWritePreviewHandlers.forEach((h) => h(p));
      }
    });

    this.ipcRenderer.on("models-dev:status", (payload: unknown) => {
      if (payload && typeof payload === "object" && "message" in payload) {
        const p = payload as { message: string; timedOut?: boolean };
        this.modelsDevStatusHandlers.forEach((h) => h(p));
      }
    });

    this.ipcRenderer.on("core-models:changed", () => {
      this.coreModelsChangedHandlers.forEach((h) => h());
    });

    this.ipcRenderer.on("window:fullscreen-changed", (payload: unknown) => {
      if (payload && typeof payload === "object" && "fullscreen" in payload) {
        const fs = Boolean((payload as { fullscreen: boolean }).fullscreen);
        document.documentElement.dataset.fullscreen = fs ? "true" : "false";
        this.windowFullscreenHandlers.forEach((h) => h({ fullscreen: fs }));
      }
    });

    this.ipcRenderer.on("chat:response:error", (payload) => {
      if (
        payload &&
        typeof payload === "object" &&
        "chatId" in payload &&
        "error" in payload
      ) {
        const { chatId, error, streamId } = payload as {
          chatId: number;
          error: string;
          streamId?: number;
        };
        // Fix S: ignore a superseded leg's late error (see chat:response:end).
        if (this.shouldDropStreamEvent(chatId, streamId)) return;
        this.streamMessages.delete(chatId);
        this.streamPhaseHandlers.forEach((h) =>
          h({ chatId, phase: "done", label: "" }),
        );
        const callbacks = this.chatStreams.get(chatId);
        if (callbacks) {
          callbacks.onError(error);
          this.chatStreams.delete(chatId);
        } else {
          console.warn(
            `[IPC] No callbacks found for chat ${chatId} on error`,
            this.chatStreams,
          );
        }
      } else {
        console.error("[IPC] Invalid error data received:", payload);
      }
    });

    // Silent network retries ran out (network-retry.ts). Main sends only this,
    // so with no listener the turn stayed "streaming" for good. End it as an
    // error that says what happened; the partial reply stays on screen.
    this.ipcRenderer.on("chat:stream:disconnected", (payload) => {
      const p = payload as {
        chatId?: number;
        detail?: string;
        providerName?: string;
        partialResponse?: string;
      } | null;
      if (!p || typeof p.chatId !== "number") return;
      const chatId = p.chatId;
      this.streamMessages.delete(chatId);
      this.streamPhaseHandlers.forEach((h) =>
        h({ chatId, phase: "done", label: "" }),
      );
      const callbacks = this.chatStreams.get(chatId);
      if (!callbacks) return;
      // The CLI and editor's words (ec6bdc46); a drop after part of the reply
      // came is a lost connection, not an unreachable provider.
      const name = p.providerName || "the model provider";
      const detail = p.detail?.trim() ? `: ${p.detail.trim().replace(/\.?$/, ".")}` : ".";
      callbacks.onError(
        p.partialResponse?.trim()
          ? `Lost the connection to ${name} mid-reply${detail} Try again.`
          : `Couldn't reach ${name}${detail} Check it's running and the address is right, then try again.`,
      );
      this.chatStreams.delete(chatId);
    });

    // MCP tool consent request from main
    this.ipcRenderer.on("mcp:tool-consent-request", (payload) => {
      const handler = this.mcpConsentHandlers.get("consent");
      if (handler) handler(payload);
    });

    // Permission request from main (Build mode tools needing approval).
    // EVERY subscriber gets it — a chat has one per rendered assistant message plus
    // useStreamChat's, and they render different things (the approval card vs the
    // FileProposal list). Delivering to only one is how an approval card went missing
    // and hung a turn indefinitely.
    this.ipcRenderer.on("permission-request", (payload: any) => {
      if (payload && typeof payload === "object" && "chatId" in payload) {
        const { chatId } = payload;
        const delivered = this.notifyChatSubscribers(
          this.permissionHandlers,
          chatId,
          payload,
          "permission-request",
        );
        // Worth keeping loud. This exact line names the failure in one step when a
        // turn is stuck waiting for a card that never appeared.
        if (!delivered) {
          console.warn(`[IPC] No permission handler for chat ${chatId}`);
        }
      }
    });

    this.ipcRenderer.on("command-permission-blocked", (payload: any) => {
      if (payload && typeof payload === "object" && "chatId" in payload) {
        const { chatId } = payload as { chatId: number };
        this.notifyChatSubscribers(
          this.commandPermissionBlockedHandlers,
          chatId,
          payload,
          "command-permission-blocked",
        );
      }
    });

    this.ipcRenderer.on("file-permission-blocked", (payload: any) => {
      if (payload && typeof payload === "object" && "chatId" in payload) {
        const { chatId } = payload as { chatId: number };
        this.notifyChatSubscribers(
          this.filePermissionBlockedHandlers,
          chatId,
          payload,
          "file-permission-blocked",
        );
      }
    });

    // ask_user tool: question + optional options (render in chat UI)
    this.ipcRenderer.on("user-question-request", (payload: any) => {
      if (payload && typeof payload === "object" && "chatId" in payload) {
        const { chatId } = payload;
        const handler = this.userQuestionHandlers.get(chatId);
        const numericId = typeof chatId === "number" ? chatId : Number(chatId);
        const handlerNumeric =
          Number.isFinite(numericId) && !Number.isNaN(numericId)
            ? this.userQuestionHandlers.get(numericId)
            : undefined;
        const resolvedHandler = handler ?? handlerNumeric;
        if (resolvedHandler) {
          resolvedHandler(payload);
        } else {
          console.warn(`[IPC] No user-question handler for chat ${chatId}`);
        }
      }
    });

    // Legacy: mode change approval prompt (unused for request_mode_change; handler may be unset)
    this.ipcRenderer.on("mode_change_requested", (payload: any) => {
      if (
        payload &&
        typeof payload === "object" &&
        "chatId" in payload &&
        this.modeChangeHandler
      ) {
        this.modeChangeHandler(payload);
      }
    });

    // Terminal output from main (command execution). Fan out to ALL subscribers
    // for this chat — both the in-chat command cards (useStreamChat) and the
    // right-panel Agent terminal tab (TerminalPanel) listen, and must coexist.
    this.ipcRenderer.on("terminal-output", (payload: any) => {
      if (payload && typeof payload === "object" && "chatId" in payload) {
        const { chatId } = payload;
        const handlers = this.terminalHandlers.get(chatId);
        if (handlers && handlers.size > 0) {
          for (const handler of handlers) {
            try {
              handler(payload);
            } catch (err) {
              console.error("[IPC] terminal-output handler threw:", err);
            }
          }
        }
        // NO `console.log` FALLBACK.
        //
        // This used to log the WHOLE payload whenever no handler was registered
        // for the chat — and `terminal_handlers.ts` defaults `chatId` to 0, which
        // never matches a subscriber, so every user-initiated command logged
        // every chunk in full. With the old cumulative payloads that was a
        // quadratic devtools flood that Chromium then retained.
        //
        // Dropped rather than rate-limited: an unhandled terminal event carries
        // no information the main-side log does not already have, and the one
        // shape that reliably hit it (chatId 0) is a routing quirk, not an error
        // worth reporting on every chunk.
      }
    });

    // chat:activity (e.g. summarization progress)
    this.ipcRenderer.on("plan:artifact-activated", (payload: unknown) => {
      this.planArtifactHandlers.forEach((h) => {
        try {
          h(
            payload as import("./utils/emit_plan_artifact").PlanArtifactPayload,
          );
        } catch {
          /* noop */
        }
      });
    });

    this.ipcRenderer.on("plan:artifact-updated", (payload: unknown) => {
      this.planArtifactUpdatedHandlers.forEach((h) => {
        try {
          h(
            payload as import("./utils/emit_plan_artifact").PlanArtifactPayload,
          );
        } catch {
          /* noop */
        }
      });
    });

    // v10: per-dispatch context assembly report (context meter).
    this.ipcRenderer.on("chat:context-report", (payload: unknown) => {
      this.contextReportHandlers.forEach((h) => {
        try {
          h(payload as import("./ipc_types").ChatContextReport);
        } catch {
          /* noop */
        }
      });
    });

    // Live per-turn token usage (real per-step + throttled stream estimates).
    this.ipcRenderer.on("chat:token-usage", (payload: unknown) => {
      this.tokenUsageHandlers.forEach((h) => {
        try {
          h(payload as ChatTokenUsage);
        } catch {
          /* noop */
        }
      });
    });

    this.ipcRenderer.on("plan:file-updated", (payload: unknown) => {
      if (
        !payload ||
        typeof payload !== "object" ||
        !("workspacePath" in payload)
      )
        return;
      const p = payload as { workspacePath: string; mtime: number | null };
      this.planFileUpdatedHandlers.forEach((h) => {
        try {
          h(p);
        } catch {
          /* noop */
        }
      });
    });

    this.ipcRenderer.on("chat:activity", (payload: any) => {
      if (payload && typeof payload === "object") {
        this.chatActivityHandlers.forEach((h) => h(payload));
      }
    });

    this.ipcRenderer.on("update:downloading", (data) => {
      if (data && typeof data === "object" && "version" in data) {
        this.updateDownloadingHandlers.forEach((h) =>
          h(data as { version: string }),
        );
      }
    });

    this.ipcRenderer.on("update:downloaded", (data) => {
      if (data && typeof data === "object" && "version" in data) {
        this.updateDownloadedHandlers.forEach((h) =>
          h(data as { version: string }),
        );
      }
    });

    this.ipcRenderer.on("update:available", (data) => {
      if (
        data &&
        typeof data === "object" &&
        "latestVersion" in data &&
        "releaseUrl" in data
      ) {
        this.updateAvailableHandlers.forEach((h) =>
          h(
            data as {
              currentVersion: string;
              latestVersion: string;
              releaseUrl: string;
            },
          ),
        );
      }
    });

    this.ipcRenderer.on("cli:launcher-stale", () => {
      this.cliLauncherStaleHandlers.forEach((h) => h());
    });

    this.ipcRenderer.on("update:status", (data) => {
      if (data && typeof data === "object" && "lastResult" in data) {
        this.updateStatusHandlers.forEach((h) =>
          h(data as UpdateStatusPayload),
        );
      }
    });

    this.ipcRenderer.on("autonomous:session-complete", (payload: unknown) => {
      if (
        payload &&
        typeof payload === "object" &&
        "chatId" in payload &&
        "turnId" in payload
      ) {
        getDefaultStore().set(
          autonomousSessionReviewAtom,
          payload as AutonomousSessionCompletePayload,
        );
      }
    });
  }

  /** v3.9: Edit user message, truncate after it, clear has_answered_questions. */
  public async editMessage(
    chatId: number,
    userMessageId: number,
    newContent: string,
  ): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("chat:edit-message", {
      chatId,
      userMessageId,
      newContent,
    });
  }

  /** v3.9: Revert conversation to assistant message, truncate after it, clear has_answered_questions. */
  public async revertToMessage(
    chatId: number,
    assistantMessageId: number,
  ): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("chat:revert-to-message", {
      chatId,
      assistantMessageId,
    });
  }

  public async autonomousRevertOp(params: {
    chatId: number;
    turnId: string;
    operationId: string;
  }): Promise<{ success: boolean; error?: string; restoredFiles?: number }> {
    return this.ipcRenderer.invoke("autonomous:revert-op", params);
  }

  public async autonomousAcceptAll(params: {
    chatId: number;
    turnId: string;
  }): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("autonomous:accept-all", params);
  }

  /**
   * Restore workspace files from a turn's shadow-git snapshot. Pass
   * `filesOnly: true` (v13.1 "revert this turn's file changes") to restore the
   * files WITHOUT marking the conversation/messages as reverted.
   */
  public async revertSnapshot(
    chatId: number,
    turnId: string,
    opts?: { filesOnly?: boolean },
  ): Promise<RevertSnapshotResult> {
    return this.ipcRenderer.invoke("revert:snapshot", {
      chatId,
      turnId,
      filesOnly: opts?.filesOnly ?? false,
    });
  }

  /** Whether `.atlarix/snapshots/<turnId>/manifest.json` exists for the workspace. */
  public async snapshotExists(params: {
    appId: number;
    turnId: string;
  }): Promise<boolean> {
    return this.ipcRenderer.invoke("snapshot:exists", params);
  }

  /** v13.1: the files a turn's snapshot would restore/delete (null if none). */
  public async getSnapshotFiles(params: {
    chatId: number;
    turnId: string;
  }): Promise<{
    filesChanged: string[];
    createdFiles: string[];
    /** Set once the user has reverted this turn's files. */
    revertedAt?: string;
    /** False: the turn has no record of how it ended, so a revert can't check. */
    endRecorded?: boolean;
    /** What a revert now would keep: changed after the turn. */
    kept?: string[];
  } | null> {
    return this.ipcRenderer.invoke("snapshot:files", params);
  }

  /**
   * The files of these turns reverted since the agent was last told; marks
   * them told (the agent hears it once, with the user's next message).
   */
  /** /compact: summarise this chat's conversation now. */
  public async compactChat(params: {
    chatId: number;
    providerId?: string;
    workspaceSessionId?: string | null;
  }): Promise<{ ok: boolean; message: string }> {
    return this.ipcRenderer.invoke("chat:compact", params);
  }

  /** Whether the saved key for this provider works (null: no key saved). */
  public async checkProviderKey(
    providerId: string,
    candidate?: string,
  ): Promise<{
    status: "works" | "rejected" | "unchecked" | "unreachable";
    detail: string;
  } | null> {
    return this.ipcRenderer.invoke("providers:check-key", providerId, candidate);
  }

  public async takeRevertedFiles(params: {
    chatId: number;
    turnIds: string[];
  }): Promise<string[]> {
    return this.ipcRenderer.invoke("snapshot:take-reverted-files", params);
  }

  /**
   * Bug 6: persisted per-assistant `snapshot_turn_id` rows for a chat's bound
   * session, so the revert-turn affordance can be rehydrated on ANY load path
   * (relaunch / openWorkspaceFolder), not just manual session-list selection.
   */
  public async getSnapshotTurnIds(
    chatId: number,
  ): Promise<Array<{ rowId: string; snapshotTurnId: string }>> {
    return this.ipcRenderer.invoke("sessions:snapshot-turn-ids", { chatId });
  }

  /**
   * Edit-and-resend: revert the file changes of a RANGE of discarded turns
   * (turnIds in chronological order; reverted newest→oldest by the handler).
   * Files-only — never flags messages. Missing/expired snapshots are skipped.
   */
  public async revertSnapshotRange(
    chatId: number,
    turnIds: string[],
  ): Promise<{
    success: boolean;
    restoredFiles?: number;
    reverted?: string[];
    skipped?: string[];
    kept?: string[];
    unchecked?: boolean;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("revert:snapshot-range", {
      chatId,
      turnIds,
    });
  }

  /** Union of files a RANGE of turn snapshots would restore/delete (for the edit-revert dialog). */
  public async getSnapshotFilesRange(
    chatId: number,
    turnIds: string[],
  ): Promise<{
    filesChanged: string[];
    createdFiles: string[];
    turnsWithSnapshot: number;
    /** False: some turn has no record of how it ended; a revert can't check it. */
    endRecorded?: boolean;
    /** What the range revert would keep: changed after those turns. */
    kept?: string[];
  } | null> {
    return this.ipcRenderer.invoke("snapshot:files-range", { chatId, turnIds });
  }

  /** Main → renderer: live task-ledger plan for PlanCard. */
  public onPlanUpdate(
    chatId: number,
    handler: (payload: PlanUpdatePayload) => void,
  ): () => void {
    let set = this.planUpdateHandlers.get(chatId);
    if (!set) {
      set = new Set();
      this.planUpdateHandlers.set(chatId, set);
    }
    set.add(handler);
    return () => {
      const s = this.planUpdateHandlers.get(chatId);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) this.planUpdateHandlers.delete(chatId);
    };
  }

  public onPlanArtifactActivated(
    handler: (
      payload: import("./utils/emit_plan_artifact").PlanArtifactPayload,
    ) => void,
  ): () => void {
    this.planArtifactHandlers.add(handler);
    return () => this.planArtifactHandlers.delete(handler);
  }

  public onPlanArtifactUpdated(
    handler: (
      payload: import("./utils/emit_plan_artifact").PlanArtifactPayload,
    ) => void,
  ): () => void {
    this.planArtifactUpdatedHandlers.add(handler);
    return () => this.planArtifactUpdatedHandlers.delete(handler);
  }

  /** v10: latest context assembly report for the context meter. */
  public onContextReport(
    handler: (payload: import("./ipc_types").ChatContextReport) => void,
  ): () => void {
    this.contextReportHandlers.add(handler);
    return () => this.contextReportHandlers.delete(handler);
  }

  /** Live per-turn token usage (real per-step + throttled stream estimates). */
  public onTokenUsage(handler: (payload: ChatTokenUsage) => void): () => void {
    this.tokenUsageHandlers.add(handler);
    return () => this.tokenUsageHandlers.delete(handler);
  }

  /** BYOK transcription providers offered in the composer: every provider the
   * user has a key for that can also accept audio. MAY BE EMPTY — the mic then
   * falls back to the selected model's own audio input, or hides. Main-process
   * only (the catalog touches fs), hence the IPC. */
  public async listTranscriptionProviders(): Promise<
    Array<{ id: string; label: string }>
  > {
    return (await this.ipcRenderer.invoke(
      "voice:list-transcription-providers",
    )) as Array<{ id: string; label: string }>;
  }

  /** BYOK cloud transcription — main holds the key and resolves the endpoint +
   * STT model from the live catalog, so `provider` is any provider id (not a
   * fixed set). Returns the transcript text; throws on failure. */
  public async transcribeAudioCloud(params: {
    provider: string;
    mimeType: string;
    dataBase64: string;
    language?: string;
    /** Optional explicit STT model; otherwise catalog-resolved. */
    model?: string;
  }): Promise<string> {
    const res = (await this.ipcRenderer.invoke(
      "voice:transcribe-cloud",
      params,
    )) as { ok: true; text: string } | { ok: false; error: string };
    if (!res.ok) throw new Error(res.error);
    return res.text;
  }

  /**
   * Transcribe through the chat model that is already selected.
   *
   * No key and no transcription provider — main reads the selected model from
   * settings and sends the clip over the same client a chat turn uses. This is
   * the route that makes the mic work on Atlarix Core. Only call it when the
   * model declares audio input (`supportsAudioInput`).
   */
  public async transcribeAudioWithModel(params: {
    mimeType: string;
    dataBase64: string;
    language?: string;
    chatId?: number;
    requestId?: string;
  }): Promise<string> {
    const res = (await this.ipcRenderer.invoke(
      "voice:transcribe-model",
      params,
    )) as { ok: true; text: string } | { ok: false; error: string };
    if (!res.ok) throw new Error(res.error);
    return res.text;
  }

  /** Atlarix Auto's live readout: which model answered, free share left. */
  public onAutoStatus(
    listener: (status: import("@/main/auto-status").AutoStatus) => void,
  ): () => void {
    const off = this.ipcRenderer.on("core:auto-status", (payload: unknown) =>
      listener(payload as import("@/main/auto-status").AutoStatus),
    );
    return typeof off === "function" ? off : () => {};
  }

  /**
   * Streamed transcript preview from `voice:transcribe-model`. The text is the
   * whole transcript so far, not a delta.
   */
  public onVoiceTranscriptPartial(
    listener: (payload: { requestId?: string; text: string }) => void,
  ): () => void {
    const off = this.ipcRenderer.on(
      "voice:transcript-partial",
      (payload: unknown) =>
        listener(payload as { requestId?: string; text: string }),
    );
    return typeof off === "function" ? off : () => {};
  }

  // ── v10 interactive PTY terminal ────────────────────────────────────────

  public async spawnPty(params: {
    instanceId: string;
    cwd: string;
    cols?: number;
    rows?: number;
    scopeKey?: string;
  }): Promise<{ ok: true; pid: number } | { ok: false; error: string }> {
    return this.ipcRenderer.invoke("pty:spawn", params);
  }

  public sendPtyInput(instanceId: string, data: string): void {
    this.ipcRenderer.send("pty:input", { instanceId, data });
  }

  public sendPtyResize(instanceId: string, cols: number, rows: number): void {
    this.ipcRenderer.send("pty:resize", { instanceId, cols, rows });
  }

  public async killPty(instanceId: string): Promise<void> {
    await this.ipcRenderer.invoke("pty:kill", { instanceId });
  }

  public onPtyData(
    handler: (payload: { instanceId: string; data: string }) => void,
  ): () => void {
    const listener = (payload: unknown) =>
      handler(payload as { instanceId: string; data: string });
    this.ipcRenderer.on("pty:data", listener);
    return () => this.ipcRenderer.removeListener("pty:data", listener);
  }

  public onPtyExit(
    handler: (payload: { instanceId: string; exitCode: number }) => void,
  ): () => void {
    const listener = (payload: unknown) =>
      handler(payload as { instanceId: string; exitCode: number });
    this.ipcRenderer.on("pty:exit", listener);
    return () => this.ipcRenderer.removeListener("pty:exit", listener);
  }

  /** Live cwd updates from shell OSC 7 / 1337 sequences (tab labels). */
  public onPtyCwd(
    handler: (payload: { instanceId: string; cwd: string }) => void,
  ): () => void {
    const listener = (payload: unknown) =>
      handler(payload as { instanceId: string; cwd: string });
    this.ipcRenderer.on("pty:cwd", listener);
    return () => this.ipcRenderer.removeListener("pty:cwd", listener);
  }

  /** Persist serialized xterm scrollback so it survives app restarts. */
  public async savePtyScrollback(
    instanceId: string,
    data: string,
  ): Promise<void> {
    await this.ipcRenderer.invoke("pty:scrollback:save", { instanceId, data });
  }

  public async loadPtyScrollback(instanceId: string): Promise<string | null> {
    const result = (await this.ipcRenderer.invoke("pty:scrollback:load", {
      instanceId,
    })) as { data: string | null };
    return result?.data ?? null;
  }

  public activatePlanArtifact(
    payload: import("./utils/emit_plan_artifact").PlanArtifactPayload,
  ): void {
    this.ipcRenderer.send("plan:artifact-activated", payload);
  }

  public async updatePlanArtifactContent(
    planId: string,
    content: string,
  ): Promise<import("./utils/emit_plan_artifact").PlanArtifactPayload> {
    return this.ipcRenderer.invoke("plans:update", { planId, content });
  }

  public async setPlanArtifactStatus(
    planId: string,
    planStatus: "plan" | "building" | "built",
  ): Promise<import("./utils/emit_plan_artifact").PlanArtifactPayload> {
    return this.ipcRenderer.invoke("plans:set-status", { planId, planStatus });
  }

  public async getPlanArtifact(
    planId: string,
  ): Promise<import("./utils/emit_plan_artifact").PlanArtifactPayload | null> {
    return this.ipcRenderer.invoke("plans:get", planId);
  }

  /** Every plan in a session, newest first — the Plan panel's switcher. */
  public async listPlanArtifactsForSession(
    sessionId: string,
  ): Promise<import("./utils/emit_plan_artifact").PlanArtifactPayload[]> {
    return this.ipcRenderer.invoke("plans:list-by-session", sessionId);
  }

  /** Plans from this folder's other sessions — the switcher's "Earlier sessions". */
  public async listPlanArtifactsForWorkspace(
    workspaceId: number,
    excludeSessionId?: string,
  ): Promise<
    Array<
      import("./utils/emit_plan_artifact").PlanArtifactPayload & {
        sessionTitle: string | null;
      }
    >
  > {
    return this.ipcRenderer.invoke("plans:list-by-workspace", {
      workspaceId,
      excludeSessionId,
    });
  }

  /** "Use in this session": copy an earlier plan into the session to build it. */
  public async copyPlanArtifactToSession(
    planId: string,
    sessionId: string,
  ): Promise<import("./utils/emit_plan_artifact").PlanArtifactPayload> {
    return this.ipcRenderer.invoke("plans:copy-to-session", {
      planId,
      sessionId,
    });
  }

  public onPlanFileUpdated(
    handler: (payload: { workspacePath: string; mtime: number | null }) => void,
  ): () => void {
    this.planFileUpdatedHandlers.add(handler);
    return () => this.planFileUpdatedHandlers.delete(handler);
  }

  /** v3.5: Register for chat activity (e.g. summarization). Returns unsubscribe. */
  public onChatActivity(
    handler: (payload: {
      label?: string;
      status?: string;
      chatId?: number;
    }) => void,
  ): () => void {
    this.chatActivityHandlers.add(handler);
    return () => this.chatActivityHandlers.delete(handler);
  }

  /** v3.5: Register for tool start/end events (persistent "Working…" indicator). Returns unsubscribe. */
  public onToolIndicator(
    onStart: (payload: {
      chatId: number;
      toolName: string;
      toolId?: string;
      /** AI SDK per-invocation id (Fix 2) — stable thread-item key. */
      toolCallId?: string;
      toolArgs?: Record<string, unknown>;
    }) => void,
    onEnd: (payload: {
      chatId: number;
      toolId?: string;
      toolCallId?: string;
      toolName?: string;
      status?: "success" | "error";
    }) => void,
  ): () => void {
    this.toolStartHandlers.add(onStart);
    this.toolEndHandlers.add(onEnd);
    return () => {
      this.toolStartHandlers.delete(onStart);
      this.toolEndHandlers.delete(onEnd);
    };
  }

  /** Stream phase from main process (thinking/responding/done + v13 waiting_on_command/command_done). */
  public onStreamPhase(
    handler: (payload: {
      chatId: number;
      phase: string;
      label: string;
      commandId?: string;
      command?: string;
      startedAt?: number;
    }) => void,
  ): () => void {
    this.streamPhaseHandlers.add(handler);
    return () => {
      this.streamPhaseHandlers.delete(handler);
    };
  }

  /** Lightweight activity pulse during silent stream phases (e.g. tool-input-delta). */
  public onStreamPulse(
    handler: (payload: { chatId: number; timestamp: number }) => void,
  ): () => void {
    this.streamPulseHandlers.add(handler);
    return () => {
      this.streamPulseHandlers.delete(handler);
    };
  }

  /** Fired only when the backend retries a dropped/stalled round (genuine reconnect). */
  public onStreamResetPartial(
    handler: (payload: { chatId: number }) => void,
  ): () => void {
    this.streamResetPartialHandlers.add(handler);
    return () => {
      this.streamResetPartialHandlers.delete(handler);
    };
  }

  /** Live partial tool-call arguments → renderer streaming preview. */
  public onStreamToolInput(
    handler: (payload: {
      chatId: number;
      toolCallId: string;
      toolName: string;
      argsTextSoFar: string;
    }) => void,
  ): () => void {
    this.streamToolInputHandlers.add(handler);
    return () => {
      this.streamToolInputHandlers.delete(handler);
    };
  }

  /**
   * Display-only old/new content for an AUTO-APPROVED write (no permission
   * preview reached the renderer). Lets the completed card render an accurate
   * red/green overwrite diff. Never part of the model conversation.
   */
  public onStreamWritePreview(
    handler: (payload: {
      chatId: number;
      path: string;
      operation: string;
      oldContent: string;
      content: string;
      /** Hunks computed in main — keeps the Myers diff off the UI thread. */
      hunks?: unknown[];
      addedCount?: number;
      removedCount?: number;
    }) => void,
  ): () => void {
    this.streamWritePreviewHandlers.add(handler);
    return () => {
      this.streamWritePreviewHandlers.delete(handler);
    };
  }

  /** Fix: Finding 4 — models.dev background refresh status */
  public onModelsDevStatus(
    handler: (payload: { message: string; timedOut?: boolean }) => void,
  ): () => void {
    this.modelsDevStatusHandlers.add(handler);
    return () => {
      this.modelsDevStatusHandlers.delete(handler);
    };
  }

  /** Atlarix Core model ids changed at runtime (hosted core-models.json refresh). */
  public onCoreModelsChanged(handler: () => void): () => void {
    this.coreModelsChangedHandlers.add(handler);
    return () => {
      this.coreModelsChangedHandlers.delete(handler);
    };
  }

  /**
   * The "what's new" note, resolved in main from the hosted updates.json.
   * Returns null when there is nothing to show — which includes every failure
   * mode, because a panel that cannot say anything should not appear.
   */
  public async getWhatsNew(): Promise<
    import("@/main/whats-new").WhatsNewEntry | null
  > {
    try {
      return (await this.ipcRenderer.invoke("whats-new:get")) ?? null;
    } catch {
      return null;
    }
  }

  /** The hosted note changed (hourly refresh, or a manual one). */
  public onWhatsNewChanged(handler: () => void): () => void {
    const off = this.ipcRenderer.on("whats-new:changed", () => handler());
    return typeof off === "function" ? off : () => {};
  }

  /** Fix: Finding 1 — Electron fullscreen enter/leave */
  public onWindowFullscreenChanged(
    handler: (payload: { fullscreen: boolean }) => void,
  ): () => void {
    this.windowFullscreenHandlers.add(handler);
    return () => {
      this.windowFullscreenHandlers.delete(handler);
    };
  }

  public static getInstance(): IpcClient {
    if (!IpcClient.instance) {
      IpcClient.instance = new IpcClient();
    }
    return IpcClient.instance;
  }

  public async restartAtlarix(): Promise<void> {
    await this.ipcRenderer.invoke("restart-atlarix");
  }

  public async reloadEnvPath(): Promise<void> {
    await this.ipcRenderer.invoke("reload-env-path");
  }

  public async getApp(appId: number): Promise<App> {
    return this.ipcRenderer.invoke("get-app", appId);
  }

  public async addAppToFavorite(
    appId: number,
  ): Promise<{ isFavorite: boolean }> {
    try {
      const result = await this.ipcRenderer.invoke("add-to-favorite", {
        appId,
      });
      return result;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  public async getAppEnvVars(
    params: GetAppEnvVarsParams,
  ): Promise<{ key: string; value: string }[]> {
    return this.ipcRenderer.invoke("get-app-env-vars", params);
  }

  public async setAppEnvVars(params: SetAppEnvVarsParams): Promise<void> {
    return this.ipcRenderer.invoke("set-app-env-vars", params);
  }

  public async getChat(chatId: number): Promise<Chat> {
    try {
      const data = await this.ipcRenderer.invoke("get-chat", chatId);
      this.hydrateRendererAttachmentStore(data.messages ?? []);
      return data;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  private hydrateRendererAttachmentStore(
    messages: Array<{
      fileAttachments?: import("./ipc_types").StoredFileAttachment[] | null;
      pasteAttachments?: import("./ipc_types").PasteAttachmentMeta[] | null;
    }>,
  ): void {
    import("@/lib/attachment-persistence")
      .then(({ hydrateAttachmentStoreFromMessages }) => {
        hydrateAttachmentStoreFromMessages(messages);
      })
      .catch(() => {});
  }

  /** @deprecated Legacy DB chats removed — use listWorkspaceSessions. */
  public async getChats(appId?: number): Promise<ChatSummary[]> {
    if (appId == null) return [];
    const sessions = await this.listWorkspaceSessions(appId);
    return sessions.map(
      (s: { id: string; title: string | null; createdAt: Date }) => ({
        id: s.id as unknown as number,
        title: s.title,
        createdAt: s.createdAt,
        appId,
      }),
    );
  }

  /** @deprecated Legacy DB chat search removed. */
  public async searchChats(
    _appId: number,
    _query: string,
  ): Promise<ChatSearchResult[]> {
    return [];
  }

  // Get all apps
  public async listApps(): Promise<ListAppsResponse> {
    return this.ipcRenderer.invoke("list-apps");
  }

  // Search apps by name
  public async searchApps(searchQuery: string): Promise<AppSearchResult[]> {
    try {
      const data = await this.ipcRenderer.invoke("search-app", searchQuery);
      return AppSearchResultsSchema.parse(data);
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // New method for streaming responses
  /**
   * v14.8.10 Fix S: mark a chat:stream dispatch in flight. While pending, EVERY
   * chat:response:* event for the chat predates the new leg by construction
   * (the backend assigns the new streamId and replies before the new leg emits
   * anything, and IPC delivery is ordered) — so those events belong to the
   * dying leg and are dropped.
   */
  private beginStreamDispatch(chatId: number): void {
    // A fresh dispatch supersedes any prior optimistic Stop for this chat.
    this.optimisticallyCancelled.delete(chatId);
    this.pendingStreamDispatch.set(
      chatId,
      (this.pendingStreamDispatch.get(chatId) ?? 0) + 1,
    );
  }

  /** Resolve a dispatch: record the new leg's streamId (from the invoke reply). */
  private endStreamDispatch(chatId: number, result: unknown): void {
    const n = (this.pendingStreamDispatch.get(chatId) ?? 1) - 1;
    if (n <= 0) this.pendingStreamDispatch.delete(chatId);
    else this.pendingStreamDispatch.set(chatId, n);
    const dropped = (result as { dropped?: string } | null | undefined)
      ?.dropped;
    if (dropped) {
      // Main refused a system wake (a turn is already live for this chat, or the
      // user stopped it). No stream started, so no terminal event is coming and
      // this window would otherwise sit at `isStreaming: true` forever.
      //
      // Settled here, on the invoke REPLY, deliberately not through `onEnd`:
      // `onEnd` is the auto-wake race-closer, so synthesising an end for a
      // refused wake would immediately fire another wake and trade the stream
      // loop for an IPC one.
      this.streamDroppedListeners.forEach((fn) => {
        try {
          fn({ chatId, reason: dropped });
        } catch {
          /* one bad listener must not strand the rest */
        }
      });
      return;
    }
    const sid = (result as { streamId?: number } | null | undefined)?.streamId;
    if (typeof sid === "number") {
      const cur = this.currentStreamIdByChat.get(chatId);
      if (cur == null || sid > cur) this.currentStreamIdByChat.set(chatId, sid);
    }
  }

  /**
   * Notified when main REFUSES a dispatch outright (a dropped system wake).
   * Distinct from `onEnd`: nothing ran, and the auto-wake path must not fire.
   */
  private streamDroppedListeners = new Set<
    (e: { chatId: number; reason: string }) => void
  >();

  public onStreamDropped(
    fn: (e: { chatId: number; reason: string }) => void,
  ): () => void {
    this.streamDroppedListeners.add(fn);
    return () => this.streamDroppedListeners.delete(fn);
  }

  /** True when a chat:response:* event belongs to a superseded stream leg. */
  private shouldDropStreamEvent(chatId: number, streamId: unknown): boolean {
    if ((this.pendingStreamDispatch.get(chatId) ?? 0) > 0) return true;
    if (typeof streamId !== "number") return false; // unstamped (legacy paths) → accept
    const current = this.currentStreamIdByChat.get(chatId);
    if (current == null) {
      this.currentStreamIdByChat.set(chatId, streamId);
      return false;
    }
    if (streamId < current) return true;
    if (streamId > current) this.currentStreamIdByChat.set(chatId, streamId);
    return false;
  }

  public streamMessage(
    prompt: string,
    options: {
      /** User-visible message text (optional; defaults to `prompt`). */
      displayPrompt?: string;
      pasteAttachments?: import("./ipc_types").PasteAttachmentMeta[];
      chatId: number;
      redo?: boolean;
      attachments?: FileAttachment[];
      appId?: number | null;
      modelOverride?: { provider: string; name: string };
      onUpdate: (messages: Message[]) => void;
      onEnd: (response: ChatResponseEnd) => void;
      onError: (error: string) => void;
      onProblems?: (problems: ChatProblemsEvent) => void;
      /** v3.9: Continue after clarifying questions (no new user message; use last user message content). */
      continueAfterQuestions?: boolean;
      /** Resume an interrupted turn: no new user message; model gets a system-reminder directive. */
      continueInterrupted?: boolean;
      /** The HARNESS started this turn (background result, scheduled wake, self-correct)
       *  — main refuses it rather than interrupting a live or user-stopped chat. */
      systemWake?: boolean;
      workspaceSessionId?: string | null;
      prefillTaskLedger?: {
        steps: { description: string }[];
        sourcePlanMessageId?: number;
      };
      /** Resend/edit: work mode for this turn only. */
      workModeOverride?: import("@/lib/schemas").WorkMode;
      /** The chat's own effort for its model (15.11.1). */
      effortOverride?: { effort: string; deepThinking: boolean };
      /** "Try with a stronger model" (paid Atlarix Auto). */
      escalate?: boolean;
      /** The user's Retry (`X-Atlarix-Retry` on the first Core request). */
      userRetry?: boolean;
    },
  ): void {
    const {
      chatId,
      redo,
      attachments,
      appId,
      modelOverride,
      onUpdate,
      onEnd,
      onError,
      continueAfterQuestions,
      continueInterrupted,
      systemWake,
      workspaceSessionId,
      prefillTaskLedger,
      workModeOverride,
      effortOverride,
      escalate,
      userRetry,
      displayPrompt,
      pasteAttachments,
    } = options;
    this.chatStreams.set(chatId, { onUpdate, onEnd, onError });
    this.beginStreamDispatch(chatId);

    const fileAttachments = attachments?.filter((a) => a.file != null) ?? [];

    // Handle file attachments if provided
    if (fileAttachments.length > 0) {
      Promise.all(fileAttachments.map((a) => encodeFileAttachmentForStream(a)))
        .then((fileDataArray) => {
          // Use invoke to start the stream and pass the chatId and attachments
          this.ipcRenderer
            .invoke("chat:stream", {
              prompt,
              displayPrompt: displayPrompt ?? undefined,
              pasteAttachments: pasteAttachments ?? undefined,
              chatId,
              redo,
              appId: appId ?? undefined,
              attachments: fileDataArray,
              modelOverride: modelOverride ?? undefined,
              continueAfterQuestions: continueAfterQuestions ?? undefined,
              continueInterrupted: continueInterrupted ?? undefined,
              systemWake: systemWake ?? undefined,
              workspaceSessionId: workspaceSessionId ?? undefined,
              prefillTaskLedger: prefillTaskLedger ?? undefined,
              workModeOverride: workModeOverride ?? undefined,
              effortOverride: effortOverride ?? undefined,
              escalate: escalate || undefined,
              userRetry: userRetry || undefined,
            })
            .then((res) => this.endStreamDispatch(chatId, res))
            .catch((err) => {
              this.endStreamDispatch(chatId, undefined);
              console.error("Error streaming message:", err);
              showError(err);
              onError(String(err));
              this.chatStreams.delete(chatId);
            });
        })
        .catch((err) => {
          this.endStreamDispatch(chatId, undefined);
          console.error("Error streaming message:", err);
          showError(err);
          onError(String(err));
          this.chatStreams.delete(chatId);
        });
    } else {
      // No attachments, proceed normally
      this.ipcRenderer
        .invoke("chat:stream", {
          prompt,
          displayPrompt: displayPrompt ?? undefined,
          pasteAttachments: pasteAttachments ?? undefined,
          chatId,
          redo,
          appId: appId ?? undefined,
          modelOverride: modelOverride ?? undefined,
          continueAfterQuestions: continueAfterQuestions ?? undefined,
          continueInterrupted: continueInterrupted ?? undefined,
          systemWake: systemWake ?? undefined,
          workspaceSessionId: workspaceSessionId ?? undefined,
          prefillTaskLedger: prefillTaskLedger ?? undefined,
          workModeOverride: workModeOverride ?? undefined,
              effortOverride: effortOverride ?? undefined,
          escalate: escalate || undefined,
          userRetry: userRetry || undefined,
        })
        .then((res) => this.endStreamDispatch(chatId, res))
        .catch((err) => {
          this.endStreamDispatch(chatId, undefined);
          console.error("Error streaming message:", err);
          showError(err);
          onError(String(err));
          this.chatStreams.delete(chatId);
        });
    }
  }

  // Method to cancel an ongoing stream (stops AI to save tokens)
  public cancelChatStream(chatId: number): void {
    // Instant UI stop: suppress further chunks NOW so the composer/list stop
    // re-rendering immediately, before the async backend teardown lands. The
    // response:end (or a new dispatch) clears this flag.
    this.optimisticallyCancelled.add(chatId);
    // Fire-and-forget the backend teardown (do not await — keeps the click
    // handler off the IPC round-trip so the cursor never beachballs).
    void this.ipcRenderer.invoke("chat:cancel", chatId);
    // Also abort the backend stream to save tokens
    void this.ipcRenderer.invoke("chat:abort", chatId);
  }

  // FIX 4: re-dispatch the last `chat:stream` request for this chat. Backend
  // emits `chat:stream:reset-partial` before kicking off the fresh stream
  // so the renderer can clear its in-flight assistant buffer.
  public async reconnectStream(
    chatId: number,
  ): Promise<{ success: boolean; message?: string }> {
    return this.ipcRenderer.invoke("chat:stream:reconnect", { chatId });
  }

  /** New workspace session row + ephemeral stream transport. */
  public async startWorkspaceConversation(workspaceId: number): Promise<{
    sessionId: string;
    chatId: number;
    session: {
      id: string;
      workspaceId: number;
      title: string;
      /** What it was stamped with (15.11.1). */
      workMode?: import("@/lib/schemas").WorkMode | null;
      model?: import("@/lib/session-choices").SessionModelChoice | null;
      createdAt: Date;
      updatedAt: Date;
    };
  }> {
    return this.ipcRenderer.invoke("sessions:start", workspaceId);
  }

  /** Ephemeral transport for an existing session (reuses stored stream_chat_id when valid). */
  public async allocateSessionTransport(sessionId: string): Promise<{
    chatId: number;
  }> {
    return this.ipcRenderer.invoke("sessions:allocate-transport", sessionId);
  }

  /** Resolve or bind persisted session for an ephemeral transport chat id. */
  public async resolveWorkspaceSessionForTransport(
    chatId: number,
    workspaceId: number,
  ): Promise<string> {
    return this.ipcRenderer.invoke("sessions:resolve-for-transport", {
      chatId,
      workspaceId,
    });
  }

  /**
   * Hydrate a chat's transport for a persisted session WITHOUT re-sending its bodies.
   *
   * Main already holds every byte (it just read them for `sessions:get`). The only
   * thing it cannot know is the numeric display id the renderer allocated for each
   * row, so that — plus the row UUID it maps to — is all that crosses IPC. Order is
   * significant and is taken from this array.
   */
  public async hydrateSessionTransport(
    chatId: number,
    sessionId: string,
    rows: { id: number; sessionRowId?: string | null }[],
  ): Promise<{ hydrated: number }> {
    return this.ipcRenderer.invoke("sessions:hydrate-transport", {
      chatId,
      sessionId,
      rows,
    });
  }

  public async listWorkspaceSessions(workspaceId: number) {
    return this.ipcRenderer.invoke("sessions:list", workspaceId);
  }

  public async createWorkspaceSession(workspaceId: number) {
    return this.ipcRenderer.invoke("sessions:create", workspaceId);
  }

  // ── Automations ────────────────────────────────────────────────────────────

  public async listAutomations(workspaceId: number): Promise<{
    automations: Array<{
      id: string;
      workspaceId: number | null;
      name: string;
      enabled: boolean;
      trigger: unknown;
      prompt: string;
      runMode: "notify-only" | "read-only";
      notifyAgent: boolean;
      model: { provider: string; name: string } | null;
      lastRunAt: number | null;
      createdAt: number;
    }>;
    unreadCount: number;
  }> {
    return this.ipcRenderer.invoke("automations:list", workspaceId);
  }

  public async createAutomation(
    workspaceId: number,
    input: unknown,
  ): Promise<{ id: string }> {
    return this.ipcRenderer.invoke("automations:create", {
      workspaceId,
      input,
    });
  }

  public async updateAutomation(
    id: string,
    input: unknown,
  ): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke("automations:update", { id, input });
  }

  public async deleteAutomation(id: string): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke("automations:delete", id);
  }

  public async toggleAutomation(
    id: string,
    enabled: boolean,
  ): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke("automations:toggle", { id, enabled });
  }

  public async runAutomationNow(id: string): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke("automations:run-now", id);
  }

  public async listAutomationRuns(
    workspaceId: number,
    includeArchived = false,
  ): Promise<import("@/lib/automations/types").AutomationRunView[]> {
    return this.ipcRenderer.invoke("automations:runs", {
      workspaceId,
      includeArchived,
    });
  }

  public async markAutomationRunsRead(
    runIds: string[],
  ): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke("automations:mark-read", runIds);
  }

  public async archiveAutomationRun(runId: string): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke("automations:archive", runId);
  }

  /** Subscribe to live automation run updates (triage feed). Returns unsubscribe. */
  public onAutomationRunUpdate(
    handler: (
      view: import("@/lib/automations/types").AutomationRunView,
    ) => void,
  ): () => void {
    const unsubscribe = this.ipcRenderer.on(
      "automation:run-update",
      (payload: unknown) =>
        handler(payload as import("@/lib/automations/types").AutomationRunView),
    );
    return typeof unsubscribe === "function" ? unsubscribe : () => {};
  }

  /**
   * A definition was created/updated/deleted anywhere — including by the AGENT,
   * which writes in main and would otherwise leave the panel stale.
   */
  public onAutomationsChanged(handler: () => void): () => void {
    const unsubscribe = this.ipcRenderer.on("automations:changed", () =>
      handler(),
    );
    return typeof unsubscribe === "function" ? unsubscribe : () => {};
  }

  /** OS-notification click: focus the automations feed (optionally at a run). */
  public onAutomationsFocusFeed(
    handler: (payload: { runId?: string }) => void,
  ): () => void {
    const unsubscribe = this.ipcRenderer.on(
      "automations:focus-feed",
      (payload: unknown) => handler(payload as { runId?: string }),
    );
    return typeof unsubscribe === "function" ? unsubscribe : () => {};
  }

  /**
   * Run the diagnostics checks. Returns the structured report; the pasteable text
   * comes from `copyDoctorReport` so the redaction stays in main, next to the data
   * it protects.
   */
  public async runDoctor(): Promise<import("@/main/doctor").DoctorReport> {
    return this.ipcRenderer.invoke("doctor:run");
  }

  /** The last report as redacted text, ready to paste to support. */
  public async copyDoctorReport(): Promise<string> {
    return this.ipcRenderer.invoke("doctor:copy-report");
  }

  public async renameWorkspaceSession(sessionId: string, title: string) {
    return this.ipcRenderer.invoke("sessions:rename", sessionId, title);
  }

  /** The surface running a turn of this session right now (then this window follows it), or null. */
  public async sessionRunningElsewhere(
    sessionId: string,
  ): Promise<{ surface: "cli" | "app" | "chrome" | "editor"; name: string } | null> {
    return this.ipcRenderer.invoke("sessions:running-elsewhere", sessionId);
  }

  /** Changes whenever the session's saved messages do. */
  public async sessionRevision(sessionId: string): Promise<string> {
    return this.ipcRenderer.invoke("sessions:revision", sessionId);
  }

  /** What the user typed, for the turn running elsewhere. `error: "not running"` once it has ended. */
  public async steerRemoteSession(sessionId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    return this.ipcRenderer.invoke("sessions:steer-remote", sessionId, text);
  }

  public async stopRemoteSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    return this.ipcRenderer.invoke("sessions:stop-remote", sessionId);
  }

  /** A copy of the conversation as saved now, as a new session in the same folder. */
  public async forkWorkspaceSession(sessionId: string, title?: string) {
    return this.ipcRenderer.invoke("sessions:fork", sessionId, title ? { title } : undefined);
  }

  /**
   * Stamp the model (with its effort) this session runs on: a pick made while it
   * is on screen. Only this chat changes (15.11.1).
   */
  public async setWorkspaceSessionModel(
    sessionId: string,
    choice: import("@/lib/session-choices").SessionModelChoice,
  ) {
    return this.ipcRenderer.invoke("sessions:set-model", sessionId, choice);
  }

  /** Tell main which chat this window has in front (a model written here is that chat's). */
  public async setFrontSession(sessionId: string | null) {
    return this.ipcRenderer.invoke("sessions:set-front", sessionId);
  }

  /** The model main stored on this window's chat in front (after a model write here). */
  public onSessionModel(
    listener: (p: { sessionId: string; model: import("@/lib/session-choices").SessionModelChoice | null }) => void,
  ): () => void {
    const off = this.ipcRenderer.on("session:model", (payload) => listener(payload as never));
    return typeof off === "function" ? off : () => {};
  }

  /** Stamp the session's work mode: a pick made while it is on screen. Only this chat changes. */
  public async setWorkspaceSessionWorkMode(
    sessionId: string,
    workMode: import("@/lib/schemas").WorkMode,
  ) {
    return this.ipcRenderer.invoke(
      "sessions:set-work-mode",
      sessionId,
      workMode,
    );
  }

  public async deleteWorkspaceSession(
    sessionId: string,
  ): Promise<{ ok: boolean; streamChatId: number | null }> {
    return this.ipcRenderer.invoke("sessions:delete", sessionId);
  }

  /** Delete `sessionId` only if it is truly empty (the one being left). */
  public async pruneWorkspaceSessionIfEmpty(
    sessionId: string,
  ): Promise<{ pruned: boolean; streamChatId: number | null }> {
    return this.ipcRenderer.invoke("sessions:prune-if-empty", sessionId);
  }

  public async getWorkspaceSession(
    sessionId: string,
    opts?: { limit?: number },
  ) {
    return this.ipcRenderer.invoke("sessions:get", sessionId, opts);
  }

  /** Issue 4: promote an interrupted assistant row to a normal history message. */
  public async markSessionMessageComplete(
    rowId: string,
  ): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke("messages:mark-complete", rowId);
  }

  public async generateWorkspaceSessionTitle(
    sessionId: string,
  ): Promise<{ title: string }> {
    return this.ipcRenderer.invoke("sessions:generate-title", sessionId);
  }

  /** Another session set one of this window's sessions' mode and/or model (item 9). */
  public onPeerSessionSettings(
    listener: (p: {
      chatId: number;
      sessionId: string;
      mode?: import("@/lib/schemas").WorkMode;
      model?: { provider: string; name: string; label: string };
      plan?: "approve" | "reject" | "update";
      notice: string;
    }) => void,
  ): () => void {
    const off = this.ipcRenderer.on("session:peer-settings", (payload) => listener(payload as never));
    return typeof off === "function" ? off : () => {};
  }

  /** The stored sessions changed, whoever changed them (the CLI or an editor too). */
  public onSessionsChanged(listener: () => void): () => void {
    const off = this.ipcRenderer.on("sessions:changed", () => listener());
    return typeof off === "function" ? off : () => {};
  }

  /** Main named a session (placeholder or generated title). */
  public onSessionTitleUpdated(
    listener: (payload: { sessionId: string; title: string }) => void,
  ): () => void {
    const off = this.ipcRenderer.on("sessions:title-updated", (payload) =>
      listener(payload as { sessionId: string; title: string }),
    );
    return typeof off === "function" ? off : () => {};
  }

  public async addSessionMessage(
    sessionId: string,
    role: "user" | "assistant" | "tool",
    content: string,
    displaySnapshot?: string,
    extras?: {
      modelContent?: string | null;
      pasteAttachments?: import("./ipc_types").PasteAttachmentMeta[] | null;
      fileAttachments?: import("./ipc_types").StoredFileAttachment[] | null;
      snapshotTurnId?: string | null;
    },
  ) {
    return this.ipcRenderer.invoke(
      "messages:add",
      sessionId,
      role,
      content,
      displaySnapshot,
      extras,
    );
  }

  public async setChatDisplaySnapshot(params: {
    chatId: number;
    messageId: number;
    displaySnapshot: string;
  }): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke("chat:set-display-snapshot", params);
  }

  public async saveMessageDisplaySnapshot(params: {
    messageId: number;
    displaySnapshot: string;
  }): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke("messages:save-display-snapshot", params);
  }

  public async saveSessionMessageDisplaySnapshot(params: {
    sessionMessageId: string;
    displaySnapshot: string;
  }): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke(
      "session-messages:save-display-snapshot",
      params,
    );
  }

  public async updateChat(_params: UpdateChatParams): Promise<void> {
    throw new Error("Legacy chat rename removed; use renameWorkspaceSession");
  }

  public async deleteChat(_chatId: number): Promise<void> {
    throw new Error("Legacy chat delete removed; use deleteWorkspaceSession");
  }

  // Open an external URL using the default browser
  /** A local relic's index.html, for the chat's inline preview (RelicCard). */
  public async readLocalRelic(
    file: string,
  ): Promise<{ html: string } | { error: string }> {
    return this.ipcRenderer.invoke("relics:read-local", file);
  }

  /** Your hosted relics and this workspace's local ones, newest first (the Relics tab). */
  public async listRelics(workspacePath: string): Promise<RelicSummary[]> {
    return this.ipcRenderer.invoke("relics:list", workspacePath);
  }

  public async deleteRelic(
    relic: Pick<RelicSummary, "id" | "hosted" | "path">,
  ): Promise<void> {
    return this.ipcRenderer.invoke("relics:delete", relic);
  }

  public async setRelicVisibility(
    id: string,
    visibility: "private" | "link",
  ): Promise<void> {
    return this.ipcRenderer.invoke("relics:set-visibility", id, visibility);
  }

  public async openExternalUrl(url: string): Promise<void> {
    await this.ipcRenderer.invoke("open-external-url", url);
  }

  /** The session rating's shared quiet period, and ATLARIX_FORCE_RATING. */
  public async getFeedbackState(): Promise<{ askedAt: number | null; force: boolean }> {
    return this.ipcRenderer.invoke("feedback:state") as Promise<{ askedAt: number | null; force: boolean }>;
  }

  /** 1-3 answers, 0 dismisses; either way it is not asked again for a while. */
  public async rateSession(rating: number, session: FeedbackSessionInfo): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke("feedback:rate", { rating, session }) as Promise<{ ok: boolean }>;
  }

  /** `/feedback`, or the text after a rating. */
  public async sendFeedback(text: string, session: FeedbackSessionInfo): Promise<{ ok: boolean; error?: string }> {
    return this.ipcRenderer.invoke("feedback:send", { text, session }) as Promise<{ ok: boolean; error?: string }>;
  }

  public async showItemInFolder(fullPath: string): Promise<void> {
    await this.ipcRenderer.invoke("show-item-in-folder", fullPath);
  }

  // Run an app
  public async runApp(
    appId: number,
    onOutput: (output: AppOutput) => void,
  ): Promise<void> {
    await this.ipcRenderer.invoke("run-app", { appId });
    this.appStreams.set(appId, { onOutput });
  }

  // Stop a running app
  public async stopApp(appId: number): Promise<void> {
    await this.ipcRenderer.invoke("stop-app", { appId });
  }

  // Restart a running app
  public async restartApp(
    appId: number,
    onOutput: (output: AppOutput) => void,
    removeNodeModules?: boolean,
  ): Promise<{ success: boolean }> {
    try {
      const result = await this.ipcRenderer.invoke("restart-app", {
        appId,
        removeNodeModules,
      });
      this.appStreams.set(appId, { onOutput });
      return result;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // Respond to an app input request (y/n prompts)
  public async respondToAppInput(
    params: RespondToAppInputParams,
  ): Promise<void> {
    try {
      await this.ipcRenderer.invoke("respond-to-app-input", params);
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // Get allow-listed environment variables
  public async getEnvVars(): Promise<Record<string, string | undefined>> {
    try {
      const envVars = await this.ipcRenderer.invoke("get-env-vars");
      return envVars as Record<string, string | undefined>;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // List all versions (commits) of an app
  public async listVersions({ appId }: { appId: number }): Promise<Version[]> {
    try {
      const versions = await this.ipcRenderer.invoke("list-versions", {
        appId,
      });
      return versions;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // Revert to a specific version
  public async revertVersion(
    params: RevertVersionParams,
  ): Promise<RevertVersionResponse> {
    return this.ipcRenderer.invoke("revert-version", params);
  }

  // Checkout a specific version without creating a revert commit
  public async checkoutVersion({
    appId,
    versionId,
  }: {
    appId: number;
    versionId: string;
  }): Promise<void> {
    await this.ipcRenderer.invoke("checkout-version", {
      appId,
      versionId,
    });
  }

  // Get the current branch of an app
  public async getCurrentBranch(appId: number): Promise<BranchResult> {
    return this.ipcRenderer.invoke("get-current-branch", {
      appId,
    });
  }

  // Get user settings
  public async getUserSettings(): Promise<UserSettings> {
    try {
      const settings = await this.ipcRenderer.invoke("get-user-settings");
      return settings;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  /** True when provider keys / OAuth tokens are encrypted at rest (OS keystore
   * available). Fails to `true` (no scary banner) when it can't be determined. */
  public async getSecretEncryptionAvailable(): Promise<boolean> {
    try {
      return (
        (await this.ipcRenderer.invoke(
          "settings:secret-encryption-available",
        )) === true
      );
    } catch {
      return true;
    }
  }

  // Update user settings
  public async setUserSettings(
    settings: Partial<UserSettings>,
  ): Promise<UserSettings> {
    try {
      const updatedSettings = await this.ipcRenderer.invoke(
        "set-user-settings",
        settings,
      );
      return updatedSettings;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // Delete an app and all its files
  public async deleteApp(appId: number): Promise<void> {
    await this.ipcRenderer.invoke("delete-app", { appId });
  }

  // Rename an app (update name and path)
  public async renameApp({
    appId,
    appName,
    appPath,
  }: {
    appId: number;
    appName: string;
    appPath: string;
  }): Promise<void> {
    await this.ipcRenderer.invoke("rename-app", {
      appId,
      appName,
      appPath,
    });
  }

  public async copyApp(params: CopyAppParams): Promise<{ app: App }> {
    return this.ipcRenderer.invoke("copy-app", params);
  }

  // Reset all - removes all app files, settings, and drops the database
  public async resetAll(): Promise<void> {
    await this.ipcRenderer.invoke("reset-all");
  }

  public async addDependency({
    chatId,
    packages,
  }: {
    chatId: number;
    packages: string[];
  }): Promise<void> {
    await this.ipcRenderer.invoke("chat:add-dep", {
      chatId,
      packages,
    });
  }

  // Check Node.js and npm status
  public async getNodejsStatus(): Promise<NodeSystemInfo> {
    return this.ipcRenderer.invoke("nodejs-status");
  }

  /**
   * REMOVED: the GitHub device-flow and repo-management methods.
   *
   * Their only consumer was the clone dialog, and the flow was GitHub-shaped —
   * it could never reach GitLab, Bitbucket or plain SSH. `create-repo`, `push`
   * and `is-repo-available` had already lost their UI callers before that.
   * Cloning is now `git clone` through `run_command`, on any host, with the
   * user's own credentials. Signing in with GitHub is untouched (Supabase).
   */

  // Get the main app version
  public async getAppVersion(): Promise<string> {
    const result = await this.ipcRenderer.invoke("get-app-version");
    return result.version as string;
  }

  /** Get Sentry config (DSN, version, isPackaged) for renderer init and dev test shortcut. */
  public async getSentryConfig(): Promise<{
    dsn: string | undefined;
    version: string;
    isPackaged: boolean;
  }> {
    return this.ipcRenderer.invoke("get-sentry-config");
  }

  /** Dev-only: last N tool execution durations from main (ring buffer). */
  public async getToolPerfSnapshot(): Promise<
    { name: string; ms: number; at: number }[]
  > {
    return this.ipcRenderer.invoke("perf:tool-snapshot");
  }

  /** Get PostHog config (API key + anonymous ID + replay rate) for renderer init. Key undefined if not set. */
  public async getPostHogConfig(): Promise<{
    posthogApiKey: string | undefined;
    analyticsId: string;
    replaySampleRate?: number;
  }> {
    return this.ipcRenderer.invoke("get-posthog-config");
  }

  /** Whether the main process has initialized the database (for loading gate). */
  public async getDbReady(): Promise<boolean> {
    return this.ipcRenderer.invoke("get-db-ready");
  }

  // --- Plugins (plugin_handlers.ts) ---
  public async listPlugins(): Promise<PluginListItem[]> {
    return this.ipcRenderer.invoke("plugins:list");
  }

  public async pluginProblems(workspacePath: string | null): Promise<Array<{ name: string; message: string }>> {
    return this.ipcRenderer.invoke("plugins:problems", { workspacePath });
  }

  public async preparePluginInstall(source: string): Promise<PluginPreviewView> {
    return this.ipcRenderer.invoke("plugins:prepare", { source });
  }

  public async preparePluginUpdate(name: string): Promise<PluginPreviewView> {
    return this.ipcRenderer.invoke("plugins:prepare-update", { name });
  }

  public async commitPluginInstall(params: {
    stagingId: string;
    runnablesConfirmed: boolean;
    folders?: string[] | null;
  }): Promise<{ name: string }> {
    return this.ipcRenderer.invoke("plugins:commit", params);
  }

  public async discardPluginInstall(stagingId: string): Promise<void> {
    return this.ipcRenderer.invoke("plugins:discard", { stagingId });
  }

  public async removePlugin(name: string): Promise<boolean> {
    return this.ipcRenderer.invoke("plugins:remove", { name });
  }

  public async setPluginEnabled(name: string, enabled: boolean): Promise<boolean> {
    return this.ipcRenderer.invoke("plugins:set-enabled", { name, enabled });
  }

  public async setPluginFolders(name: string, folders: string[] | null): Promise<boolean> {
    return this.ipcRenderer.invoke("plugins:set-folders", { name, folders });
  }

  public async setPluginModel(name: string, model: string | null): Promise<boolean> {
    return this.ipcRenderer.invoke("plugins:set-model", { name, model });
  }

  public async reviewPlugin(name: string): Promise<string[]> {
    return this.ipcRenderer.invoke("plugins:review", { name });
  }

  public async approvePlugin(name: string, shown: string[]): Promise<boolean> {
    return this.ipcRenderer.invoke("plugins:approve", { name, shown });
  }

  // --- MCP Client Methods ---
  public async listMcpServers(filter?: {
    scope?: "workspace";
    appId?: number;
  }) {
    return this.ipcRenderer.invoke("mcp:list-servers", filter);
  }

  public async listOrphanedMcpServers() {
    return this.ipcRenderer.invoke("mcp:list-orphaned-servers");
  }

  public async createMcpServer(params: CreateMcpServer) {
    return this.ipcRenderer.invoke("mcp:create-server", params);
  }

  /** MCP servers set up in other tools on this computer, not yet in this folder (no env values). */
  public async discoverExternalMcpServers(appId: number): Promise<
    Array<{ key: string; source: string; name: string; transport: "stdio" | "http"; summary: string; envNames: string[]; scope: "folder" | "everywhere" }>
  > {
    return this.ipcRenderer.invoke("mcp:discover-external", { appId });
  }

  public async importExternalMcpServer(appId: number, key: string) {
    return this.ipcRenderer.invoke("mcp:import-external", { appId, key });
  }

  public async computerUsePermissions(
    request?: "screen" | "accessibility",
  ): Promise<ComputerUsePermissions> {
    return this.ipcRenderer.invoke("computer-use:permissions", request);
  }

  public async relaunchForComputerUse(): Promise<void> {
    await this.ipcRenderer.invoke("computer-use:relaunch");
  }

  public async updateMcpServer(params: McpServerUpdate) {
    return this.ipcRenderer.invoke("mcp:update-server", params);
  }

  public async deleteMcpServer(id: number) {
    return this.ipcRenderer.invoke("mcp:delete-server", id);
  }

  public async listMcpTools(serverId: number) {
    return this.ipcRenderer.invoke("mcp:list-tools", serverId);
  }

  public async testMcpConnection(
    serverId: number,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.ipcRenderer.invoke("mcp:test-connection", serverId);
  }

  public async getMcpSandboxDiagnostics(): Promise<{
    platform: NodeJS.Platform;
    firejailFound: boolean;
    firejailPath: string | null;
    sandboxWouldBeActive: boolean;
  }> {
    return this.ipcRenderer.invoke("mcp:sandbox-diagnostics");
  }

  /** Search the MCP marketplace (the official MCP Registry, cached in main). */
  public async searchMcpCatalog(params: {
    query?: string;
    offset?: number;
    limit?: number;
    appId?: number | null;
  }): Promise<{
    entries: import("@/shared/mcp-catalog").CatalogEntry[];
    total: number;
    syncedAt: string;
    /** Names among `entries` already added to this folder or the account. */
    installed: string[];
  }> {
    return this.ipcRenderer.invoke("mcp-catalog:search", params);
  }

  /** A marketplace server's icon as a checked `data:` URL, or null for a letter. */
  public async getMcpCatalogIcon(name: string): Promise<string | null> {
    return this.ipcRenderer.invoke("mcp-catalog:icon", { name });
  }

  /** A stored server's logo, from its registry name, URL or package command. */
  public async getMcpIconFor(ref: {
    registryName?: string | null;
    url?: string | null;
    command?: string | null;
    args?: string[] | null;
  }): Promise<string | null> {
    return this.ipcRenderer.invoke("mcp-catalog:icon", ref);
  }

  /** A configured server's logo by its name (this folder's first, then the account's). */
  public async getMcpServerIcon(appId: number | null, name: string): Promise<string | null> {
    return this.ipcRenderer.invoke("mcp:server-icon", { appId, name });
  }

  /** Add a marketplace server: a web one goes on the account, a local one in this folder. */
  public async installMcpFromCatalog(params: {
    appId: number;
    name: string;
    optionId: string;
    values?: Record<string, string>;
  }): Promise<import("@/lib/mcp/mcp-add").AddedServer> {
    return this.ipcRenderer.invoke("mcp-catalog:install", params);
  }

  /** "Add your own": a URL, a command line, or a config block from another tool. */
  public async addPastedMcp(params: {
    appId: number;
    text: string;
    name?: string;
  }): Promise<import("@/lib/mcp/mcp-add").PasteOutcome> {
    return this.ipcRenderer.invoke("mcp:add-pasted", params);
  }

  /** The user's default servers and where each stands in this folder / on the account. */
  public async getDefaultMcpServers(
    appId: number | null,
  ): Promise<import("@/lib/mcp/default-servers").DefaultMcpServerStatus[]> {
    return this.ipcRenderer.invoke("mcp:defaults", { appId });
  }

  /** Make a registry server one of the defaults, or take it out; returns the new list. */
  public async setDefaultMcpServer(params: { name: string; on: boolean }): Promise<string[]> {
    return this.ipcRenderer.invoke("mcp:set-default", params);
  }

  /** Servers on now (this folder's plus the account's) and the limit. */
  public async getMcpLimit(appId: number | null): Promise<{ on: number; max: number }> {
    return this.ipcRenderer.invoke("mcp:limit", { appId });
  }

  /** The account's web MCP servers, or null when signed out. */
  public async listAccountMcpServers(): Promise<
    import("@/lib/mcp/account-connectors").ConnectorView[] | null
  > {
    return this.ipcRenderer.invoke("connectors:list");
  }

  public async setAccountMcpEnabled(params: {
    id: string;
    enabled: boolean;
    appId?: number | null;
  }): Promise<true> {
    return this.ipcRenderer.invoke("connectors:set-enabled", params);
  }

  public async removeAccountMcp(id: string): Promise<true> {
    return this.ipcRenderer.invoke("connectors:remove", { id });
  }

  public async setAccountMcpSecret(params: {
    id: string;
    secret: string;
    appId?: number | null;
  }): Promise<true> {
    return this.ipcRenderer.invoke("connectors:set-secret", params);
  }

  /** Sign in to an account server in the browser; resolves when it lands. */
  public async signInAccountMcp(params: {
    id: string;
    appId?: number | null;
  }): Promise<{ ok: boolean; enabled: boolean; error?: string }> {
    return this.ipcRenderer.invoke("connectors:sign-in", params);
  }

  public async startMcpOAuth(params: {
    serverId: number;
    scopes?: string[];
  }): Promise<{ status: "authorized" | "redirect" }> {
    return this.ipcRenderer.invoke("mcp:start-oauth", params);
  }

  public async cancelMcpOAuth(serverId: number): Promise<{ ok: true }> {
    return this.ipcRenderer.invoke("mcp:cancel-oauth", serverId);
  }

  public async getMcpOAuthStatus(serverId: number): Promise<{
    connected: boolean;
    serverId: number;
    inProgress: boolean;
  }> {
    return this.ipcRenderer.invoke("mcp:oauth-status", serverId);
  }

  public async revokeMcpOAuth(serverId: number): Promise<{ ok: true }> {
    return this.ipcRenderer.invoke("mcp:revoke-oauth", serverId);
  }

  public onMcpOAuthRedirect(
    listener: (payload: {
      serverId: number;
      serverName: string;
      authorizationUrl: string;
    }) => void,
  ): () => void {
    this.ipcRenderer.on("mcp:oauth-redirect", listener);
    return () => {
      this.ipcRenderer.removeListener("mcp:oauth-redirect", listener);
    };
  }

  public onMcpOAuthSuccess(
    listener: (payload: { serverId: number; serverName: string }) => void,
  ): () => void {
    this.ipcRenderer.on("mcp:oauth-success", listener);
    return () => {
      this.ipcRenderer.removeListener("mcp:oauth-success", listener);
    };
  }

  public onMcpOAuthError(
    listener: (payload: {
      serverId: number;
      serverName: string;
      error: string;
    }) => void,
  ): () => void {
    this.ipcRenderer.on("mcp:oauth-error", listener);
    return () => {
      this.ipcRenderer.removeListener("mcp:oauth-error", listener);
    };
  }

  public onMcpOAuthRequired(
    listener: (payload: { serverId: number }) => void,
  ): () => void {
    this.ipcRenderer.on("mcp:oauth-required", listener);
    return () => {
      this.ipcRenderer.removeListener("mcp:oauth-required", listener);
    };
  }

  public onMcpAuthRequired(
    listener: (payload: {
      serverId: number;
      serverName: string;
      authType: "none" | "env" | "api_key" | "oauth";
      reason?: "missing" | "invalid";
    }) => void,
  ): () => void {
    this.ipcRenderer.on("mcp:auth-required", listener);
    return () => {
      this.ipcRenderer.removeListener("mcp:auth-required", listener);
    };
  }

  // Removed: upsertMcpTools and setMcpToolActive – tools are fetched dynamically at runtime

  public async getMcpToolConsents() {
    return this.ipcRenderer.invoke("mcp:get-tool-consents");
  }

  public async setMcpToolConsent(params: {
    serverId: number;
    toolName: string;
    consent: "ask" | "always" | "denied";
  }) {
    return this.ipcRenderer.invoke("mcp:set-tool-consent", params);
  }

  // --- Skills Client Methods (read only since v14.45) ---

  /**
   * List the workspace's `.atlarix/skills/*.md`. Metadata only — bodies come from
   * `readRepoSkill`, one at a time, because a workspace can hold any number of them.
   *
   * The `priority` flag reflects a Team gate that no longer exists, so it is always
   * `false`; kept in the shape because the frontmatter key is still parsed.
   */
  public async listRepoSkills(
    workspaceId: number | null | undefined,
  ): Promise<ListRepoSkillsResult> {
    return this.ipcRenderer.invoke("skills:list-repo-skills", {
      workspaceId: workspaceId ?? null,
    });
  }

  /** One skill's markdown body, or null if that filename is not a skill here. */
  public async readRepoSkill(
    workspaceId: number | null | undefined,
    filename: string,
  ): Promise<{ content: string } | null> {
    return this.ipcRenderer.invoke("skills:read-repo-skill", {
      workspaceId: workspaceId ?? null,
      filename,
    });
  }

  /**
   * Files + folders matching `query` in a workspace, for the chat composer `@`
   * autocomplete. Searched live in main over every file — an omitted/empty query
   * returns the first page of everything.
   */
  public async listWorkspacePaths(
    appId: number,
    query?: string,
  ): Promise<{ files: string[]; dirs: string[] }> {
    return this.ipcRenderer.invoke("workspace:list-paths", { appId, query });
  }

  public onMcpToolConsentRequest(
    handler: (payload: {
      requestId: string;
      serverId: number;
      serverName: string;
      toolName: string;
      toolDescription?: string | null;
      inputPreview?: string | null;
    }) => void,
  ) {
    this.mcpConsentHandlers.set("consent", handler as any);
    return () => {
      this.mcpConsentHandlers.delete("consent");
    };
  }

  public respondToMcpConsentRequest(
    requestId: string,
    decision: "accept-once" | "accept-always" | "decline",
  ) {
    this.ipcRenderer.invoke("mcp:tool-consent-response", {
      requestId,
      decision,
    });
  }

  /** A turn ended: main shows the "done responding" notification if no window is focused. */
  public notifyTurnDone(waitingOnUser: boolean, chatId?: number) {
    this.ipcRenderer.invoke("notify:turn-done", { waitingOnUser, chatId });
  }

  // Get proposal details
  public async getProposal(chatId: number): Promise<ProposalResult | null> {
    try {
      const data = await this.ipcRenderer.invoke("get-proposal", { chatId });
      // Assuming the main process returns data matching the ProposalResult interface
      // Add a type check/guard if necessary for robustness
      return data as ProposalResult | null;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // Example methods for listening to events (if needed)
  // public on(channel: string, func: (...args: any[]) => void): void {

  // --- Proposal Management ---
  public async approveProposal({
    chatId,
    messageId,
  }: {
    chatId: number;
    messageId: number;
  }): Promise<ApproveProposalResult> {
    return this.ipcRenderer.invoke("approve-proposal", {
      chatId,
      messageId,
    });
  }

  public async rejectProposal({
    chatId,
    messageId,
  }: {
    chatId: number;
    messageId: number;
  }): Promise<void> {
    await this.ipcRenderer.invoke("reject-proposal", {
      chatId,
      messageId,
    });
  }
  // --- End Proposal Management ---

  // --- Permission Management (New Tool-based Permissions) ---
  public async runTerminalCommand(params: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
    chatId: number;
    source?: "user" | "agent";
  }): Promise<{
    exitCode: number;
    output: string;
    success: boolean;
    timedOut: boolean;
    command: string;
    operationId: string;
  }> {
    return this.ipcRenderer.invoke("terminal:run", params);
  }

  public async listTerminalInstances(params: {
    chatId?: number | null;
    appId?: number | null;
  }): Promise<{
    scopeKey: string;
    instances: Array<{
      id: string;
      label: string;
      owner: "user" | "agent";
      lineCount: number;
      active: boolean;
      createdAt: number;
    }>;
  }> {
    return this.ipcRenderer.invoke("terminal-instances:list", params);
  }

  public async readTerminalInstance(params: {
    chatId?: number | null;
    appId?: number | null;
    instanceId: string;
    maxLines?: number;
  }): Promise<
    | {
        success: true;
        instanceId: string;
        owner: "user" | "agent";
        label: string;
        lineCount: number;
        text: string;
      }
    | { success: false; error: string }
  > {
    return this.ipcRenderer.invoke("terminal-instances:read", {
      chatId: params.chatId,
      appId: params.appId,
      instanceId: params.instanceId,
      maxLines: params.maxLines,
    });
  }

  public async openTerminalInstance(params: {
    chatId?: number | null;
    appId?: number | null;
    owner?: "user" | "agent";
    label?: string;
    commandHint?: string;
    operationId?: string;
    /** Detached job — earns its own tab instead of the shared agent one. Must
     * match what the panel decided locally, or the two disagree about which
     * instance a background command's output belongs to. */
    background?: boolean;
  }): Promise<
    | { success: true; instanceId: string; created: boolean; label?: string }
    | { success: false; error: string }
  > {
    return this.ipcRenderer.invoke("terminal-instances:open", {
      chatId: params.chatId,
      appId: params.appId,
      owner: params.owner ?? "agent",
      label: params.label,
      commandHint: params.commandHint,
      background: params.background === true,
      operationId: params.operationId,
    });
  }

  public async closeTerminalInstance(params: {
    chatId?: number | null;
    appId?: number | null;
    instanceId: string;
  }): Promise<
    { success: true; instanceId: string } | { success: false; error: string }
  > {
    return this.ipcRenderer.invoke("terminal-instances:close", {
      chatId: params.chatId,
      appId: params.appId,
      instanceId: params.instanceId,
    });
  }

  public async getTerminalScopeState(params: {
    chatId?: number | null;
    appId?: number | null;
  }): Promise<{
    scopeKey: string;
    state: {
      instances: import("@/atoms/terminalInstancesAtoms").TerminalInstance[];
      activeInstanceId: string | null;
      agentOpMap: Record<string, string>;
    };
  }> {
    return this.ipcRenderer.invoke("terminal-instances:get-scope", params);
  }

  public async syncTerminalScopeState(params: {
    chatId?: number | null;
    appId?: number | null;
    state: {
      instances: import("@/atoms/terminalInstancesAtoms").TerminalInstance[];
      activeInstanceId: string | null;
      agentOpMap: Record<string, string>;
    };
  }): Promise<{ ok: true }> {
    return this.ipcRenderer.invoke("terminal-instances:sync-scope", {
      chatId: params.chatId,
      appId: params.appId,
      state: params.state,
    });
  }

  public async clearAllTerminalInstances(): Promise<{ ok: true }> {
    return this.ipcRenderer.invoke("terminal-instances:clear-all");
  }

  public onTerminalInstancesUpdated(
    handler: (payload: { scopeKey: string }) => void,
  ): () => void {
    const listener = (payload: { scopeKey: string }) => handler(payload);
    this.ipcRenderer.on("terminal-instances:updated", listener);
    return () => {
      this.ipcRenderer.removeListener("terminal-instances:updated", listener);
    };
  }

  public onTerminalInstancesCleared(handler: () => void): () => void {
    const listener = () => handler();
    this.ipcRenderer.on("terminal-instances:cleared", listener);
    return () => {
      this.ipcRenderer.removeListener("terminal-instances:cleared", listener);
    };
  }

  public async installCli(): Promise<{
    success: boolean;
    path?: string;
    message?: string;
    needsSudo?: boolean;
    sudoCommand?: string;
    cancelled?: boolean;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("cli:install");
  }

  public async uninstallCli(): Promise<{
    success: boolean;
    message?: string;
    needsSudo?: boolean;
    sudoCommand?: string;
    cancelled?: boolean;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("cli:uninstall");
  }

  public async checkCliInstalled(): Promise<{
    installed: boolean;
    path: string;
  }> {
    return this.ipcRenderer.invoke("cli:check-installed");
  }

  /** The CLI handed a session to the app (`/handoff app`): open it here. */
  public onSessionHandoff(
    /** `quiet`: opened from a notification, so no "continued from" line. */
    handler: (payload: { sessionId: string; workspaceId: number; quiet?: boolean }) => void,
  ): () => void {
    const listener = (...args: unknown[]) => {
      const payload = args.find(
        (a) => a && typeof a === "object" && "sessionId" in (a as object),
      ) as { sessionId: string; workspaceId: number; quiet?: boolean } | undefined;
      if (payload) handler(payload);
    };
    this.ipcRenderer.on("session:handoff-open", listener);
    return () => {
      this.ipcRenderer.removeListener("session:handoff-open", listener);
    };
  }

  /** Open this session in VS Code, Cursor, Kiro… through Atlarix's extension. */
  public async openSessionInEditor(
    sessionId: string,
    editor: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.ipcRenderer.invoke("sessions:open-in-editor", sessionId, editor);
  }

  /** Open this session in the user's terminal with the CLI (`atlarix --resume <id>`). */
  public async continueSessionInTerminal(
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.ipcRenderer.invoke("sessions:continue-in-terminal", sessionId);
  }

  public onWorkspaceOpenedFromCli(
    handler: (payload: {
      appId: number;
      chatId: number;
      path: string;
      name: string;
    }) => void,
  ): () => void {
    const listener = (data: {
      appId: number;
      chatId: number;
      path: string;
      name: string;
    }) => handler(data);
    this.ipcRenderer.on("workspace:opened-from-cli", listener);
    return () => {
      this.ipcRenderer.removeListener("workspace:opened-from-cli", listener);
    };
  }

  /**
   * User settings changed — in ANY window, including this one.
   *
   * `useSettings` loads once per window into a jotai atom and nothing used to
   * invalidate the others, so a second window kept a stale copy until reloaded.
   * That is why zoom drifted between windows; language would make it obvious.
   *
   * The `(...args)` shape is not defensive padding — the preload strips the
   * Electron event for some channels and not others, and eleven listeners
   * written `(_e, payload)` have silently never fired. Taking whichever arg is
   * present is what the auth bridge does, and it is right for the same reason.
   */
  public onSettingsChanged(
    handler: (settings: UserSettings) => void,
  ): () => void {
    const listener = ((...args: unknown[]) => {
      const data = (args.length > 1 ? args[1] : args[0]) as UserSettings;
      if (data) handler(data);
    }) as (...args: unknown[]) => void;
    this.ipcRenderer.on("settings:changed", listener);
    return () => {
      this.ipcRenderer.removeListener("settings:changed", listener);
    };
  }

  /** Pull (and clear) a CLI workspace buffered before this renderer mounted. */
  public consumePendingCliWorkspace(): Promise<{
    appId: number;
    chatId: number;
    path: string;
    name: string;
  } | null> {
    return this.ipcRenderer.invoke("workspace:consume-pending-cli");
  }

  public async executePermission({
    chatId,
    operationId,
    approvalMode = "once",
    appId,
    overrideContent,
  }: {
    chatId: number;
    operationId: string;
    approvalMode?:
      | "once"
      | "always_allow"
      | "deny"
      | "always_allow_file"
      | "always_allow_folder"
      | "always_allow_directory"
      | "always_allow_extension";
    appId?: number | null;
    /** v10 per-hunk approval: write this composed content instead of the full proposal. */
    overrideContent?: string;
  }): Promise<{
    operationId: string;
    approved: boolean;
    executedAt?: number;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("execute-permission", {
      chatId,
      operationId,
      approvalMode,
      appId,
      overrideContent,
    });
  }

  public async listFilePermissions(appId: number) {
    return this.ipcRenderer.invoke("file-permissions:list", { appId });
  }

  public async upsertFilePermission(params: {
    appId: number;
    scopeType: "file" | "directory" | "folder" | "extension";
    scopeValue: string;
    decision: "always_allow" | "always_deny";
  }) {
    return this.ipcRenderer.invoke("file-permissions:upsert", params);
  }

  public async revokeFilePermission(params: {
    appId: number;
    scopeType: "file" | "directory" | "folder" | "extension";
    scopeValue: string;
  }) {
    return this.ipcRenderer.invoke("file-permissions:revoke", params);
  }

  /**
   * Folders outside the workspace this project may write in. One list serves
   * both lanes — the command sandbox and `edit_file` — so granting once covers
   * both, and revoking takes effect on the next write rather than next session.
   */
  public async listGrantedFolders(
    appId: number,
  ): Promise<Array<{ path: string; exists: boolean }>> {
    return this.ipcRenderer.invoke("file-permissions:list-granted-folders", {
      appId,
    });
  }

  public async grantFolder(params: {
    appId: number;
    path: string;
  }): Promise<{ success: boolean; path?: string; error?: string }> {
    return this.ipcRenderer.invoke("file-permissions:grant-folder", params);
  }

  public async revokeGrantedFolder(params: {
    appId: number;
    path: string;
  }): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke(
      "file-permissions:revoke-granted-folder",
      params,
    );
  }

  public async listCommandPermissions(appId: number) {
    return this.ipcRenderer.invoke("command-permissions:list", { appId });
  }

  /** The built-in read-only command categories that auto-run (deny-overridable). */
  public async listCommandDefaults(): Promise<string[]> {
    const result = await this.ipcRenderer.invoke(
      "command-permissions:defaults",
    );
    return Array.isArray(result) ? (result as string[]) : [];
  }

  public async upsertCommandPermission(params: {
    appId: number;
    category: string;
    decision: "always_allow" | "always_deny";
  }) {
    return this.ipcRenderer.invoke("command-permissions:upsert", params);
  }

  public async revokeCommandPermission(params: {
    appId: number;
    category: string;
  }) {
    return this.ipcRenderer.invoke("command-permissions:revoke", params);
  }

  public async rejectPermission({
    chatId,
    operationId,
  }: {
    chatId: number;
    operationId: string;
  }): Promise<{ operationId: string; approved: boolean; error?: string }> {
    return this.ipcRenderer.invoke("reject-permission", {
      chatId,
      operationId,
    });
  }

  public async executeAllPermissions({ chatId }: { chatId: number }): Promise<
    Array<{
      operationId: string;
      approved: boolean;
      executedAt?: number;
      error?: string;
    }>
  > {
    return this.ipcRenderer.invoke("execute-all-permissions", {
      chatId,
    });
  }

  /**
   * Approve what is queued AND everything else this turn asks for.
   *
   * Distinct from `executeAllPermissions`, which only drains the current queue —
   * so the next command the model issued prompted again, and a research turn
   * (curl, then python3, then jq, each dangerous on its first token) had to be
   * approved once per command. The blanket lives on the per-turn interceptor, so
   * it expires with the turn and never becomes a saved rule.
   */
  public async approveAllForTurn({ chatId }: { chatId: number }): Promise<
    Array<{
      operationId: string;
      approved: boolean;
      executedAt?: number;
      error?: string;
    }>
  > {
    return this.ipcRenderer.invoke("approve-all-for-turn", {
      chatId,
    });
  }

  public async rejectAllPermissions({
    chatId,
  }: {
    chatId: number;
  }): Promise<
    Array<{ operationId: string; approved: boolean; error?: string }>
  > {
    return this.ipcRenderer.invoke("reject-all-permissions", {
      chatId,
    });
  }

  public async getPendingPermissions({
    chatId,
  }: {
    chatId: number;
  }): Promise<Array<{ id: string; request: any }>> {
    return this.ipcRenderer.invoke("get-pending-permissions", {
      chatId,
    });
  }

  /**
   * Register a handler for mode change request (Ask -> Build approval).
   * Returns unsubscribe function.
   */
  public onModeChangeRequest(
    handler: (payload: {
      chatId: number;
      requestedMode: string;
      reason: string;
    }) => void,
  ): () => void {
    this.modeChangeHandler = handler;
    return () => {
      this.modeChangeHandler = null;
    };
  }

  /**
   * Respond to a mode change request (approve or deny).
   */
  public async respondModeChange(
    chatId: number,
    approve: boolean,
    requestedMode?: string,
  ): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke("respond-mode-change", {
      chatId,
      approve,
      requestedMode,
    });
  }

  /** Main applied a work-mode change from the model (request_mode_change); sync renderer settings atom. */
  public onModeChanged(
    callback: (payload: {
      chatId: number;
      newMode: string;
      settings: UserSettings;
    }) => void,
  ): () => void {
    const listener = (data: unknown) => {
      if (
        data &&
        typeof data === "object" &&
        "chatId" in data &&
        "settings" in data
      ) {
        callback(
          data as { chatId: number; newMode: string; settings: UserSettings },
        );
      }
    };
    this.ipcRenderer.on("mode:changed", listener);
    return () => {
      this.ipcRenderer.removeListener("mode:changed", listener);
    };
  }

  /**
   * Add `handler` to a chat's subscriber set and return an unsubscribe that removes
   * ONLY that handler, dropping the chat's entry once the set empties.
   *
   * Shared by the three chat-scoped registries with multiple live subscribers, so the
   * add/remove halves cannot drift apart — the bug being fixed was precisely an
   * unsubscribe that did not match its own registration. Mirrors `onTerminalOutput`
   * below, which has always had the correct shape.
   */
  /**
   * Deliver one event to every subscriber of a chat, isolating throws.
   *
   * Per-handler try/catch matters more than usual here: these registries carry the
   * APPROVAL card, and one subscriber throwing must not stop the others from
   * rendering it — a swallowed exception that skips the remaining handlers looks
   * exactly like the missing-card hang this whole change exists to fix. Matches the
   * `terminal-output` dispatch below.
   *
   * Returns whether anything was delivered, so callers can log the empty case.
   */
  private notifyChatSubscribers<T>(
    registry: Map<number, Set<(payload: T) => void>>,
    chatId: number,
    payload: T,
    label: string,
  ): boolean {
    const handlers = registry.get(chatId);
    if (!handlers || handlers.size === 0) return false;
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[IPC] ${label} handler threw:`, err);
      }
    }
    return true;
  }

  private addChatSubscriber<T>(
    registry: Map<number, Set<(payload: T) => void>>,
    chatId: number,
    handler: (payload: T) => void,
  ): () => void {
    let handlers = registry.get(chatId);
    if (!handlers) {
      handlers = new Set();
      registry.set(chatId, handlers);
    }
    handlers.add(handler);
    return () => {
      const set = registry.get(chatId);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) registry.delete(chatId);
    };
  }

  /**
   * Register a handler for permission request events for a specific chat.
   * Returns unsubscribe function. Several handlers per chat is NORMAL — see the
   * `permissionHandlers` declaration for why.
   */
  public onPermissionRequest(
    chatId: number,
    handler: (payload: {
      chatId: number;
      type: "permission-request";
      operationId: string;
      request: any;
    }) => void,
  ): () => void {
    return this.addChatSubscriber(this.permissionHandlers, chatId, handler);
  }

  public onCommandPermissionBlocked(
    chatId: number,
    handler: (payload: {
      chatId: number;
      category?: string;
      message?: string;
    }) => void,
  ): () => void {
    return this.addChatSubscriber(
      this.commandPermissionBlockedHandlers,
      chatId,
      handler,
    );
  }

  public onFilePermissionBlocked(
    chatId: number,
    handler: (payload: { chatId: number; message?: string }) => void,
  ): () => void {
    return this.addChatSubscriber(
      this.filePermissionBlockedHandlers,
      chatId,
      handler,
    );
  }

  /**
   * Register a handler for ask_user tool (question + optional option buttons).
   */
  public onUserQuestionRequest(
    chatId: number,
    handler: (payload: {
      chatId: number;
      questionId: string;
      question: string;
      options?: string[];
      /** v10.1: batched questions — all answered before the stream resumes. */
      questions?: Array<{ question: string; options?: string[] }>;
    }) => void,
  ): () => void {
    this.userQuestionHandlers.set(chatId, handler);
    return () => {
      this.userQuestionHandlers.delete(chatId);
    };
  }

  public async submitUserQuestionAnswer(
    chatId: number,
    questionId: string,
    answer: string,
    questionText: string,
  ): Promise<{ success: boolean; restream?: boolean }> {
    return this.ipcRenderer.invoke("chat:submit-user-question-answer", {
      chatId,
      questionId,
      answer,
      questionText,
    });
  }

  /**
   * Register a handler for terminal output events for a specific chat
   * Returns unsubscribe function
   */
  public onTerminalOutput(
    chatId: number,
    handler: (payload: {
      chatId: number;
      commandId: string;
      command: string;
      /**
       * The accumulated output so far.
       *
       * Kept for the synthesised completed/error events, which carry the final
       * full text. A live `running` event also still carries it, but a consumer
       * should prefer `delta` — re-reading this on every chunk is what made the
       * renderer quadratic (measured: 218 ms of blocked main thread per 4.9 MB
       * command, against 6 ms for the deltas).
       */
      output: string;
      /** Only what is new since the previous event. Absent on completed/error. */
      delta?: string;
      status: "running" | "completed" | "error";
      exitCode?: number;
      background?: boolean; // A long-running/background process — gets its own tab
      isPermissionBased?: boolean; // True if this command came from permission system
      source?: "user" | "agent"; // Who initiated the command (agent failures don't pop a toast)
    }) => void,
  ): () => void {
    let handlers = this.terminalHandlers.get(chatId);
    if (!handlers) {
      handlers = new Set();
      this.terminalHandlers.set(chatId, handlers);
    }
    handlers.add(handler);
    return () => {
      const set = this.terminalHandlers.get(chatId);
      if (set) {
        set.delete(handler);
        if (set.size === 0) this.terminalHandlers.delete(chatId);
      }
    };
  }

  /**
   * Register a handler for dev server output events
   * Receives streaming output from auto-started dev servers
   * Returns unsubscribe function
   */
  public onDevServerOutput(
    handler: (payload: {
      workspaceId: number;
      framework: string;
      output: string;
      fullOutput: string;
      status: "running" | "stopped" | "error";
      timestamp: number;
    }) => void,
  ): () => void {
    const listener = (data: any) => handler(data);
    this.ipcRenderer.on("dev-server:output", listener);
    return () => {
      this.ipcRenderer.removeListener("dev-server:output", listener);
    };
  }

  /**
   * Register a handler for operation status updates (permission queue)
   * Returns unsubscribe function
   */
  public onOperationStatus(
    handler: (payload: {
      operationId: string;
      status: "pending" | "queued" | "running" | "completed" | "failed";
      progress?: number;
      duration?: number;
      error?: string;
    }) => void,
  ): () => void {
    const listener = (data: any) => handler(data);
    this.ipcRenderer.on("operation-status", listener);
    return () => {
      this.ipcRenderer.removeListener("operation-status", listener);
    };
  }

  /**
   * Register a handler for auto-recovery events
   * Fires when command(s) fail and AI should analyze
   */
  public onAutoRecovery(
    handler: (payload: {
      chatId: number;
      prompt: string;
      failureCount: number;
    }) => void,
  ): () => void {
    const listener = (data: any) => handler(data);
    this.ipcRenderer.on("auto-recovery-needed", listener);
    return () => {
      this.ipcRenderer.removeListener("auto-recovery-needed", listener);
    };
  }
  // --- End Permission Management ---

  // --- Portal Management ---
  public async portalMigrateCreate(params: {
    appId: number;
  }): Promise<{ output: string }> {
    return this.ipcRenderer.invoke("portal:migrate-create", params);
  }

  // --- End Portal Management ---

  public async getSystemDebugInfo(): Promise<SystemDebugInfo> {
    return this.ipcRenderer.invoke("get-system-debug-info");
  }

  public async uploadToSignedUrl(
    url: string,
    contentType: string,
    data: any,
  ): Promise<void> {
    await this.ipcRenderer.invoke("upload-to-signed-url", {
      url,
      contentType,
      data,
    });
  }

  public async listLocalOllamaModels(): Promise<LocalModelListResponse> {
    const response = await this.ipcRenderer.invoke("local-models:list-ollama");
    return response;
  }

  public async listLocalLMStudioModels(): Promise<LocalModelListResponse> {
    const response = await this.ipcRenderer.invoke(
      "local-models:list-lmstudio",
    );
    return response;
  }

  // Listen for deep link events
  public onDeepLinkReceived(
    callback: (data: DeepLinkData) => void,
  ): () => void {
    const listener = (data: any) => {
      callback(data as DeepLinkData);
    };
    this.ipcRenderer.on("deep-link-received", listener);
    return () => {
      this.ipcRenderer.removeListener("deep-link-received", listener);
    };
  }

  // Listen for force close detected events
  public onForceCloseDetected(
    callback: (data: {
      performanceData?: {
        timestamp: number;
        memoryUsageMB: number;
        cpuUsagePercent?: number;
        systemMemoryUsageMB?: number;
        systemMemoryTotalMB?: number;
        systemCpuPercent?: number;
      };
    }) => void,
  ): () => void {
    const listener = (data: any) => {
      callback(data);
    };
    this.ipcRenderer.on("force-close-detected", listener);
    return () => {
      this.ipcRenderer.removeListener("force-close-detected", listener);
    };
  }

  /** Subscribe to db-ready event (main process has initialized the database). Returns unsubscribe. */
  public onDbReady(callback: () => void): () => void {
    this.ipcRenderer.on("db-ready", callback);
    return () => {
      this.ipcRenderer.removeListener("db-ready", callback);
    };
  }

  /** Main inserted a synthetic user message for post-turn auto-fix; continue stream with that prompt. */
  public onAutoSelfCorrect(
    callback: (data: { chatId: number }) => void,
  ): () => void {
    const listener = (data: unknown) => {
      if (data && typeof data === "object" && "chatId" in data) {
        callback(data as { chatId: number });
      }
    };
    this.ipcRenderer.on("chat:auto-self-correct", listener);
    return () => {
      this.ipcRenderer.removeListener("chat:auto-self-correct", listener);
    };
  }

  // Count tokens for a chat and input
  public async countTokens(
    params: TokenCountParams,
  ): Promise<TokenCountResult> {
    try {
      const result = await this.ipcRenderer.invoke("chat:count-tokens", params);
      return result as TokenCountResult;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // Window control methods
  public async minimizeWindow(): Promise<void> {
    try {
      await this.ipcRenderer.invoke("window:minimize");
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  public async maximizeWindow(): Promise<void> {
    try {
      await this.ipcRenderer.invoke("window:maximize");
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  public async closeWindow(): Promise<void> {
    try {
      await this.ipcRenderer.invoke("window:close");
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // Get system platform (win32, darwin, linux)
  public async getSystemPlatform(): Promise<string> {
    return this.ipcRenderer.invoke("get-system-platform");
  }

  public async doesReleaseNoteExist(
    params: DoesReleaseNoteExistParams,
  ): Promise<{ exists: boolean; url?: string }> {
    return this.ipcRenderer.invoke("does-release-note-exist", params);
  }

  public async getLanguageModelProviders(): Promise<LanguageModelProvider[]> {
    return this.ipcRenderer.invoke("get-language-model-providers");
  }

  public async getLanguageModels(params: {
    providerId: string;
  }): Promise<LanguageModel[]> {
    return this.ipcRenderer.invoke("get-language-models", params);
  }

  public async getLanguageModelsByProviders(): Promise<
    Record<string, LanguageModel[]>
  > {
    return this.ipcRenderer.invoke("get-language-models-by-providers");
  }

  /** Refresh model catalog from models.dev (OpenCode-style dynamic models) */
  public async refreshModelsDev(): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("models-dev:refresh");
  }

  /** Search codebase with natural language (semantic search) */
  public async searchCodebase(params: {
    query: string;
    appId: number;
    maxResults?: number;
  }): Promise<{
    success: boolean;
    query?: string;
    results?: any[];
    formatted_with_context?: string;
    total_matches?: number;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("search-codebase", params);
  }

  public async createCustomLanguageModelProvider({
    id,
    name,
    apiBaseUrl,
    envVarName,
    apiFormat,
  }: CreateCustomLanguageModelProviderParams): Promise<LanguageModelProvider> {
    return this.ipcRenderer.invoke("create-custom-language-model-provider", {
      id,
      name,
      apiBaseUrl,
      envVarName,
      apiFormat,
    });
  }
  public async editCustomLanguageModelProvider(
    params: CreateCustomLanguageModelProviderParams,
  ): Promise<LanguageModelProvider> {
    return this.ipcRenderer.invoke(
      "edit-custom-language-model-provider",
      params,
    );
  }

  public async createCustomLanguageModel(
    params: CreateCustomLanguageModelParams,
  ): Promise<void> {
    await this.ipcRenderer.invoke("create-custom-language-model", params);
  }

  public async deleteCustomLanguageModel(modelId: string): Promise<void> {
    return this.ipcRenderer.invoke("delete-custom-language-model", modelId);
  }

  async deleteCustomModel(params: DeleteCustomModelParams): Promise<void> {
    return this.ipcRenderer.invoke("delete-custom-model", params);
  }

  async deleteCustomLanguageModelProvider(providerId: string): Promise<void> {
    return this.ipcRenderer.invoke("delete-custom-language-model-provider", {
      providerId,
    });
  }

  public async selectAppFolder(): Promise<{
    path: string | null;
    name: string | null;
  }> {
    return this.ipcRenderer.invoke("select-app-folder");
  }

  // Add these methods to IpcClient class

  public async selectNodeFolder(): Promise<SelectNodeFolderResult> {
    return this.ipcRenderer.invoke("select-node-folder");
  }

  public async getNodePath(): Promise<string | null> {
    return this.ipcRenderer.invoke("get-node-path");
  }

  public async importApp(params: ImportAppParams): Promise<ImportAppResult> {
    return this.ipcRenderer.invoke("import-app", params);
  }

  public async touchAppLastOpened(appId: number): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke("apps:touch-last-opened", appId);
  }

  public async openWorkspaceInNewWindow(
    folderPath: string,
  ): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke("workspace:open-in-new-window", folderPath);
  }

  /**
   * Tell main which workspace this window is showing.
   *
   * Main has no other way to know — a window opened from the UI never announced
   * its workspace — so without this every per-window event has to be broadcast to
   * all windows and one project's activity shows up in another's. Also what names
   * the window after its project. Idempotent; safe to call on every open.
   */
  public async bindWindowToWorkspace(
    folderPath: string,
  ): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke("workspace:bind-window", folderPath);
  }

  /** Fresh window with no workspace bound — lands on the workspace chooser. */
  public async openBlankWindow(): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke("window:open-blank");
  }

  async checkAppName(params: {
    appName: string;
  }): Promise<{ exists: boolean }> {
    return this.ipcRenderer.invoke("check-app-name", params);
  }

  public async renameBranch(params: RenameBranchParams): Promise<void> {
    await this.ipcRenderer.invoke("rename-branch", params);
  }

  async clearSessionData(): Promise<void> {
    return this.ipcRenderer.invoke("clear-session-data");
  }

  // Method to get user budget information
  public async getUserBudget(): Promise<UserBudgetInfo | null> {
    return this.ipcRenderer.invoke("get-user-budget");
  }

  /** Validate a hand-typed destination folder (clone dialog). */

  // --- Remote SSH ---
  public async listSshHosts(): Promise<
    Array<{
      hostAlias: string;
      hostName?: string;
      user?: string;
      port?: number;
    }>
  > {
    return this.ipcRenderer.invoke("ssh:list-hosts");
  }

  public async connectSsh(hostAlias: string) {
    return this.ipcRenderer.invoke("ssh:connect", hostAlias);
  }

  public async disconnectSsh(hostAlias: string) {
    return this.ipcRenderer.invoke("ssh:disconnect", hostAlias);
  }

  public async testSshConnection(
    hostAlias: string,
  ): Promise<{ ok: boolean; message: string }> {
    return this.ipcRenderer.invoke("ssh:test-connection", hostAlias);
  }

  // --- Help bot ---
  public async takeScreenshot(): Promise<void> {
    await this.ipcRenderer.invoke("take-screenshot");
  }

  // Provider API Key Management
  public async getProviderApiKey(
    providerId: string,
  ): Promise<{ configured: boolean; preview?: string }> {
    return this.ipcRenderer.invoke("provider:get-api-key", { providerId });
  }

  public async setProviderApiKey(
    providerId: string,
    apiKey: string,
  ): Promise<void> {
    return this.ipcRenderer.invoke("provider:set-api-key", {
      providerId,
      apiKey,
    });
  }

  public async deleteProviderApiKey(providerId: string): Promise<void> {
    return this.ipcRenderer.invoke("provider:delete-api-key", { providerId });
  }

  public async getConfiguredProviders(): Promise<string[]> {
    return this.ipcRenderer.invoke("provider:get-configured");
  }

  public async isCompassBuildConfigured(): Promise<boolean> {
    return this.ipcRenderer.invoke("compass:is-build-configured");
  }

  /**
   * Whether the model behind this user's Core slot changed since they last saw it.
   *
   * Null means "say nothing" — not on Core, no baseline yet, or unchanged. The main
   * side seeds the baseline on the first ask, so a fresh install stays quiet now and
   * is still armed for the next lineup change.
   */
  public async getCoreSlotChangeNotice(): Promise<
    import("@/lib/routing/core-slot-change").CoreSlotChange | null
  > {
    return this.ipcRenderer.invoke("compass:get-slot-change-notice");
  }

  /** Mark the Core slot change as seen. Advancing the baseline IS the dismissal. */
  public async ackCoreSlotChange(): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("compass:ack-slot-change");
  }

  /** Lines the agent has written, aggregated per workspace and per model. */
  public async getEditStatsSummary(): Promise<
    import("@/ipc/ipc_types").EditStatsSummary
  > {
    return this.ipcRenderer.invoke("edit-stats:summary");
  }

  /** Usage on this computer (the Usage page). */
  public async getUsageReport(
    filters: import("@/lib/stats/usage-types").UsageFilters = {},
  ): Promise<import("@/lib/stats/usage-types").UsageReport> {
    return this.ipcRenderer.invoke("usage:report", filters);
  }

  /** The account's Atlarix credits (the Usage page's Credits tab). */
  public async getUsageCredits(): Promise<import("@/lib/stats/usage-types").UsageCredits> {
    return this.ipcRenderer.invoke("usage:credits");
  }

  /** Save the share card (a PNG data URL); asks where. */
  public async saveUsageCard(dataUrl: string): Promise<{ saved: boolean }> {
    return this.ipcRenderer.invoke("usage:save-card", dataUrl);
  }

  /** One line on where a chat stands, for someone coming back to it (lib/recap). */
  public async generateRecap(chatId: number, conversation: string, force = false): Promise<{ text: string | null }> {
    return this.ipcRenderer.invoke("recap:generate", chatId, conversation, force);
  }

  /** Is the user's browser connected through the Atlarix extension? */
  public async getBridgeStatus(): Promise<
    import("@/ipc/handlers/bridge_handlers").BridgeStatus
  > {
    return this.ipcRenderer.invoke("bridge:status");
  }

  // Background jobs (v14).
  public async backgroundJobsList(chatId: number): Promise<
    {
      operationId: string;
      command: string;
      startedAt: number;
      elapsedMs: number;
      stalled?: boolean;
      wakeMatched?: boolean;
    }[]
  > {
    return this.ipcRenderer.invoke("chat:background-jobs-list", chatId);
  }

  public async backgroundJobCancel(
    chatId: number,
    jobId: string,
  ): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke("chat:background-job-cancel", {
      chatId,
      jobId,
    });
  }

  /** Non-destructive: are there undrained finished background results for this chat? */
  public async backgroundHasPendingResults(chatId: number): Promise<boolean> {
    return this.ipcRenderer.invoke(
      "chat:background-has-pending-results",
      chatId,
    );
  }

  /** Non-destructive: are there undrained finished sub-agent results for this chat? */
  public async subagentHasPendingResults(chatId: number): Promise<boolean> {
    return this.ipcRenderer.invoke("chat:subagent-has-pending-results", chatId);
  }

  /** C3: full current output (non-destructive) for a running background job. */
  public async backgroundJobOutput(
    chatId: number,
    jobId: string,
  ): Promise<{ command: string; output: string; elapsedMs: number } | null> {
    return this.ipcRenderer.invoke("chat:background-job-output", {
      chatId,
      jobId,
    });
  }

  /** v14.21: running sub-agents for the indicator (mirrors backgroundJobsList). */
  public async subagentJobsList(chatId: number): Promise<
    {
      taskId: string;
      description: string;
      elapsedMs: number;
      lastOutput: string;
      stalled: boolean;
    }[]
  > {
    return this.ipcRenderer.invoke("chat:subagent-jobs-list", chatId);
  }

  public async subagentJobCancel(
    chatId: number,
    taskId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    return this.ipcRenderer.invoke("chat:subagent-job-cancel", {
      chatId,
      taskId,
    });
  }

  /** Non-destructive TAIL of a sub-agent's narration (never moves the model's cursor). */
  public async subagentJobOutput(
    chatId: number,
    taskId: string,
  ): Promise<{ text: string; elapsedMs: number; state: string } | null> {
    return this.ipcRenderer.invoke("chat:subagent-job-output", {
      chatId,
      taskId,
    });
  }

  // ─── MCP suggestion cards (the agent asks the user to connect a server) ───

  public async listMcpSuggestions(chatId: number): Promise<McpSuggestionView[]> {
    return this.ipcRenderer.invoke("mcp-suggest:list", { chatId });
  }

  public async connectMcpSuggestion(params: {
    id: string;
    optionId?: string;
    values?: Record<string, string>;
  }): Promise<import("@/lib/mcp/mcp-add").AddedServer> {
    return this.ipcRenderer.invoke("mcp-suggest:connect", params);
  }

  public async finishMcpSuggestion(id: string): Promise<{ connected: boolean; server?: string; tools?: string[]; reason?: string }> {
    return this.ipcRenderer.invoke("mcp-suggest:finish", { id });
  }

  public async dismissMcpSuggestion(id: string): Promise<boolean> {
    return this.ipcRenderer.invoke("mcp-suggest:dismiss", { id });
  }

  public onMcpSuggestion(
    listener: (payload: { type: "added" | "resolved"; chatId: number; suggestion: McpSuggestionView }) => void,
  ): () => void {
    const off = this.ipcRenderer.on("mcp:suggestion", (payload) =>
      listener(payload as { type: "added" | "resolved"; chatId: number; suggestion: McpSuggestionView }),
    );
    return typeof off === "function" ? off : () => {};
  }

  public onModUi(listener: (e: ModUiEvent) => void): () => void {
    const off = this.ipcRenderer.on("mods:ui", (payload) => listener(payload as ModUiEvent));
    return typeof off === "function" ? off : () => {};
  }

  public async renderModPane(plugin: string, id: string, workspacePath: string | null): Promise<ModNode | null> {
    return this.ipcRenderer.invoke("mods:render-pane", { plugin, id, workspacePath });
  }

  public async modAction(
    plugin: string,
    action: string,
    workspacePath: string | null,
    paneId?: string,
  ): Promise<void> {
    return this.ipcRenderer.invoke("mods:action", { plugin, action, workspacePath, paneId });
  }

  public async openModPanes(): Promise<Array<{ plugin: string; id: string; title: string }>> {
    return this.ipcRenderer.invoke("mods:open-panes");
  }

  public onMcpServersChanged(listener: () => void): () => void {
    const off = this.ipcRenderer.on("mcp:servers-changed", () => listener());
    return typeof off === "function" ? off : () => {};
  }

  public onBackgroundJobUpdate(
    listener: (payload: BackgroundJobUpdatePayload) => void,
  ): () => void {
    const off = this.ipcRenderer.on("chat:background-job-update", (payload) =>
      listener(payload as BackgroundJobUpdatePayload),
    );
    return typeof off === "function" ? off : () => {};
  }

  /**
   * Mid-turn user messages. Main owns the queue, so all three of these RETURN
   * the authoritative list rather than the renderer computing its own — the
   * single-source rule that the old renderer-only queue broke.
   */
  public async interjectUserMessage(
    chatId: number,
    id: string,
    text: string,
  ): Promise<{ ok: boolean; pending: UserInterjectionView[] }> {
    return this.ipcRenderer.invoke("chat:interject", { chatId, id, text });
  }

  public async cancelUserInterjection(
    chatId: number,
    id: string,
  ): Promise<{ ok: boolean; pending: UserInterjectionView[] }> {
    return this.ipcRenderer.invoke("chat:interject-cancel", { chatId, id });
  }

  public async listUserInterjections(
    chatId: number,
  ): Promise<UserInterjectionView[]> {
    return this.ipcRenderer.invoke("chat:interject-list", chatId);
  }

  /** Take-once: drains the queue and returns it as one prompt, or null. */
  public async flushUserInterjections(
    chatId: number,
  ): Promise<{ text: string | null }> {
    return this.ipcRenderer.invoke("chat:interject-flush", chatId);
  }

  /** Another surface following a chat this window runs pressed Stop. */
  public onRemoteStop(listener: (payload: { chatId: number }) => void): () => void {
    const off = this.ipcRenderer.on("chat:remote-stop", (payload) => listener(payload as { chatId: number }));
    return typeof off === "function" ? off : () => {};
  }

  public onUserInterjections(
    listener: (payload: {
      chatId: number;
      pending: UserInterjectionView[];
    }) => void,
  ): () => void {
    const off = this.ipcRenderer.on("chat:interjections", (payload) =>
      listener(payload as { chatId: number; pending: UserInterjectionView[] }),
    );
    return typeof off === "function" ? off : () => {};
  }

  // OpenRouter Favorites Management
  public async getFavoriteOpenRouterModels(): Promise<string[]> {
    return this.ipcRenderer.invoke("openrouter:get-favorites");
  }

  public async setFavoriteOpenRouterModels(modelIds: string[]): Promise<void> {
    return this.ipcRenderer.invoke("openrouter:set-favorites", { modelIds });
  }

  public async addFavoriteOpenRouterModel(modelId: string): Promise<void> {
    return this.ipcRenderer.invoke("openrouter:add-favorite", { modelId });
  }

  public async removeFavoriteOpenRouterModel(modelId: string): Promise<void> {
    return this.ipcRenderer.invoke("openrouter:remove-favorite", { modelId });
  }

  public async isOpenRouterModelFavorited(modelId: string): Promise<boolean> {
    return this.ipcRenderer.invoke("openrouter:is-favorited", { modelId });
  }

  // SearxNG search methods
  public async checkSearxngHealth(
    url: string,
  ): Promise<{ success: boolean; error?: string; resultsCount?: number }> {
    return this.ipcRenderer.invoke("searxng:health-check", url);
  }

  public async searchSearxng(params: {
    url: string;
    query: string;
    options?: {
      categories?: string[];
      engines?: string[];
      language?: string;
      pageno?: number;
    };
  }): Promise<{
    success: boolean;
    results?: any[];
    suggestions?: string[];
    error?: string;
  }> {
    return this.ipcRenderer.invoke("searxng:search", params);
  }

  // Sync SearxNG config from renderer localStorage to main process
  public async syncSearxngConfig(config: {
    url: string | null;
    enabled: boolean;
  }): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("searxng:set-config", config);
  }

  // Get SearxNG config from database (via main process)
  public async getSearxngConfig(): Promise<{
    url: string | null;
    enabled: boolean;
  }> {
    return this.ipcRenderer.invoke("searxng:get-config");
  }

  // Delete SearxNG config
  public async deleteSearxngConfig(): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("searxng:delete-config");
  }

  // --- Workspace Snapshots (Pro) ---
  public async createWorkspaceSnapshot(params: {
    appId: number;
    name: string;
    chatMessages?: Array<{ role: string; content: string }>;
  }): Promise<{ success: boolean; snapshotId?: number; error?: string }> {
    return this.ipcRenderer.invoke("workspace-snapshot:create", params);
  }

  public async listWorkspaceSnapshots(appId: number): Promise<{
    success: boolean;
    snapshots?: Array<{
      id: number;
      name: string;
      createdAt: Date;
      fileCount: number;
    }>;
  }> {
    return this.ipcRenderer.invoke("workspace-snapshot:list", appId);
  }

  public async restoreWorkspaceSnapshot(params: {
    snapshotId: number;
    appId: number;
  }): Promise<{ success: boolean; error?: string }> {
    return this.ipcRenderer.invoke("workspace-snapshot:restore", params);
  }

  // ============================================
  // DEV SERVER METHODS (Lovable-style Live Preview)
  // ============================================

  /**
   * Check if a workspace is a frontend project
   */
  public async isFrontendProject(workspaceId: number): Promise<{
    isFrontend: boolean;
    framework?: string | null;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("dev-server:is-frontend", { workspaceId });
  }

  /**
   * Start the dev server for a workspace
   */
  public async startDevServer(workspaceId: number): Promise<{
    success: boolean;
    url?: string;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("dev-server:start", { workspaceId });
  }

  /**
   * Stop the dev server for a workspace
   */
  public async stopDevServer(workspaceId: number): Promise<{
    success: boolean;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("dev-server:stop", { workspaceId });
  }

  /**
   * Get the status of a dev server
   */
  public async getDevServerStatus(workspaceId: number): Promise<{
    success: boolean;
    isRunning: boolean;
    url: string | null;
  }> {
    return this.ipcRenderer.invoke("dev-server:status", { workspaceId });
  }

  /**
   * Get all running dev servers
   */
  public async listRunningDevServers(): Promise<{
    success: boolean;
    servers: Array<{
      workspaceId: number;
      url: string | null;
      framework: string;
    }>;
  }> {
    return this.ipcRenderer.invoke("dev-server:list-running");
  }

  // ═══════════════════════════════════════════════════════════
  // FILE OPERATIONS (For live code editor)
  // ═══════════════════════════════════════════════════════════

  /**
   * Read file contents
   */
  public async readFileContent(filePath: string): Promise<{
    success: boolean;
    content?: string;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("file:read-content", { filePath });
  }

  /**
   * Write file contents
   */
  public async writeFileContent(
    filePath: string,
    content: string,
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("file:write-content", { filePath, content });
  }

  /**
   * Get file stats (exists, size, modified time)
   */
  public async getFileStats(filePath: string): Promise<{
    success: boolean;
    exists?: boolean;
    size?: number;
    modifiedTime?: number;
    isDirectory?: boolean;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("file:get-stats", { filePath });
  }

  public onUpdateDownloading(
    handler: (payload: { version: string }) => void,
  ): () => void {
    this.updateDownloadingHandlers.add(handler);
    return () => this.updateDownloadingHandlers.delete(handler);
  }

  public onUpdateDownloaded(
    handler: (payload: { version: string }) => void,
  ): () => void {
    this.updateDownloadedHandlers.add(handler);
    return () => this.updateDownloadedHandlers.delete(handler);
  }

  public onUpdateAvailable(
    handler: (payload: {
      currentVersion: string;
      latestVersion: string;
      releaseUrl: string;
    }) => void,
  ): () => void {
    this.updateAvailableHandlers.add(handler);
    return () => this.updateAvailableHandlers.delete(handler);
  }

  /** Fix 7: the installed `atlarix` launcher is stale + root-owned. The renderer
   * shows a one-click "update the command" affordance (reinstalls via sudo). */
  public onCliLauncherStale(handler: () => void): () => void {
    this.cliLauncherStaleHandlers.add(handler);
    return () => this.cliLauncherStaleHandlers.delete(handler);
  }

  public async deferUpdate(): Promise<void> {
    await this.ipcRenderer.invoke("update:defer");
  }

  public async installUpdateNow(): Promise<void> {
    await this.ipcRenderer.invoke("update:install-now");
  }

  public async getUpdateStatus(): Promise<UpdateStatusPayload> {
    return (await this.ipcRenderer.invoke(
      "update:get-status",
    )) as UpdateStatusPayload;
  }

  public async checkForUpdatesNow(): Promise<UpdateStatusPayload> {
    return (await this.ipcRenderer.invoke(
      "update:check-now",
    )) as UpdateStatusPayload;
  }

  public onUpdateStatus(
    handler: (payload: UpdateStatusPayload) => void,
  ): () => void {
    this.updateStatusHandlers.add(handler);
    return () => this.updateStatusHandlers.delete(handler);
  }
}

// Export function to get SearxNG config from main process (for use in main process only)
export async function getSearxngConfigFromMain(): Promise<{
  url: string | null;
  enabled: boolean;
}> {
  if (typeof window !== "undefined") {
    // In renderer, this shouldn't be called
    throw new Error(
      "getSearxngConfigFromMain should only be called from main process",
    );
  }

  // In main process, directly import and call the config
  // This is a workaround since we can't use IPC from main to main
  return { url: process.env.SEARXNG_API_URL || null, enabled: false };
}
