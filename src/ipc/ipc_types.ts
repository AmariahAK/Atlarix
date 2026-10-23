import type { EffortChoices } from "@/lib/routing/model-reasoning-profile";
import { z } from "zod";
import type { DisplaySnapshotV1 } from "@/lib/chat/display-snapshot";
import type { WorkMode } from "@/lib/schemas";
import type { SessionMessageKind } from "@/db/schema";
import type { ProblemReport, Problem } from "../../shared/tsc_types";
export type { ProblemReport, Problem };

export interface AppOutput {
  type: "stdout" | "stderr" | "info" | "client-error" | "input-requested";
  message: string;
  timestamp: number;
  appId: number;
}

export interface RespondToAppInputParams {
  appId: number;
  response: string;
}

export interface ListAppsResponse {
  apps: App[];
  appBasePath: string;
}

export interface ChatStreamParams {
  chatId: number;
  appId?: number | null;
  /** Full prompt for the model (may include attachment XML bodies). */
  prompt: string;
  /** User-visible bubble text (chips / stub attachment tags). When omitted, uses `prompt`. */
  displayPrompt?: string;
  /** Pasted text / terminal payloads for chip preview in the UI. */
  pasteAttachments?: PasteAttachmentMeta[];
  redo?: boolean;
  attachments?: Array<{
    id?: string;
    name: string;
    type: string;
    data: string; // Base64 encoded file data
    attachmentType: "upload-to-codebase" | "chat-context"; // FileAttachment type
  }>;
  /** v3.6: Override model for this message only (e.g. when user clicks Override in Auto routing preview). */
  modelOverride?: { provider: string; name: string };
  /** v3.9: When true, do not add a new user message; use the last user message content (after question answers) as prompt. */
  continueAfterQuestions?: boolean;
  /**
   * True when the HARNESS started this turn, not the user — a finished background
   * job, a sub-agent result, a scheduled self-wake, an auto-self-correct.
   *
   * Load-bearing: a system wake must never interrupt a live turn, and must never
   * resurrect a chat the user stopped. Main enforces both (`shouldDropSystemWake`)
   * because it is the only side that knows across windows — the renderer's guards
   * live in a per-window jotai store, so a SECOND window looked up a chat it had
   * never seen, concluded "not streaming", and woke a chat the first window was
   * mid-turn on. That produced 80 superseded turns in 6 minutes and a beachball.
   *
   * Cannot be inferred, which is why it is explicit: `continueAfterQuestions` is
   * used by these wakes AND by the genuine `ask_user` answer resume (which SHOULD
   * supersede), and an empty prompt is likewise ambiguous.
   */
  systemWake?: boolean;
  /** Resume an interrupted turn (e.g. after a disconnect): add NO new user message; the
   *  model receives a `<system-reminder>` continuation directive, not a user turn. */
  continueInterrupted?: boolean;
  // Pass 7: Blueprint injection-mode + debug-trace fields removed with the Blueprint subsystem.
  /** Workspace SQLite session id for plan artifacts and message persistence. */
  workspaceSessionId?: string | null;
  /** @deprecated Plan artifacts are session DB rows; ignored. */
  prefillTaskLedger?: {
    steps: { description: string }[];
    sourcePlanMessageId?: number;
  };
  /** Custom slash command: override chat mode for this stream only. */
  streamChatModeOverride?: "ask" | "agent" | "build";
  /** Resend/edit: use this work mode for prompt + tool allowlist for this turn only. */
  workModeOverride?: WorkMode;
  /** "Try with a stronger model": paid Atlarix Auto answers this turn one level up. */
  escalate?: boolean;
  /**
   * Set when this turn IS an automation run (unattended, no human responder).
   * `unattended` drops the human-handoff tools.
   */
  automation?: {
    runId: string;
    unattended: true;
  };
}

/** Autonomous session review: one executed permission op logged in main. */
export interface AutonomousOpDto {
  operationId: string;
  type: string;
  path?: string;
  summary?: string;
  timestamp: number;
  result: "success" | "failed";
  reverted: boolean;
}

