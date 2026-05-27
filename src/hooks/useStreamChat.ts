import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import type {
  ComponentSelection,
  Message,
  FileAttachment,
} from "@/ipc/ipc_types";
import { useAtom, useAtomValue, useSetAtom, getDefaultStore } from "jotai";
import {
  normalizeChatActivityPayload,
  upsertActivityStreamItem,
} from "@/lib/chat-activity-normalize";
import {
  chatErrorByIdAtom,
  chatMessagesByIdAtom,
  chatStreamCountByIdAtom,
  isStreamingByIdAtom,
  recentStreamChatIdsAtom,
  lastTurnHadToolCallsByChatIdAtom,
  lastReasoningTokensByChatIdAtom,
  toolIndicatorAtom,
  streamLastActivityAtByChatIdAtom,
  streamSlowWarningByChatIdAtom,
  responseDoneAnimationAtom,
  restartedAfterMessageIdAtom,
  pendingUserQuestionByChatIdAtom,
  askUserStreamFreezeBaselineByChatIdAtom,
  livePlanUpdateByAssistantMessageIdAtom,
  planSnapshotByAssistantMessageIdAtom,
  completedTurnArtifactsByAssistantMessageIdAtom,
  completedTurnThinkingByAssistantMessageIdAtom,
  emptyToolIndicatorState,
  summarizationProgressAtom,
  activeTurnScopeAtom,
  inlineTimelineByMessageIdAtom,
  streamThreadByChatIdAtom,
  completedStreamThreadByAssistantMessageIdAtom,
  sourcesByAssistantMessageIdAtom,
  type CompletedTurnArtifacts,
} from "@/atoms/chatAtoms";
import {
  extractThoughtContentFromAssistantRaw,
  frozenThoughtContentForTurn,
  pickBestThoughtContent,
} from "@/lib/chat/frozen-turn-display";
import {
  streamThreadItemFromActivity,
  handleStreamToolEnd,
  freezeStreamThreadForAssistantMessage,
  mergePendingSubagentActivitiesIntoThread,
  streamThreadItemFromToolStart,
  upsertStreamThreadItem,
  mergeSubagentActivityIntoThread,
  mergeNestedToolActivityIntoSubagentRound,
} from "@/lib/chat/stream-thread";
import { buildInlineTimelineFromActivity } from "@/lib/chat/inline-timeline";
import {
  extractThinkingFromContent,
  hasThinkingSnapshotContent,
} from "@/lib/thinking/extract-thinking-from-content";
import {
  sourceListAtom,
  rightPanelVisibleAtom,
  rightPanelSuppressAutoOpenAtom,
  pendingProposalsAtom,
  diagramStateAtom,
  previewTabAtom,
  workspacePlanPanelAtom,
  aiPanelIntentAtom,
  terminalOutputsAtom,
  activityStreamItemsAtom,
  type SourceItem,
  type FileProposal,
  type DiagramState,
  type TerminalOutput,
  type ActivityStreamItem,
} from "@/atoms/sourceAtoms";
import {
  permissionQueueAtom,
  updateOperationStatus,
  addOperation,
  type QueuedOperation,
} from "@/atoms/permissionQueueAtom";
import { IpcClient } from "@/ipc/ipc_client";
import { compassUsageBumpAtom, isPreviewOpenAtom } from "@/atoms/viewAtoms";
import type { ChatResponseEnd } from "@/ipc/ipc_types";
import { useQueryClient } from "@tanstack/react-query";
import { useChats } from "./useChats";
import { invalidateAppQuery } from "./useLoadApp";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { resolveStreamAppId } from "@/lib/chat-workspace-binding";
import { ensureWorkspaceSessionForChat } from "@/lib/ensure-workspace-session";
import { applyAIWorkspaceSessionTitle } from "@/lib/workspace-session-title";
import { buildPromptWithTextPastes } from "@/lib/chat/text-paste-attachment";
import { workspaceSessionsRefreshAtom } from "@/atoms/sessionAtoms";
import { useVersions } from "./useVersions";
import { showExtraFilesToast, showError } from "@/lib/toast";
import { useProposal } from "./useProposal";
import { useRunApp } from "./useRunApp";
import { useContextTokenCount } from "./useCountTokens";
import { useUserBudgetInfo } from "./useUserBudgetInfo";
import { usePostHog } from "posthog-js/react";
import * as Sentry from "@sentry/electron/renderer";
import { ATLARIX_AUTH_REQUIRED_PREFIX } from "@/shared/auth_ipc";
import { useCheckProblems } from "./useCheckProblems";
import { useSettings } from "./useSettings";
import { activeChatIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function isSpammyProgressLine(line: string): boolean {
  const s = line.trim();
  if (!s) return true;
  if (/^\d+%$/.test(s)) return true;
  if (/^\[=+>\s*\]\s*\d+%/.test(s)) return true;
  if (/^(?:\u25A0|\u25A1|\u2591|\u2592|\u2593)+$/.test(s)) return true;
  return false;
}

function isErrorLikeLine(line: string): boolean {
  return /\b(error|failed|exception|traceback|fatal|warn(ing)?)\b/i.test(line);
}

function pushRing(buf: string[], lines: string[], max: number): string[] {
  if (max <= 0) return [];
  const next = buf.length ? [...buf, ...lines] : [...lines];
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}
import { playNotify, playRemaining } from "@/lib/sounds";
import type { WorkMode } from "@/lib/schemas";

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return 'web';
  }
}

/**
 * Extract actual domain from content (for GitHub Issues linking to external sites)
 * Looks for markdown links or URLs in the snippet
 */
function extractActualDomain(snippet: string, fallbackUrl: string): string {
  // Try markdown link format: [text](https://domain.com/...)
  const markdownMatch = snippet.match(/\[([^\]]+)\]\((https?:\/\/([^/)]+))/);
  if (markdownMatch && markdownMatch[3]) {
    return markdownMatch[3].replace('www.', '');
  }

  // Try bare URL in content
  const urlMatch = snippet.match(/https?:\/\/([^/\s)]+)/);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1].replace('www.', '');
  }

  // Fallback to source URL domain
  return extractDomain(fallbackUrl);
}

export function getRandomNumberId() {
  return Math.floor(Math.random() * 1_000_000_000_000_000);
}