/** Main → renderer when an autonomous Build turn finishes with ops or bus activity. */
export interface AutonomousSessionCompletePayload {
  chatId: number;
  turnId: string;
  workspaceId?: number | null;
  ops: AutonomousOpDto[];
  agentActivity: Record<string, unknown>[];
}

/** Main → renderer: live task-ledger plan for PlanCard (scoped by chatId). */
export type PlanUpdateStepStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "failed";

export interface PlanUpdateStep {
  id: number;
  description: string;
  status: PlanUpdateStepStatus;
  completedAt?: number;
}

export interface PlanUpdatePayload {
  chatId: number;
  turnId: string;
  /** Assistant placeholder message id for this stream (ledger turnId may be `plan:<workspaceId>`). */
  assistantMessageId: number;
  task: string;
  steps: PlanUpdateStep[];
  status: "pending" | "in_progress" | "complete" | "failed";
}

export interface ChatResponseEnd {
  chatId: number;
  /** Bug A: monotonic id of the stream leg that produced this terminal event.
   * The renderer drops a superseded leg's late end so it can't clobber the
   * live turn's UI state. Optional — older/auxiliary terminal sends omit it. */
  streamId?: number;
  updatedFiles: boolean;
  extraFiles?: string[];
  extraFilesError?: string;
  totalTokens?: number;
  contextWindow?: number;
  /** Reasoning / thinking tokens from the last completed stream step (when reported by the provider). */
  reasoningTokens?: number;
  /** True when the turn had at least one tool execution or permission request; used to play completion sound only when relevant. */
  hadToolCallsOrPermissions?: boolean;
  /** True when the turn ended by asking the user (ask_user) rather than finishing — drives the "needs your answer" vs "finished responding" notification. */
  endedWaitingOnUser?: boolean;
  /**
   * True when this end came from the user pressing Stop, not from the turn finishing.
   *
   * Load-bearing: the renderer auto-wakes a FRESH turn on `response:end` whenever a
   * background command or sub-agent still has a pending result. Cancel kills only
   * foreground commands, so that condition is routinely true right after a stop — and
   * without this flag the wake fired, a new turn started with no knowledge of the stop,
   * re-read the file it had just edited, mistook its own change for the user's, and
   * carried on (observed: it went as far as `git push`).
   */
  userCancelled?: boolean;
  /** True when the completed turn used the managed Atlarix Core provider (for usage refresh). */
  usedCompass?: boolean;
  /** v10: auxiliary LLM tokens this turn (sub-agents, compaction) — counted toward usage. */
  auxTokens?: number;
  /**
   * How much of `auxTokens` is ESTIMATED rather than provider-reported, present
   * only when some is. Some providers (notably free OpenRouter routes) return no
   * usage at all; those calls used to be dropped from the total entirely, so a turn
   * that ran four sub-agents could report one. They are now counted with their size
   * estimated — and the estimate is carried separately so nothing downstream shows
   * it as a measured figure. Estimates here have been ~2x off before.
   */
  auxEstimatedTokens?: number;
  /**
   * Per-source split of `auxTokens`, largest first. Sub-agents are work the user
   * asked for; compaction is the app spending on their behalf — a single lumped
   * figure hid that distinction.
   */
  auxBySource?: Array<{
    source: "subagents" | "compaction" | "other";
    tokens: number;
    calls: number;
    /** Of `tokens`, the estimated share (see `auxEstimatedTokens`). */
    estimatedTokens: number;
  }>;
  /** v12 7D: estimated BYOK USD cost of this turn (omitted for Core/unknown-price). */
  turnCostUsd?: number;
  /** Fix 6: this turn's billed tokens (input+output) — summed into the
   * cumulative session-spend meter (the context meter is occupancy, not spend). */
  turnTokens?: number;
  /**
   * Of this turn's input, how much was served from the provider's prompt cache.
   * Reported beside `turnCostUsd` rather than folded into it because the cost is
   * only present when a rate is known, and `turnTokens` alone cannot be priced —
   * a cached read costs a small fraction of a fresh one (on DeepSeek roughly a
   * thirtieth), so gross input overstates a long run's spend by an order of
   * magnitude. Omitted when zero.
   */
  turnCachedInputTokens?: number;
  /** Tokens written INTO the cache this turn (Anthropic-style write surcharge). */
  turnCacheCreationTokens?: number;
  /** v12 2.3: the snapshot turn id (= ledger turn id) so a detached background
   * agent can revert this turn's writes via the shadow-git snapshot. */
  snapshotTurnId?: string;
  /**
   * The turn ended cleanly with background work still outstanding (running/
   * pending background commands or sub-agents). The renderer shows a calm
   * "waiting … will resume automatically" chip; a fresh turn auto-resumes when
   * an item reports. Distinct from a normal completed turn.
   */
  parked?: boolean;
  /** When parked: count of running background commands (for the chip text). */
  parkedCommands?: number;
  /** When parked: count of running background sub-agents (for the chip text). */
  parkedSubagents?: number;
  /**
   * v12 0.2: native-history envelope for the assistant message (JSON of the
   * turn's native tool_use/tool_result ModelMessages). The renderer persists
   * it as the assistant session message's extras.modelContent so the next
   * turn replays native parts instead of flattened prose.
   */
  assistantModelContent?: string;
}

/** v10: per-dispatch context assembly report for the context meter. */
export interface ChatContextReport {
  chatId: number;
  sections: Array<{
    name: string;
    tokens: number;
    included: boolean;
    truncated: boolean;
  }>;
  /** Human-readable trim notes (what was pruned and why). */
  trimReport: string[];
  /** Actual MODEL-FACING dispatched token total (post-compaction/slice) — the
   * meter shows this so it reflects what the model sees and DROPS after a
   * summarize, instead of the full untrimmed conversation size. */
  dispatchedTokens?: number;
  /** Resolved context window for this dispatch (denominator for the meter). */
  contextWindow?: number;
}

/** Live per-turn token usage for the composer meter (streamed during a turn).
 * Real provider usage lands at each step (inputTokens set); throttled output
 * estimates during streaming carry inputTokens=null (renderer keeps the last
 * real input baseline and just grows output). */
export interface ChatTokenUsage {
  chatId: number;
  /** Provider-reported input/context tokens; null for a mid-stream estimate. */
  inputTokens: number | null;
  /** Provider-reported or estimated output tokens so far. */
  outputTokens: number;
  /** Provider total when known (input+output+cache+reasoning). */
  totalTokens?: number;
  /**
   * Running per-tool token attribution for THIS turn, so the context-meter
   * breakdown climbs live instead of freezing until the turn ends.
   *
   * A RUNNING TOTAL, not a delta — a dropped emit then self-heals on the next
   * step rather than losing that work from the meter permanently. Present only
   * on real per-step emits; the throttled text estimate omits it.
   */
  toolBuckets?: {
    filesRead: number;
    searchResults: number;
    otherToolOutput: number;
  };
}

/**
 * FIX 4: payload for `chat:stream:disconnected`. Emitted after silent
 * reconnect attempts (2s/5s/10s) all fail. The renderer keeps the partial
 * response visible and offers [Reconnect] (replays the same turn) and
 * [Continue] (sends a new prompt asking the model to resume).
 */
export interface ChatProblemsEvent {
  chatId: number;
  appId: number;
  problems: ProblemReport;
}

/** Result of `revert:snapshot` — restore `.atlarix/snapshots/<turnId>/` into workspace. */
export interface RevertSnapshotResult {
  success: boolean;
  error?: string;
  restoredFiles?: number;
  /** Files left as they are: changed after the turn. */
  kept?: string[];
  /** The turn had no record of how it ended; nothing could be checked. */
  unchecked?: boolean;
}

export interface AttachmentInfo {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentPreview?: string;
}