/** PASS6: cap renderer-held chat history to limit heap growth (SQLite still has full history). */
const MAX_RENDERER_MESSAGES = 100;
function trimRendererMessages(msgs: Message[]): Message[] {
  if (msgs.length <= MAX_RENDERER_MESSAGES) return msgs;
  return msgs.slice(-MAX_RENDERER_MESSAGES);
}

function buildTurnArtifactsSnapshot(): CompletedTurnArtifacts | null {
  return null;
}

function resolveThoughtContentForPersist(
  chatId: number,
  rawFromRef: string | undefined,
  assistantContent: string | undefined,
): string | null {
  const fromRaw = rawFromRef
    ? extractThoughtContentFromAssistantRaw(rawFromRef)
    : null;
  const fromMessage = assistantContent
    ? extractThoughtContentFromAssistantRaw(assistantContent)
    : null;
  return pickBestThoughtContent(undefined, fromRaw, fromMessage);
}

function persistAndClearLiveStreamThread(
  chatId: number,
  assistantMessageId: number | undefined,
  thoughtContent?: string | null,
): void {
  const thought = thoughtContent?.trim() || null;
  const pendingActivities = getDefaultStore()
    .get(activityStreamItemsAtom)
    .filter((i) => i.chatId == null || i.chatId === chatId);

  getDefaultStore().set(streamThreadByChatIdAtom, (prev) => {
    const cur = mergePendingSubagentActivitiesIntoThread(
      prev.get(chatId) ?? [],
      pendingActivities,
      chatId,
    );
    if (assistantMessageId != null && (cur.length || thought)) {
      getDefaultStore().set(
        completedStreamThreadByAssistantMessageIdAtom,
        (frozen) => ({
          ...frozen,
          [assistantMessageId]: freezeStreamThreadForAssistantMessage(
            cur,
            thought,
          ),
        }),
      );
    }
    const n = new Map(prev);
    n.delete(chatId);
    return n;
  });
}

function captureThinkingSnapshotForChat(chatId: number, messages: Message[]): void {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant?.content) return;
  const snap = extractThinkingFromContent(lastAssistant.content);
  if (!hasThinkingSnapshotContent(snap)) return;
  getDefaultStore().set(completedTurnThinkingByAssistantMessageIdAtom, (prev) => ({
    ...prev,
    [lastAssistant.id]: snap,
  }));
}