/** Persisted file upload payload (survives app restart). */
export interface StoredFileAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Base64-encoded file bytes (no data: URL prefix). */
  data: string;
}

/** Pasted text / terminal blocks for UI preview (not sent as file uploads). */
export interface PasteAttachmentMeta {
  /** Stable id for read_attachment / AttachmentStore. */
  id?: string;
  kind: "text" | "terminal";
  displayName: string;
  /** Model-facing body (full paste / terminal transcript). */
  content: string;
  /** Terminal: UI-faithful text for copy/preview. */
  displayContent?: string;
}

export interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  /**
   * v12 0.4-C2: the session DB row UUID this message maps to, when known
   * (set at persist time for streamed user messages; threaded through
   * hydration). Edits target the DB row DIRECTLY via this id — no ordinal
   * mapping between the ephemeral and persisted stores.
   */
  sessionRowId?: string;
  /** Full model-facing user text (attachment bodies); UI uses `content` when set. */
  modelContent?: string | null;
  /**
   * `session_messages.kind`, threaded through hydration so the dispatch slice can
   * recognise a durable compaction marker by its COLUMN rather than by its text.
   * Absent on a purely ephemeral message, which is why the detector still falls
   * back to matching content.
   */
  kind?: SessionMessageKind;
  /** Ephemeral/chat-only: in-memory chat id (not persisted). */
  chatId?: number;
  approvalState?: "approved" | "rejected" | null;
  commitHash?: string | null;
  dbTimestamp?: string | null;
  createdAt?: Date | string;
  requestId?: string | null;
  totalTokens?: number | null;
  /**
   * The PROVIDER's real total token usage for this assistant turn.
   *
   * The token meter prefers this over its own estimate. It is persisted on the
   * session row and threaded back through hydration, because without it a
   * restart drops the meter to a client-side estimate that counts only the flat
   * persisted messages — no system prompt, no native tool history — and so reads
   * roughly half. Reopening the app looked like the session had been summarised.
   */
  maxTokensUsed?: number | null;
  toolCalls?: Array<{ id: string; name: string; arguments?: string }>;
  sources?: Array<{
    title: string;
    url: string;
    content?: string;
    favicon?: string;
  }>;
  /** v3.9: 0-based exchange index. */
  exchangeIndex?: number | null;
  /** v3.9: Snapshot id before this assistant message (revert target). */
  snapshotId?: number | null;
  /** v3.9: Paths written in this exchange. */
  filesWritten?: string[] | null;
  /** Non-destructive revert: message stays in transcript, styled as reverted. */
  isReverted?: boolean | null;
  /** Compaction: auto-inserted continuation user line. */
  isSynthetic?: boolean | null;
  /** Work mode when this user message was sent. */
  workMode?: "ask" | "plan" | "build" | "debug" | "review" | null;
  /** File attachments for this message (shown as chips in UI). */
  attachments?: AttachmentInfo[] | null;
  /** Persisted file upload payloads for rehydrating AttachmentStore. */
  fileAttachments?: StoredFileAttachment[] | null;
  /** Pasted text / terminal bodies for chip preview after send. */
  pasteAttachments?: PasteAttachmentMeta[] | null;
  /** Frozen tool / sub-agent UI (DisplaySnapshotV1). */
  displaySnapshot?: DisplaySnapshotV1 | null;
  /**
   * Issue 4: assistant turn whose stream was cut off (compass stop, app
   * quit/suspend, crash) before completing. Holds partial content and renders
   * a "Continue" affordance so the user can resume.
   */
  interrupted?: boolean | null;
  /**
   * v14.7: assistant turn PARKED on a wait (a pending approval or an `ask_user`
   * question) — NOT an error. Persisted as `status:"waiting"` so reopen renders
   * the wait/question affordance instead of the "interrupted/Continue" error.
   */
  waiting?: boolean | null;
}

export interface Chat {
  id: number;
  appId?: number | null;
  title: string;
  messages: Message[];
  initialCommitHash?: string | null;
  dbTimestamp?: string | null;
}

export interface App {
  id: number;
  name: string;
  path: string;
  createdAt: Date;
  updatedAt: Date;
  githubOrg: string | null;
  githubRepo: string | null;
  githubBranch: string | null;
  installCommand: string | null;
  startCommand: string | null;
  isFavorite: boolean;
  /** v2.1: true if the workspace folder exists on disk; false if deleted outside app */
  pathExists?: boolean;
  /** Derived from pathExists: active = folder present, missing = folder absent */
  status?: "active" | "missing";
  lastOpenedAt?: Date | null;
  workspaceKind?: "local" | "remote-ssh";
  remoteConnection?: Record<string, unknown> | null;
}

export interface Version {
  oid: string;
  message: string;
  timestamp: number;
}

export type BranchResult = { branch: string };

export interface NodeSystemInfo {
  nodeVersion: string | null;
  pnpmVersion: string | null;
  nodeDownloadUrl: string;
}

export interface SystemDebugInfo {
  nodeVersion: string | null;
  pnpmVersion: string | null;
  nodePath: string | null;
  telemetryId: string;
  telemetryConsent: string;
  telemetryUrl: string;
  atlarixVersion: string;
  platform: string;
  architecture: string;
  logs: string;
  selectedLanguageModel: string;
}

export interface LocalModel {
  provider: "ollama" | "lmstudio";
  modelName: string; // Name used for API calls (e.g., "llama2:latest")
  displayName: string; // User-friendly name (e.g., "Llama 2")
}

export type LocalModelListResponse = {
  models: LocalModel[];
  error?: string; // User-friendly error message (e.g., "LM Studio not running")
};

export interface TokenCountParams {
  chatId: number;
  input: string;
  /**
   * The mode the next turn will run in, as the composer resolved it
   * (`useWorkModeSelection`). Fills the same slot `workModeOverride` fills on a
   * stream request, and for the same reason: sessions have owned their own work
   * mode since v14.36.0, so the main process cannot recover it from global
   * settings. Omitted → the handler falls back to the global preference, which
   * is right for a session that never picked a mode.
   */
  workMode?: WorkMode;
}

export interface TokenCountResult {
  estimatedTotalTokens: number;
  actualMaxTokens: number | null;
  /** Whole model-facing history: conversation + every tool bucket below. */
  messageHistoryTokens: number;
  /**
   * The four buckets below PARTITION `messageHistoryTokens` — they are carved
   * out of it, not additional to it. Tool results ride as native parts on the
   * assistant rows, so adding them on top would double-count.
   */
  conversationTokens: number;
  filesReadTokens: number;
  searchResultTokens: number;
  otherToolOutputTokens: number;
  inputTokens: number;
  /**
   * The whole FIXED prefix: system instructions plus the bound tool surface.
   *
   * It carries the tool half as of v14.41. Before that it was the system prompt
   * alone, which under-reported the real prefix by ~10,000 tokens in Build —
   * the tool descriptions and parameter schemas are billed on every turn and
   * were counted by nothing.
   */
  systemPromptTokens: number;
  /**
   * The three below PARTITION `systemPromptTokens` (same contract as the
   * history buckets): system instructions, bound tool descriptions after
   * per-mode reveal tiering, and parameter JSON schemas.
   */
  systemInstructionTokens: number;
  toolDescriptionTokens: number;
  toolSchemaTokens: number;
  /** The mode the prefix was measured for, so the UI can say which it priced. */
  workMode: WorkMode;
  contextWindow: number;
  /** Effective budget (override or context window) for warnings */
  effectiveBudget?: number;
  providerId?: string;
  budgetSource?: "model" | "override";
}

export interface ChatLogsData {
  debugInfo: SystemDebugInfo;
  chat: Chat;
  codebase: string;
}