export function useStreamChat({
  hasChatId = true,
}: { hasChatId?: boolean } = {}) {
  const setMessagesById = useSetAtom(chatMessagesByIdAtom);
  const setToolIndicator = useSetAtom(toolIndicatorAtom);
  const setStreamLastActivityAtByChatId = useSetAtom(streamLastActivityAtByChatIdAtom);
  const setStreamSlowWarningByChatId = useSetAtom(streamSlowWarningByChatIdAtom);
  const setResponseDoneAnimation = useSetAtom(responseDoneAnimationAtom);
  const isStreamingById = useAtomValue(isStreamingByIdAtom);
  const setIsStreamingById = useSetAtom(isStreamingByIdAtom);
  const errorById = useAtomValue(chatErrorByIdAtom);
  const setErrorById = useSetAtom(chatErrorByIdAtom);
  const setIsPreviewOpen = useSetAtom(isPreviewOpenAtom);
  const [selectedAppId] = useAtom(selectedAppIdAtom);
  const queryClient = useQueryClient();
  const { refreshChats } = useChats(selectedAppId);
  const refreshApp = useCallback(() => {
    if (selectedAppId != null) {
      void invalidateAppQuery(queryClient, { appId: selectedAppId });
    }
  }, [queryClient, selectedAppId]);

  const setStreamCountById = useSetAtom(chatStreamCountByIdAtom);
  const { refreshVersions } = useVersions(selectedAppId);
  const { refreshAppIframe } = useRunApp();
  const { refetchUserBudget } = useUserBudgetInfo();
  const { checkProblems } = useCheckProblems(selectedAppId);
  const { settings } = useSettings();
  const setRecentStreamChatIds = useSetAtom(recentStreamChatIdsAtom);
  const setSourceList = useSetAtom(sourceListAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const maybeAutoOpenRightPanel = () => {
    if (!getDefaultStore().get(rightPanelSuppressAutoOpenAtom)) {
      setRightPanelVisible(true);
    }
  };
  const setPendingProposals = useSetAtom(pendingProposalsAtom);
  const setDiagramState = useSetAtom(diagramStateAtom);
  const setPreviewTab = useSetAtom(previewTabAtom);
  const setTerminalOutputs = useSetAtom(terminalOutputsAtom);
  const setPermissionQueue = useSetAtom(permissionQueueAtom);
  const setLastTurnHadToolCallsByChatId = useSetAtom(lastTurnHadToolCallsByChatIdAtom);
  const posthog = usePostHog();
  let chatId: number | undefined;

  if (hasChatId) {
    const activeChatId = useAtomValue(activeChatIdAtom);
    const selectedChatId = useAtomValue(selectedChatIdAtom);
    chatId = (activeChatId ?? selectedChatId ?? undefined) ?? undefined;
  }
  let { refreshProposal } = hasChatId ? useProposal(chatId) : useProposal();
  // PASS8 E3: Shared context-only token count (dedup'd via React Query key).
  const { invalidateTokenCount } = useContextTokenCount(chatId ?? null);

  const setRestartedAfterMessageId = useSetAtom(restartedAfterMessageIdAtom);
  const setPendingUserQuestionByChatId = useSetAtom(pendingUserQuestionByChatIdAtom);
  const setAskUserStreamFreezeBaselineByChatId = useSetAtom(askUserStreamFreezeBaselineByChatIdAtom);

  // PASS6: throttle setMessagesById during streaming (max ~20/s) to avoid renderer OOM.
  /** AI workspace session title runs once per chat after the first assistant turn is persisted. */
  const sessionTitleGeneratedRef = useRef(new Set<number>());

  const messageStreamThrottleRef = useRef<{
    timer: ReturnType<typeof setInterval> | null;
    pending: Map<number, Message[]>;
    lastAssistantRawByChatId: Map<number, string>;
  }>({ timer: null, pending: new Map(), lastAssistantRawByChatId: new Map() });

  /** Pairs with IPC tool:start / tool:end (end often omits toolId). */
  const toolEndStackRef = useRef<
    Map<number, { toolId: string; toolName: string }[]>
  >(new Map());

  useEffect(() => {
    return () => {
      const t = messageStreamThrottleRef.current.timer;
      if (t != null) clearInterval(t);
      messageStreamThrottleRef.current.timer = null;
      messageStreamThrottleRef.current.pending.clear();
    };
  }, []);

  const streamMessage = useCallback(
    async ({
      prompt,
      chatId,
      redo,
      attachments,
      selectedComponents,
      modelOverride,
      onSettled,
      continueAfterQuestions,
      prefillTaskLedger,
      forceThinkingTier,
      workModeOverride,
    }: {
      prompt: string;
      chatId: number;
      redo?: boolean;
      attachments?: FileAttachment[];
      selectedComponents?: ComponentSelection[];
      modelOverride?: { provider: string; name: string };
      onSettled?: () => void;
      /** v3.9: Continue after clarifying questions (no new user message). */
      continueAfterQuestions?: boolean;
      prefillTaskLedger?: {
        steps: { description: string }[];
        sourcePlanMessageId?: number;
      };
      /** Auto: one-shot thinking tier for this message. */
      forceThinkingTier?: boolean;
      /** Resend/edit: work mode for this stream turn only. */
      workModeOverride?: import("@/lib/schemas").WorkMode;
    }) => {
      if (!chatId) return;
      const hasAttachments =
        attachments?.some((a) => a.file != null || a.textPaste?.content) ?? false;
      if (!continueAfterQuestions && !prompt.trim() && !hasAttachments) {
        return;
      }

      setRecentStreamChatIds((prev) => {
        const next = new Set(prev);
        next.add(chatId);
        return next;
      });

      setErrorById((prev) => {
        const next = new Map(prev);
        next.set(chatId, null);
        return next;
      });
      setIsStreamingById((prev) => {
        const next = new Map(prev);
        next.set(chatId, true);
        return next;
      });
      getDefaultStore().set(activeTurnScopeAtom, {
        chatId,
        assistantMessageId: -1,
        startedAt: Date.now(),
      });

      const th = messageStreamThrottleRef.current;
      if (th.timer != null) {
        clearInterval(th.timer);
        th.timer = null;
      }
      th.pending.clear();

      // Fix: Finding 4 — instant "Thinking…" before main round-trip
      setToolIndicator({
        ...emptyToolIndicatorState(),
        activeChatId: chatId,
        phaseLabel: "Thinking…",
      });
      setStreamSlowWarningByChatId((prev) => {
        const n = new Map(prev);
        n.delete(chatId);
        return n;
      });
      setStreamLastActivityAtByChatId((prev) => {
        const n = new Map(prev);
        n.set(chatId, Date.now());
        return n;
      });

      let hasIncrementedStreamCount = false;
      let cleanupStreamListeners: (() => void) | null = null;
      try {
        getDefaultStore().set(activityStreamItemsAtom, []);
        if (hasChatId) {
          getDefaultStore().set(streamThreadByChatIdAtom, (prev) => {
            const n = new Map(prev);
            n.set(chatId, []);
            return n;
          });
        }
        toolEndStackRef.current.delete(chatId);
        getDefaultStore().set(livePlanUpdateByAssistantMessageIdAtom, (prev) => {
          const n = new Map(prev);
          for (const [messageId, payload] of n) {
            if (payload.chatId === chatId) {
              n.delete(messageId);
            }
          }
          return n;
        });

        // Register permission handler for this chat
        const unsubscribeUserQuestion = IpcClient.getInstance().onUserQuestionRequest(
          chatId,
          (payload) => {
            queueMicrotask(() => {
              setPendingUserQuestionByChatId((prev) => ({
                ...prev,
                [chatId]: {
                  questionId: payload.questionId,
                  question: payload.question,
                  options: payload.options,
                },
              }));
              setAskUserStreamFreezeBaselineByChatId((prev) => {
                const next = { ...prev };
                delete next[chatId];
                return next;
              });
            });
          },
        );

        const unsubscribePermission = IpcClient.getInstance().onPermissionRequest(
          chatId,
          (payload) => {
            // Convert permission request to FileProposal format
            const request = payload.request;
            const previews = Array.isArray(request.preview)
              ? request.preview
              : [request.preview];

            // Handle file operations
            const fileProposals: FileProposal[] = previews
              .filter((p: any) => p.path) // File operations have a path
              .map((p: any) => ({
                id: payload.operationId,
                chatId,  // Include the chat session ID for approval
                path: p.path,
                operation: p.type === 'delete' ? 'delete' :
                  p.type === 'rename' ? 'rename' :
                    p.type === 'update' ? 'modify' : 'create',
                newContent: p.content,
                description: p.description,
                approved: false,
              }));

            // Handle command operations (check operation type, not preview fields)
            const commandProposals: FileProposal[] = request.operation === 'run_command'
              ? [{
                id: payload.operationId,
                chatId,
                path: '',  // Commands don't have a path
                operation: 'command' as const,
                command: (request.preview as any).command,
                workingDir: (request.preview as any).workingDirectory || '.',
                description: (request.preview as any).description || `Run: ${(request.preview as any).command}`,
                approved: false,
              }]
              : [];

            const allProposals = [...fileProposals, ...commandProposals];

            // Add to pending proposals (with deduplication)
            setPendingProposals((prev) => {
              // Deduplicate by operation ID - don't re-add if already exists
              const existingIds = new Set(prev.map(p => p.id));
              const newProposals = allProposals.filter(p => !existingIds.has(p.id));

              if (newProposals.length === 0) {
                return prev; // No new proposals to add
              }

              const combined = [...prev, ...newProposals];

              if (newProposals.length > 0) {
                if (prev.length > 0) {
                  playRemaining();
                } else {
                  playNotify();
                }
                const tab = getDefaultStore().get(previewTabAtom);
                if (tab !== "permissions") {
                  toast("Approval needed", {
                    description: `${newProposals.length} pending action(s) — open Permissions to review.`,
                    action: {
                      label: "Review",
                      onClick: () => setPreviewTab("permissions"),
                    },
                  });
                }
              }

              return combined;
            });

            setRightPanelVisible(true);
          }
        );

        // Register diagram handler for this chat
        const unsubscribeDiagram = IpcClient.getInstance().onWorkspaceDiagram(
          chatId,
          (payload) => {
            const code =
              (payload as any).mermaidCode ??
              (payload as any).diagram ??
              '';
            const title =
              (payload as any).title ??
              ((payload as any).summary ? `Architecture - ${(payload as any).summary}` : 'Architecture Diagram');
            const typeRaw = (payload as any).type;

            // Set diagram state from workspace context
            setDiagramState({
              code,
              type: typeRaw === 'class' ? 'class' :
                typeRaw === 'sequence' ? 'sequence' :
                  typeRaw === 'flowchart' ? 'flowchart' : 'mermaid',
              compareMode: 'current',
              title,
              workspaceId: selectedAppId ?? undefined,
            });
            // PASS6: do not auto-open right panel for diagrams — user opens when needed.
          }
        );

        // Register terminal output handler for this chat
        const pendingToolLiveRef = {
          rawLines: [] as string[],
          errLines: [] as string[],
          progLines: [] as string[],
          lastIncomingLine: null as string | null,
        };
        let toolLiveFlushTimer: ReturnType<typeof setTimeout> | null = null;
        const flushToolLive = () => {
          toolLiveFlushTimer = null;
          const rawLines = pendingToolLiveRef.rawLines;
          const errLines = pendingToolLiveRef.errLines;
          const progLines = pendingToolLiveRef.progLines;
          if (rawLines.length === 0 && errLines.length === 0 && progLines.length === 0) return;

          pendingToolLiveRef.rawLines = [];
          pendingToolLiveRef.errLines = [];
          pendingToolLiveRef.progLines = [];

          setToolIndicator((prev) => {
            if (!prev.active || prev.activeChatId !== chatId) return prev;
            const maxRaw = 300;
            const maxErr = 120;
            const maxProg = 120;
            return {
              ...prev,
              liveOutputLines: pushRing(prev.liveOutputLines, rawLines, maxRaw),
              liveErrorLines: pushRing(prev.liveErrorLines, errLines, maxErr),
              liveProgressLines: pushRing(prev.liveProgressLines, progLines, maxProg),
            };
          });
        };

        const unsubscribeTerminal = IpcClient.getInstance().onTerminalOutput(
          chatId,
          (payload) => {
            // Stream live output into tool indicator when it's active for this chat
            const raw = stripAnsi(payload.output ?? "");
            const incomingLines = raw
              .split(/\r?\n/)
              .map((l) => l.trimEnd())
              .filter(Boolean);
            if (incomingLines.length > 0) {
              // Dedupe (cheap): avoid repeating the exact same last incoming line endlessly.
              const lastIncoming = pendingToolLiveRef.lastIncomingLine;
              if (incomingLines.length === 1 && lastIncoming && incomingLines[0] === lastIncoming) {
                // no-op
              } else {
                pendingToolLiveRef.lastIncomingLine = incomingLines[incomingLines.length - 1] ?? lastIncoming;
                for (const ln of incomingLines) {
                  pendingToolLiveRef.rawLines.push(ln);
                  if (isErrorLikeLine(ln)) pendingToolLiveRef.errLines.push(ln);
                  if (!isSpammyProgressLine(ln)) pendingToolLiveRef.progLines.push(ln);
                }
              }

              // Throttle UI updates to avoid render storms.
              if (!toolLiveFlushTimer) {
                toolLiveFlushTimer = setTimeout(flushToolLive, 250);
              }
            }

            // Update terminal outputs Map for CommandOutputCard display
            setTerminalOutputs((prev) => {
              const next = new Map(prev);
              const existing = next.get(payload.commandId);

              const output: TerminalOutput = {
                operationId: payload.commandId,
                command: payload.command,
                output: payload.output || '',
                status: payload.status,
                exitCode: payload.exitCode,
                startTime: existing?.startTime || Date.now(),
                duration: existing?.startTime
                  ? Date.now() - existing.startTime
                  : undefined,
              };

              next.set(payload.commandId, output);
              return next;
            });

            // Show terminal panel when commands are running
            // BUT: Don't force-switch if this is a permission-based command
            // (The AI intent system handles panel switching for those)
            if (payload.status === 'running' && !payload.isPermissionBased) {
              maybeAutoOpenRightPanel();
              setPreviewTab('terminal');
            }

            // Clear completed/error commands from map after a delay
            if (payload.status === 'completed' || payload.status === 'error') {
              // Show error toast to inform user when command fails
              if (payload.status === 'error') {
                const shortCmd = payload.command.length > 50
                  ? payload.command.substring(0, 50) + '...'
                  : payload.command;
                showError(
                  `Command failed: ${shortCmd}\n\n${payload.output || `Exit code: ${payload.exitCode ?? 'unknown'}`}`
                );
              }

              setTimeout(() => {
                setTerminalOutputs((prev) => {
                  const next = new Map(prev);
                  next.delete(payload.commandId);
                  return next;
                });
              }, 5000);  // Keep visible for 5 seconds after completion
            }
          }
        );

        // Register operation status listener for permission queue UI
        const unsubscribeOperationStatus = IpcClient.getInstance().onOperationStatus(
          (payload) => {
            // Update permission queue state based on operation status
            setPermissionQueue((prev) => {
              return updateOperationStatus(prev, payload.operationId, {
                status: payload.status as QueuedOperation['status'],
                progress: payload.progress,
                duration: payload.duration,
                error: payload.error,
              });
            });
          }
        );

        const unsubPlanArtifact = IpcClient.getInstance().onPlanArtifactUpdated((payload) => {
          getDefaultStore().set(workspacePlanPanelAtom, (prev) => ({
            ...prev,
            planId: payload.planId,
            content: payload.content,
            planStatus: payload.planStatus,
            sessionId: payload.sessionId,
          }));
          getDefaultStore().set(aiPanelIntentAtom, {
            intent: "show-plan",
            timestamp: Date.now(),
            source: "system",
          });
        });

        const unsubscribeChatActivity = IpcClient.getInstance().onChatActivity((payload: unknown) => {
          if (!payload || typeof payload !== "object") return;
          const p = payload as {
            chatId?: number;
            type?: string;
            id?: unknown;
            label?: unknown;
            timestamp?: number;
            fromAgent?: unknown;
            toAgent?: unknown;
            modelId?: unknown;
            responseMs?: unknown;
          };
          if (typeof p.chatId !== "number" || p.chatId !== chatId) return;

          const item = normalizeChatActivityPayload(payload);
          if (item) {
            getDefaultStore().set(activityStreamItemsAtom, (prev) =>
              upsertActivityStreamItem(prev, item),
            );
            if (hasChatId) {
              const isSubagent =
                item.type === "subagent_start" ||
                item.type === "subagent_progress" ||
                item.type === "subagent_complete";
              if (isSubagent) {
                getDefaultStore().set(streamThreadByChatIdAtom, (prev) => {
                  const n = new Map(prev);
                  const cur = n.get(chatId) ?? [];
                  n.set(chatId, mergeSubagentActivityIntoThread(cur, item));
                  return n;
                });
              } else {
                const parentDelegationId =
                  item.parentDelegationId?.trim() || undefined;
                const isNestedTool =
                  parentDelegationId &&
                  (item.type === "tool_use" || item.type === "tool");
                if (isNestedTool) {
                  getDefaultStore().set(streamThreadByChatIdAtom, (prev) => {
                    const n = new Map(prev);
                    const cur = n.get(chatId) ?? [];
                    n.set(
                      chatId,
                      mergeNestedToolActivityIntoSubagentRound(
                        cur,
                        parentDelegationId,
                        item,
                      ),
                    );
                    return n;
                  });
                } else {
                  const threadItem = streamThreadItemFromActivity(item);
                  if (threadItem) {
                    getDefaultStore().set(streamThreadByChatIdAtom, (prev) => {
                      const n = new Map(prev);
                      const cur = n.get(chatId) ?? [];
                      let next = cur;
                      if (
                        threadItem.kind === "tool" &&
                        threadItem.status !== "running"
                      ) {
                        next = handleStreamToolEnd(cur, {
                          toolId: item.toolName ?? threadItem.id,
                          toolName: item.toolName,
                          status: threadItem.status,
                          detail: item.detail,
                        });
                      } else {
                        next = upsertStreamThreadItem(cur, threadItem);
                      }
                      n.set(chatId, next);
                      return n;
                    });
                  }
                }
              }
            }
          }

          if (p.type === "plan_created") {
            getDefaultStore().set(aiPanelIntentAtom, {
              intent: "show-plan",
              timestamp: Date.now(),
              source: "system",
            });
          }

        });

        const unsubscribeToolIndicator = IpcClient.getInstance().onToolIndicator(
          (start) => {
            if (start.chatId !== chatId) return;
            const registryName =
              start.toolId?.trim() || start.toolName?.trim() || "tool";
            const isDelegationTool =
              registryName === "spawn_sub_agent" ||
              registryName === "delegate_to_agent";
            if (isDelegationTool) {
              return;
            }
            const stack = toolEndStackRef.current.get(chatId) ?? [];
            stack.push({ toolId: registryName, toolName: registryName });
            toolEndStackRef.current.set(chatId, stack);
            if (hasChatId) {
              const threadItem = streamThreadItemFromToolStart({
                toolId: registryName,
              });
              getDefaultStore().set(streamThreadByChatIdAtom, (prev) => {
                const n = new Map(prev);
                const cur = n.get(chatId) ?? [];
                n.set(chatId, upsertStreamThreadItem(cur, threadItem));
                return n;
              });
            }
            setToolIndicator((prev) => ({
              ...prev,
              active: true,
              toolName: start.toolName,
              toolId: start.toolId ?? null,
              phaseLabel: null,
              count: prev.count + 1,
              activeChatId: chatId,
              liveOutputLines: [],
              liveErrorLines: [],
              liveProgressLines: [],
              liveViewMode: "error_first",
            }));
          },
          (end) => {
            if (end.chatId !== chatId) return;
            const endName =
              end.toolId?.trim() ||
              end.toolName?.trim() ||
              "";
            const isDelegationEnd =
              endName === "spawn_sub_agent" ||
              endName === "delegate_to_agent";
            if (isDelegationEnd) {
              return;
            }
            const stack = toolEndStackRef.current.get(chatId) ?? [];
            const popped = stack.pop();
            if (stack.length === 0) {
              toolEndStackRef.current.delete(chatId);
            } else {
              toolEndStackRef.current.set(chatId, stack);
            }
            if (hasChatId) {
              getDefaultStore().set(streamThreadByChatIdAtom, (prev) => {
                const n = new Map(prev);
                const cur = n.get(chatId) ?? [];
                n.set(
                  chatId,
                  handleStreamToolEnd(cur, {
                    toolId: end.toolId ?? popped?.toolId,
                    toolName: popped?.toolName,
                    status: end.status === "error" ? "error" : "done",
                  }),
                );
                return n;
              });
            }
            setToolIndicator((prev) => {
              const newCount = Math.max(0, prev.count - 1);
              return {
                ...prev,
                active: newCount > 0,
                count: newCount,
                phaseLabel: newCount === 0 ? null : prev.phaseLabel,
              };
            });
          },
        );

        cleanupStreamListeners = () => {
          if (toolLiveFlushTimer) {
            clearTimeout(toolLiveFlushTimer);
            toolLiveFlushTimer = null;
          }
          // Best-effort: flush anything pending once at the end.
          flushToolLive();

          unsubscribeUserQuestion?.();
          unsubscribePermission?.();
          unsubscribeDiagram?.();
          unsubscribeTerminal?.();
          unsubscribeOperationStatus?.();
          unsubscribeChatActivity?.();
          unsubPlanArtifact?.();
          unsubscribeToolIndicator?.();
        };

        const intentMode =
          settings?.intentMode ??
          (settings?.selectedChatMode === "agent"
            ? "build"
            : settings?.selectedChatMode) ??
          "build";
        // Pass 7: Blueprint injection-mode + debug-trace plumbing removed.

        const { prompt: promptForModel, fileAttachments } = buildPromptWithTextPastes(
          prompt,
          attachments,
        );

        const streamAppId = resolveStreamAppId(chatId);
        let workspaceSessionId: string | null = null;
        if (streamAppId != null && !continueAfterQuestions && !redo && promptForModel.trim()) {
          workspaceSessionId = await ensureWorkspaceSessionForChat(
            streamAppId,
            chatId,
          );
          if (workspaceSessionId) {
            try {
              await IpcClient.getInstance().addSessionMessage(
                workspaceSessionId,
                "user",
                promptForModel.trim(),
              );
            } catch (e) {
              console.error("Failed to persist user session message:", e);
            }
          }
        }

        IpcClient.getInstance().streamMessage(promptForModel, {
          selectedComponents: selectedComponents ?? [],
          chatId,
          redo,
          attachments: fileAttachments,
          modelOverride,
          appId: streamAppId,
          continueAfterQuestions,
          workspaceSessionId: workspaceSessionId ?? undefined,
          prefillTaskLedger,
          forceThinkingTier,
          workModeOverride,
          onUpdate: (updatedMessages: Message[]) => {
            const pendingSnap = getDefaultStore().get(pendingUserQuestionByChatIdAtom);
            const baselineSnap = getDefaultStore().get(askUserStreamFreezeBaselineByChatIdAtom);
            const baseline = baselineSnap[chatId];
            let messagesForUi = updatedMessages;
            if (pendingSnap[chatId] != null && baseline !== undefined) {
              const msgs = [...updatedMessages];
              const li = msgs.length - 1;
              if (li >= 0 && msgs[li].role === "assistant") {
                const cur = msgs[li].content ?? "";
                if (cur.length > baseline.length) {
                  msgs[li] = { ...msgs[li], content: baseline };
                }
              }
              messagesForUi = msgs;
            }

            if (!hasIncrementedStreamCount) {
              setStreamCountById((prev) => {
                const next = new Map(prev);
                next.set(chatId, (prev.get(chatId) ?? 0) + 1);
                return next;
              });
              hasIncrementedStreamCount = true;
            }

            setStreamLastActivityAtByChatId((prev) => {
              const n = new Map(prev);
              n.set(chatId, Date.now());
              return n;
            });

            // Extract and enrich sources from messages
            const allSources: SourceItem[] = [];
            const seenUrls = new Set<string>();

            for (const msg of messagesForUi) {
              if (msg.sources && Array.isArray(msg.sources)) {
                for (const source of msg.sources) {
                  const src = source as any;
                  const url = src.url || '';

                  // Skip duplicates
                  if (seenUrls.has(url)) continue;
                  seenUrls.add(url);

                  // Filter spam GitHub Issues (score ≤ 1.0)
                  const isGitHubIssue = url.includes('github.com') && url.includes('/issues/');
                  const score = src.score || 0;
                  if (isGitHubIssue && score <= 1.0) continue;

                  // Extract actual domain from content (for GitHub Issues linking to external sites)
                  const actualDomain = extractActualDomain(src.snippet || '', url);

                  allSources.push({
                    id: src.id || `${url}-${allSources.length}`,
                    title: src.title || 'Untitled',
                    url: url,
                    snippet: src.snippet || src.content || '',
                    // Use Perplexica's favicon method (full URL, not just domain)
                    favicon: `https://s2.googleusercontent.com/s2/favicons?domain_url=${encodeURIComponent(url)}&sz=32`,
                    source: src.source || 'web',
                    score: score,
                  });
                }
              }
            }

            // Sort by score descending (highest first)
            allSources.sort((a, b) => (b.score || 0) - (a.score || 0));

            // Update sourceListAtom if we found sources
            if (allSources.length > 0) {
              setSourceList(allSources);
              maybeAutoOpenRightPanel(); // Auto-show panel when sources arrive
            }

            const th = messageStreamThrottleRef.current;
            const lastAsst = [...messagesForUi].reverse().find((m) => m.role === "assistant");
            if (lastAsst?.id != null && allSources.length > 0) {
              getDefaultStore().set(sourcesByAssistantMessageIdAtom, (prev) => ({
                ...prev,
                [lastAsst.id]: allSources,
              }));
            }
            if (lastAsst?.content) {
              th.lastAssistantRawByChatId.set(chatId, lastAsst.content);
            }
            if (lastAsst) {
              getDefaultStore().set(activeTurnScopeAtom, (prev) =>
                prev?.chatId === chatId
                  ? {
                      chatId,
                      assistantMessageId: lastAsst.id,
                      startedAt: prev.startedAt,
                    }
                  : prev,
              );
            }
            th.pending.set(chatId, messagesForUi);
            if (th.timer == null) {
              th.timer = setInterval(() => {
                if (th.pending.size === 0) return;
                const snapshot = new Map(th.pending);
                th.pending.clear();
                setMessagesById((prev) => {
                  const next = new Map(prev);
                  for (const [cid, m] of snapshot) {
                    next.set(cid, m);
                  }
                  return next;
                });
              }, 50);
            }
          },
          onEnd: (response: ChatResponseEnd) => {
            const liveMap = getDefaultStore().get(livePlanUpdateByAssistantMessageIdAtom);
            for (const [messageId, live] of liveMap) {
              if (live.chatId === response.chatId && live.steps.length > 0) {
                getDefaultStore().set(planSnapshotByAssistantMessageIdAtom, (prev) => ({
                  ...prev,
                  [messageId]: live,
                }));
              }
            }
            getDefaultStore().set(livePlanUpdateByAssistantMessageIdAtom, (prev) => {
              const n = new Map(prev);
              for (const [messageId, live] of n) {
                if (live.chatId === response.chatId) {
                  n.delete(messageId);
                }
              }
              return n;
            });
            cleanupStreamListeners?.();

            const thEnd = messageStreamThrottleRef.current;
            if (thEnd.timer != null) {
              clearInterval(thEnd.timer);
              thEnd.timer = null;
            }
            if (thEnd.pending.size > 0) {
              setMessagesById((prev) => {
                const next = new Map(prev);
                for (const [cid, m] of thEnd.pending) {
                  next.set(cid, m);
                }
                return next;
              });
              thEnd.pending.clear();
            }

            if (response.updatedFiles) {
              setIsPreviewOpen(true);
              refreshAppIframe();
              if (settings?.enableAutoFixProblems) {
                checkProblems();
              }
            }
            if (response.extraFiles) {
              showExtraFilesToast({
                files: response.extraFiles,
                error: response.extraFilesError,
                posthog,
              });
            }
            refreshProposal(chatId);

            refetchUserBudget();

            if (response.usedCompass) {
              getDefaultStore().set(compassUsageBumpAtom, (n) => n + 1);
              posthog?.capture("compass:turn_completed", {
                chat_id: response.chatId,
                tokens: response.compassTokens,
                tier: response.compassTier,
                surface: hasChatId ? "workspace_chat" : "floating_chat",
              });
            }

            if (
              typeof response.reasoningTokens === "number" &&
              response.reasoningTokens > 0
            ) {
              getDefaultStore().set(lastReasoningTokensByChatIdAtom, (prev) => ({
                ...prev,
                [response.chatId]: response.reasoningTokens!,
              }));
            }

            // Keep the same as below
            setIsStreamingById((prev) => {
              const next = new Map(prev);
              next.set(chatId, false);
              return next;
            });
            refreshChats();
            refreshApp();
            refreshVersions();
            invalidateTokenCount();

            // Play notification sound only when the turn had tool runs or a permission request
            if (response.hadToolCallsOrPermissions) {
              playNotify();
            }

            // Store for ChatMessage so we can show "No actions this turn" when false in agent mode
            setLastTurnHadToolCallsByChatId((prev) => ({
              ...prev,
              [response.chatId]: response.hadToolCallsOrPermissions === true,
            }));

            const msgs =
              getDefaultStore().get(chatMessagesByIdAtom).get(response.chatId) ?? [];
            const rawFromRef =
              messageStreamThrottleRef.current.lastAssistantRawByChatId.get(
                response.chatId,
              );
            if (rawFromRef) {
              const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
              if (lastAssistant) {
                const snap = extractThinkingFromContent(rawFromRef);
                if (hasThinkingSnapshotContent(snap)) {
                  getDefaultStore().set(
                    completedTurnThinkingByAssistantMessageIdAtom,
                    (prev) => ({ ...prev, [lastAssistant.id]: snap }),
                  );
                }
              }
            } else {
              captureThinkingSnapshotForChat(response.chatId, msgs);
            }
            messageStreamThrottleRef.current.lastAssistantRawByChatId.delete(
              response.chatId,
            );
            const appIdForPersist = getDefaultStore().get(selectedAppIdAtom);
            void (async () => {
              const sessionIdForPersist =
                appIdForPersist != null
                  ? await ensureWorkspaceSessionForChat(
                      appIdForPersist,
                      response.chatId,
                    )
                  : null;
              if (!sessionIdForPersist || appIdForPersist == null) return;
              const lastAssistant = [...msgs]
                .reverse()
                .find((m) => m.role === "assistant");
              const assistantContent = lastAssistant?.content?.trim();
              if (!assistantContent) return;
              try {
                await IpcClient.getInstance().addSessionMessage(
                  sessionIdForPersist,
                  "assistant",
                  assistantContent,
                );
                if (!sessionTitleGeneratedRef.current.has(response.chatId)) {
                  sessionTitleGeneratedRef.current.add(response.chatId);
                  await applyAIWorkspaceSessionTitle(sessionIdForPersist);
                }
              } catch (e) {
                console.error("Failed to persist assistant session message:", e);
              }
            })();
            const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
            if (lastAssistant) {
              const thinkingSnap =
                getDefaultStore().get(completedTurnThinkingByAssistantMessageIdAtom)[
                  lastAssistant.id
                ] ?? null;
              const timeline = buildInlineTimelineFromActivity(
                activitySnap.filter(
                  (i) => i.chatId == null || i.chatId === response.chatId,
                ),
                thinkingSnap,
              );
              if (timeline.length > 0) {
                getDefaultStore().set(inlineTimelineByMessageIdAtom, (prev) => ({
                  ...prev,
                  [lastAssistant.id]: timeline,
                }));
              }
            }
            getDefaultStore().set(activeTurnScopeAtom, null);

            // v3.5: Clear persistent tool indicator when stream ends
            setToolIndicator(emptyToolIndicatorState());
            getDefaultStore().set(summarizationProgressAtom, {
              active: false,
              chatId: null,
              label: undefined,
            });
            if (hasChatId) {
              persistAndClearLiveStreamThread(
                response.chatId,
                lastAssistant?.id,
              );
            } else {
              getDefaultStore().set(streamThreadByChatIdAtom, (prev) => {
                const n = new Map(prev);
                n.delete(response.chatId);
                return n;
              });
            }
            getDefaultStore().set(activityStreamItemsAtom, []);
            toolEndStackRef.current.delete(response.chatId);
            setStreamLastActivityAtByChatId((prev) => {
              const n = new Map(prev);
              n.delete(response.chatId);
              return n;
            });
            setStreamSlowWarningByChatId((prev) => {
              const n = new Map(prev);
              n.delete(response.chatId);
              return n;
            });

            // v3.5: Brief "done" phase of Atlarix animation when response completes
            setResponseDoneAnimation({ chatId: response.chatId, until: Date.now() + 2000 });

            // PASS6: trim renderer message window after a completed turn (not during streaming).
            setMessagesById((prev) => {
              const next = new Map(prev);
              const cur = next.get(response.chatId);
              if (cur) next.set(response.chatId, trimRendererMessages(cur));
              return next;
            });

            // v3.9: Clear "conversation restarted from here" divider when stream ends
            setRestartedAfterMessageId(null);

            onSettled?.();
          },
          onError: (errorMessage: string) => {
            const liveMapErr = getDefaultStore().get(livePlanUpdateByAssistantMessageIdAtom);
            for (const [messageId, liveErr] of liveMapErr) {
              if (liveErr.chatId === chatId && liveErr.steps.length > 0) {
                getDefaultStore().set(planSnapshotByAssistantMessageIdAtom, (prev) => ({
                  ...prev,
                  [messageId]: liveErr,
                }));
              }
            }
            getDefaultStore().set(livePlanUpdateByAssistantMessageIdAtom, (prev) => {
              const n = new Map(prev);
              for (const [messageId, live] of n) {
                if (live.chatId === chatId) {
                  n.delete(messageId);
                }
              }
              return n;
            });
            cleanupStreamListeners?.();
            const thErr = messageStreamThrottleRef.current;
            if (thErr.timer != null) {
              clearInterval(thErr.timer);
              thErr.timer = null;
            }
            if (thErr.pending.size > 0) {
              setMessagesById((prev) => {
                const next = new Map(prev);
                for (const [cid, m] of thErr.pending) {
                  next.set(cid, m);
                }
                return next;
              });
              thErr.pending.clear();
            }
            console.error(`[CHAT] Stream error for ${chatId}:`, errorMessage);
            if (errorMessage.includes(ATLARIX_AUTH_REQUIRED_PREFIX)) {
              posthog?.capture("auth:chat_stream_blocked", { chat_id: chatId });
            } else if (/compass/i.test(errorMessage)) {
              posthog?.capture("compass:turn_failed", {
                chat_id: chatId,
                error_snippet: errorMessage.slice(0, 240),
              });
              Sentry.captureException(new Error(errorMessage.slice(0, 500)), {
                tags: { feature: "compass", source: "renderer_stream" },
                extra: { chatId },
              });
            }
            setErrorById((prev) => {
              const next = new Map(prev);
              next.set(chatId, errorMessage);
              return next;
            });

            // Keep the same as above
            setIsStreamingById((prev) => {
              const next = new Map(prev);
              next.set(chatId, false);
              return next;
            });
            const msgsErr =
              getDefaultStore().get(chatMessagesByIdAtom).get(chatId) ?? [];
            const rawErr =
              messageStreamThrottleRef.current.lastAssistantRawByChatId.get(chatId);
            if (rawErr) {
              const lastAssistant = [...msgsErr].reverse().find((m) => m.role === "assistant");
              if (lastAssistant) {
                const snap = extractThinkingFromContent(rawErr);
                if (hasThinkingSnapshotContent(snap)) {
                  getDefaultStore().set(
                    completedTurnThinkingByAssistantMessageIdAtom,
                    (prev) => ({ ...prev, [lastAssistant.id]: snap }),
                  );
                }
              }
            } else {
              captureThinkingSnapshotForChat(chatId, msgsErr);
            }
            messageStreamThrottleRef.current.lastAssistantRawByChatId.delete(chatId);
            const lastAssistantErr = [...msgsErr]
              .reverse()
              .find((m) => m.role === "assistant");
            if (lastAssistantErr) {
              const thinkingSnap =
                getDefaultStore().get(completedTurnThinkingByAssistantMessageIdAtom)[
                  lastAssistantErr.id
                ] ?? null;
              const timeline = buildInlineTimelineFromActivity(
                activityErr.filter((i) => i.chatId == null || i.chatId === chatId),
                thinkingSnap,
              );
              if (timeline.length > 0) {
                getDefaultStore().set(inlineTimelineByMessageIdAtom, (prev) => ({
                  ...prev,
                  [lastAssistantErr.id]: timeline,
                }));
              }
            }
            getDefaultStore().set(activeTurnScopeAtom, null);

            setToolIndicator(emptyToolIndicatorState());
            getDefaultStore().set(summarizationProgressAtom, {
              active: false,
              chatId: null,
              label: undefined,
            });
            if (hasChatId) {
              persistAndClearLiveStreamThread(chatId, lastAssistantErr?.id);
            } else {
              getDefaultStore().set(streamThreadByChatIdAtom, (prev) => {
                const n = new Map(prev);
                n.delete(chatId);
                return n;
              });
            }
            getDefaultStore().set(activityStreamItemsAtom, []);
            toolEndStackRef.current.delete(chatId);
            setStreamLastActivityAtByChatId((prev) => {
              const n = new Map(prev);
              n.delete(chatId);
              return n;
            });
            setStreamSlowWarningByChatId((prev) => {
              const n = new Map(prev);
              n.delete(chatId);
              return n;
            });
            refreshChats();
            refreshApp();
            refreshVersions();
            invalidateTokenCount();

            setMessagesById((prev) => {
              const next = new Map(prev);
              const cur = next.get(chatId);
              if (cur) next.set(chatId, trimRendererMessages(cur));
              return next;
            });

            onSettled?.();
          },
        });

        // Cleanup permission handler when this stream callback scope exits
        // Note: This happens in onEnd/onError callbacks, but we also need to handle
        // the case where the stream setup fails
      } catch (error) {
        console.error("[CHAT] Exception during streaming setup:", error);
        try {
          cleanupStreamListeners?.();
        } catch {
          // ignore
        }
        setToolIndicator(emptyToolIndicatorState());
        if (chatId) {
          setStreamLastActivityAtByChatId((prev) => {
            const n = new Map(prev);
            n.delete(chatId);
            return n;
          });
          setStreamSlowWarningByChatId((prev) => {
            const n = new Map(prev);
            n.delete(chatId);
            return n;
          });
        }
        setIsStreamingById((prev) => {
          const next = new Map(prev);
          if (chatId) next.set(chatId, false);
          return next;
        });
        setErrorById((prev) => {
          const next = new Map(prev);
          if (chatId)
            next.set(
              chatId,
              error instanceof Error ? error.message : String(error),
            );
          return next;
        });
        onSettled?.();
      }
    },
    [
      setMessagesById,
      setToolIndicator,
      setStreamLastActivityAtByChatId,
      setStreamSlowWarningByChatId,
      setResponseDoneAnimation,
      setIsStreamingById,
      setIsPreviewOpen,
      checkProblems,
      selectedAppId,
      refetchUserBudget,
      settings,
      setLastTurnHadToolCallsByChatId,
      setRestartedAfterMessageId,
      setPendingUserQuestionByChatId,
      setAskUserStreamFreezeBaselineByChatId,
      posthog,
      hasChatId,
    ],
  );

  return {
    streamMessage,
    isStreaming:
      hasChatId && chatId !== undefined
        ? (isStreamingById.get(chatId) ?? false)
        : false,
    error:
      hasChatId && chatId !== undefined
        ? (errorById.get(chatId) ?? null)
        : null,
    setError: (value: string | null) =>
      setErrorById((prev) => {
        const next = new Map(prev);
        if (chatId !== undefined) next.set(chatId, value);
        return next;
      }),
    setIsStreaming: (value: boolean) =>
      setIsStreamingById((prev) => {
        const next = new Map(prev);
        if (chatId !== undefined) next.set(chatId, value);
        return next;
      }),
  };
}