export interface LanguageModelProvider {
  id: string;
  name: string;
  hasFreeTier?: boolean;
  websiteUrl?: string;
  gatewayPrefix?: string;
  secondary?: boolean;
  /** Primary env var — `envVarNames[0]`. Kept for the many existing consumers. */
  envVarName?: string;
  /**
   * EVERY env var name that carries this provider's key, best first (curated
   * preference, then models.dev's published order). A provider commonly documents
   * several — Google publishes three — and the user has whichever their other
   * tooling set, so key lookup tries each rather than one.
   */
  envVarNames?: string[];
  apiBaseUrl?: string;
  /**
   * models.dev's `npm` value (or an overlay pin): which AI-SDK / wire format this
   * provider speaks. The dispatch key in `provider-sdk-factories.ts`.
   */
  npm?: string;
  /** A provider the user added: the wire format it speaks (unset = OpenAI-compatible). */
  apiFormat?: CustomApiFormat;
  /** A provider the user added: how it takes the key (unset = the format's usual header). */
  authHeader?: CustomAuthHeader;
  type: "custom" | "local" | "cloud";
}

/** The macOS grants computer use needs; "unsupported" where the OS asks for none. */
export type ComputerUsePermissions =
  | {
      screen: "granted" | "denied" | "unsupported";
      accessibility: "granted" | "denied" | "unsupported";
    }
  | { error: string };

/** `eligible`, or why computer use can't be switched on (lib/computer/lane.ts). */
export type ComputerUseEligibility = "eligible" | "no-vision" | "no-tool-images";

/** The wire formats a provider the user added can speak. */
export type CustomApiFormat = "openai" | "anthropic";
/** How an Anthropic-format endpoint takes the key: Anthropic's own header, or a Bearer token (Bedrock). */
export type CustomAuthHeader = "x-api-key" | "bearer";

export type LanguageModel =
  | {
      id: number;
      apiName: string;
      displayName: string;
      description: string;
      tag?: string;
      tagColor?: string;
      maxOutputTokens?: number;
      contextWindow?: number;
      temperature?: number;
      dollarSigns?: number;
      /**
       * Whether the Deep-thinking toggle should be offered for this model.
       *
       * Resolved in MAIN and shipped on this payload, like `supportsToolChoice` below.
       * The renderer cannot work it out for itself: both inputs — the models.dev
       * reasoning registry and the Core tier→vendor routing map — are module-level
       * state written only in the main process, so every renderer-side lookup came back
       * empty and the toggle fell through to a provider allowlist that has never
       * contained `compass`.
       */
      supportsDeepThinking?: boolean;
      /**
       * Does this model accept AUDIO input? Gates the composer's microphone.
       *
       * Resolved in MAIN for exactly the reason above: the models.dev modality
       * registry is main-process module state, so a renderer-side lookup comes
       * back empty and the mic would hide for every model.
       */
      supportsAudioInput?: boolean;
      /**
       * What /effort offers for this model, exactly as the model lists it (or
       * paid Auto's low / medium / max). Resolved in MAIN, like the two above.
       */
      effortChoices?: EffortChoices;
      /**
       * Whether computer use can be switched on for this model, or why not.
       * Resolved in MAIN, like the two above (lib/computer/lane.ts).
       */
      computerUse?: ComputerUseEligibility;
      type: "custom";
    }
  | {
      apiName: string;
      displayName: string;
      description: string;
      tag?: string;
      tagColor?: string;
      maxOutputTokens?: number;
      contextWindow?: number;
      temperature?: number;
      dollarSigns?: number;
      /** Real USD price per 1M tokens from the models.dev catalog (when known). */
      cost?: { input: number; output: number };
      supportsToolChoice?: boolean;
      /** See the `custom` variant above — resolved in main, never in the renderer. */
      supportsDeepThinking?: boolean;
      /** See the `custom` variant above — resolved in main, never in the renderer. */
      supportsAudioInput?: boolean;
      /** See the `custom` variant above — resolved in main, never in the renderer. */
      effortChoices?: EffortChoices;
      /** See the `custom` variant above — resolved in main, never in the renderer. */
      computerUse?: ComputerUseEligibility;
      type: "local" | "cloud";
    };

export interface CreateCustomLanguageModelProviderParams {
  id: string;
  name: string;
  apiBaseUrl: string;
  envVarName?: string;
  apiFormat?: CustomApiFormat;
  authHeader?: CustomAuthHeader;
}

export interface CreateCustomLanguageModelParams {
  apiName: string;
  displayName: string;
  providerId: string;
  description?: string;
  maxOutputTokens?: number;
  contextWindow?: number;
}

export interface DoesReleaseNoteExistParams {
  version: string;
}

export interface ApproveProposalResult {
  extraFiles?: string[];
  extraFilesError?: string;
}

export interface ImportAppParams {
  path: string;
  appName: string;
  installCommand?: string;
  startCommand?: string;
}

export interface CopyAppParams {
  appId: number;
  newAppName: string;
  withHistory: boolean;
}

export interface ImportAppResult {
  appId: number;
  chatId: number;
}

export interface RenameBranchParams {
  appId: number;
  oldBranchName: string;
  newBranchName: string;
}

export const UserBudgetInfoSchema = z.object({
  usedCredits: z.number(),
  totalCredits: z.number(),
  budgetResetDate: z.date(),
  redactedUserId: z.string(),
});
export type UserBudgetInfo = z.infer<typeof UserBudgetInfoSchema>;

export interface EnvVar {
  key: string;
  value: string;
}

export interface SetAppEnvVarsParams {
  appId: number;
  envVars: EnvVar[];
}

export interface GetAppEnvVarsParams {
  appId: number;
}

export interface UpdateChatParams {
  chatId: number;
  title: string;
}

export interface FileAttachment {
  file?: File;
  type: "upload-to-codebase" | "chat-context";
  /** Stable id so renderer + main share an attachment ID. */
  id?: string;
  /** Long paste lifted from the composer — UI chip only; injected into prompt on send. */
  textPaste?: {
    content: string;
    displayName: string;
  };
  /** Terminal selection copied into chat — UI chip only; injected into prompt on send. */
  terminalPaste?: {
    /** Model-facing transcript (prompt tagged, output raw). */
    content: string;
    /** Terminal-faithful text for copy/preview (no prefix on stdout). */
    displayContent?: string;
    displayName: string;
    instanceLabel: string;
    owner: "user" | "agent";
    lineStart: number;
    lineEnd: number;
  };
  /**
   * `@`-mention of a workspace file/folder picked in the composer — UI chip only.
   * On send, the `@file:`/`@dir:` token is re-emitted into the prompt so the
   * existing scoped, capped extraction (parseContextMentions →
   * extractMentionedContext) runs unchanged. Never base64-encoded.
   */
  mention?: {
    kind: "file" | "dir";
    /** Workspace-relative path (no leading `./`, no spaces). */
    relpath: string;
    displayName: string;
  };
  /**
   * A reference to a running background job sent to chat from the jobs UI — UI
   * chip only (shows `id-<jobId>`). On send, a `<atlarix-background-job>` block
   * with the job id, command, and current output tail is injected so the user
   * can ask the model about it ("this looks stuck — what's wrong?").
   */
  backgroundJob?: {
    jobId: string;
    command: string;
    /** Output tail captured at send time (may be empty). */
    outputTail?: string;
  };
}

export interface RevertVersionParams {
  appId: number;
  previousVersionId: string;
}

export type RevertVersionResponse =
  | { successMessage: string }
  | { warningMessage: string };

// --- Workspace session persistence ---
export interface WorkspaceChatSession {
  id: string;
  workspaceId: number;
  title: string;
  /**
   * This session's work mode, or `null` when it has never had one picked — in
   * which case the global preference applies, exactly as it did before sessions
   * owned their mode. Never collapse the null to a default on read.
   */
  workMode?: "ask" | "plan" | "build" | "debug" | "review" | null;
  createdAt: Date;
  updatedAt: Date;
}

// --- MCP Types ---
export interface McpServer {
  id: number;
  name: string;
  transport: string;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  envJson?: Record<string, string> | null;
  url?: string | null;
  apiKey?: string | null;
  enabled: boolean;
  /**
   * Workspace only. Global scope was retired and its rows purged by migration
   * `0049_workspace_only_remote.sql` (mcp_servers, installed_skills and
   * prompts alike); the handlers now hardcode "workspace" and every query
   * filters on it. The DB columns stay — `installed_skills.scope` is part of
   * a composite primary key, so dropping it would mean a SQLite table rebuild
   * for no user-visible gain.
   */
  scope?: "workspace";
  appId?: number | null;
  authType?: "none" | "env" | "api_key" | "oauth";
  oauthConnected?: boolean;
  /** Header NAMES a URL server sends (read side; values never leave main). */
  headerNames?: string[];
  /** Headers to save (write side only: create and update). */
  headers?: Record<string, string> | null;
  /** Installed from the marketplace: the registry server's name. */
  registryId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateMcpServer
  extends Omit<McpServer, "id" | "createdAt" | "updatedAt"> {
  scope?: "workspace";
  appId?: number | null;
}
export type McpServerUpdate = Partial<McpServer> & Pick<McpServer, "id">;
export type McpToolConsentType = "ask" | "always" | "denied";

export interface McpTool {
  name: string;
  description?: string | null;
  consent: McpToolConsentType;
}

export interface McpListToolsResult {
  tools: McpTool[];
  error?: string;
  needsOAuth?: boolean;
}

export interface McpToolConsent {
  id: number;
  serverId: number;
  toolName: string;
  consent: McpToolConsentType;
  updatedAt: number;
}

// --- Skills Types (read only since v14.45 — the registry/install types are gone) ---

/** One `.atlarix/skills/*.md`, as the settings list renders it. Metadata only. */
export interface RepoSkillSummary {
  name: string;
  description: string;
  tags: string[];
  modes: string[];
  /** Reflects a Team gate that no longer exists, so always false. */
  priority: boolean;
  version: string;
  filename: string;
}

/** Result of `skills:list-repo-skills`. */
export interface ListRepoSkillsResult {
  skills: RepoSkillSummary[];
  isWorkforce: boolean;
}

export interface CloneRepoParams {
  url: string;
  installCommand?: string;
  startCommand?: string;
  appName: string;
  /** Absolute path to the new repo root (e.g. parentDir/workspaceName). */
  targetPath?: string;
}

export interface GithubCloneProgress {
  step: string;
  message: string;
  progress: number;
}

export interface GithubRepository {
  name: string;
  full_name: string;
  private: boolean;
}

export type CloneRepoReturnType =
  | {
      app: App;
      /** Initial chat row created with the cloned workspace */
      chatId?: number;
    }
  | {
      error: string;
    };

export interface SelectNodeFolderResult {
  path: string | null;
  canceled?: boolean;
  selectedPath: string | null;
}

/** One aggregated row of the edit-stats rollup. */
export interface EditStatsBucket {
  linesAdded: number;
  linesRemoved: number;
  edits: number;
}

export interface EditStatsWorkspaceRow extends EditStatsBucket {
  workspaceId: number;
  name: string;
  path: string;
}

export interface EditStatsModelRow extends EditStatsBucket {
  /** `compass` means the turn ran on Atlarix Core; anything else is the user's key. */
  provider: string;
  /** Resolved model id — never a `core-N` tier id. */
  modelId: string;
}

/** One day of the contribution calendar. */
export interface EditStatsDayRow extends EditStatsBucket {
  /** LOCAL calendar day, `YYYY-MM-DD` — the day the work actually happened. */
  day: string;
}

export interface EditStatsSummary {
  totals: EditStatsBucket;
  byWorkspace: EditStatsWorkspaceRow[];
  byModel: EditStatsModelRow[];
  /** Ascending by day. Days with no activity are ABSENT, not zero rows. */
  byDay: EditStatsDayRow[];
}
