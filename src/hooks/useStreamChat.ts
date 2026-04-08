import { useCallback, useEffect } from "react";
import type {
  ComponentSelection,
  Message,
  FileAttachment,
} from "@/ipc/ipc_types";
import { useAtom, useAtomValue, useSetAtom, getDefaultStore } from "jotai";
import {
  chatErrorByIdAtom,
  chatMessagesByIdAtom,
  chatStreamCountByIdAtom,
  isStreamingByIdAtom,
  recentStreamChatIdsAtom,
  lastTurnHadToolCallsByChatIdAtom,
  toolIndicatorAtom,
  streamLastActivityAtByChatIdAtom,
  streamSlowWarningByChatIdAtom,
  responseDoneAnimationAtom,
  questionsByMessageIdAtom,
  restartedAfterMessageIdAtom,
  pendingUserQuestionByChatIdAtom,
  blueprintInjectionChatOverrideAtom,
} from "@/atoms/chatAtoms";
import {
  sourceListAtom,
  rightPanelVisibleAtom,
  rightPanelSuppressAutoOpenAtom,
  pendingProposalsAtom,
  diagramStateAtom,
  previewTabAtom,
  terminalOutputsAtom,
  type SourceItem,
  type FileProposal,
  type DiagramState,
  type TerminalOutput,
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
import { useChats } from "./useChats";
import { useLoadApp } from "./useLoadApp";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { useVersions } from "./useVersions";
import { showExtraFilesToast, showError } from "@/lib/toast";
import { useProposal } from "./useProposal";
import { useSearch } from "@tanstack/react-router";
import { useRunApp } from "./useRunApp";
import { useCountTokens } from "./useCountTokens";
import { useUserBudgetInfo } from "./useUserBudgetInfo";
import { usePostHog } from "posthog-js/react";
import * as Sentry from "@sentry/electron/renderer";
import { ATLARIX_AUTH_REQUIRED_PREFIX } from "@/shared/auth_ipc";
import { useCheckProblems } from "./useCheckProblems";
import { useSettings } from "./useSettings";

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
import { blueprintTierForWorkMode } from "@/lib/work-mode";
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
  const { refreshChats } = useChats(selectedAppId);
  const { refreshApp } = useLoadApp(selectedAppId);

  const setStreamCountById = useSetAtom(chatStreamCountByIdAtom);
  const { refreshVersions } = useVersions(selectedAppId);
  const { refreshAppIframe } = useRunApp();
  const { refetchUserBudget } = useUserBudgetInfo();
  const { checkProblems } = useCheckProblems(selectedAppId);
  const { settings } = useSettings();
  const blueprintChatTierOverride = useAtomValue(blueprintInjectionChatOverrideAtom);
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
    const { id } = useSearch({ from: "/chat" });
    chatId = id;
  }
  let { refreshProposal } = hasChatId ? useProposal(chatId) : useProposal();
  const { invalidateTokenCount } = useCountTokens(chatId ?? null, "");

  const setQuestionsByMessageId = useSetAtom(questionsByMessageIdAtom);
  const setRestartedAfterMessageId = useSetAtom(restartedAfterMessageIdAtom);
  const setPendingUserQuestionByChatId = useSetAtom(pendingUserQuestionByChatIdAtom);

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
    }) => {
      if (!chatId) return;
      if (
        !continueAfterQuestions &&
        (!prompt.trim() && (!attachments || attachments.length === 0))
      ) {
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

      // Fix: Finding 4 — instant "Thinking…" before main round-trip
      setToolIndicator({
        active: false,
        toolName: null,
        count: 0,
        activeChatId: chatId,
        liveOutputLines: [],
        liveErrorLines: [],
        liveProgressLines: [],
        liveViewMode: "error_first",
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
        // Register permission handler for this chat
        const unsubscribeUserQuestion = IpcClient.getInstance().onUserQuestionRequest(
          chatId,
          (payload) => {
            setPendingUserQuestionByChatId((prev) => ({
              ...prev,
              [chatId]: {
                questionId: payload.questionId,
                question: payload.question,
                options: payload.options,
              },
            }));
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

              // Play sound whenever new permission requests arrive (first batch or additional)
              if (newProposals.length > 0) {
                if (prev.length > 0) {
                  playRemaining();
                } else {
                  playNotify();
                }
              }

              return combined;
            });

            // Show panel and force Code tab so user sees new files/commands
            setRightPanelVisible(true);
            setPreviewTab('code');
          }
        );

        // Register diagram handler for this chat
        const unsubscribeDiagram = IpcClient.getInstance().onWorkspaceDiagram(
          chatId,
          (payload) => {
            // Set diagram state from workspace context
            setDiagramState({
              code: payload.mermaidCode || '',
              type: payload.type === 'class' ? 'class' :
                payload.type === 'sequence' ? 'sequence' :
                  payload.type === 'flowchart' ? 'flowchart' : 'mermaid',
              compareMode: 'current',
              title: payload.title,
            });
            maybeAutoOpenRightPanel(); // Show panel for diagram unless user dismissed it
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
        };

        const intentMode =
          settings?.intentMode ??
          (settings?.selectedChatMode === "agent"
            ? "build"
            : settings?.selectedChatMode) ??
          "build";
        const intentIsAuto = intentMode === "auto";
        const wm = (settings?.workModePreference ??
          (settings?.selectedChatMode === "ask" ? "ask" : "build")) as WorkMode;
        const fromWorkMode = !intentIsAuto
          ? blueprintTierForWorkMode(wm)
          : undefined;
        const bpPref = settings?.blueprintInjectionModePreference ?? "auto";
        const fromSettingsTier =
          bpPref !== "auto"
            ? (bpPref as "ask" | "plan" | "build" | "debug")
            : undefined;
        const streamBlueprintMode =
          blueprintChatTierOverride ?? fromWorkMode ?? fromSettingsTier;
        const streamBlueprintTrace = settings?.blueprintDebugTrace?.trim();
        const streamBlueprintFile = settings?.blueprintDebugFile?.trim();

        IpcClient.getInstance().streamMessage(prompt, {
          selectedComponents: selectedComponents ?? [],
          chatId,
          redo,
          attachments,
          modelOverride,
          appId: selectedAppId ?? undefined,
          continueAfterQuestions,
          blueprintInjectionMode: streamBlueprintMode,
          blueprintDebugTrace: streamBlueprintTrace || undefined,
          blueprintDebugFile: streamBlueprintFile || undefined,
          onUpdate: (updatedMessages: Message[]) => {
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

            for (const msg of updatedMessages) {
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

            // Detect diagram results from tool calls
            for (const msg of updatedMessages) {
              if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
                for (const toolCall of msg.toolCalls) {
                  const tc = toolCall as any;
                  // Check if this is a diagram tool result
                  if (tc.result && (tc.result.mermaid_code || tc.result._panelType === 'diagram')) {
                    const diagramData = tc.result;
                    setDiagramState({
                      code: diagramData.mermaid_code || '',
                      type: diagramData.diagram_type === 'class' ? 'class' :
                        diagramData.diagram_type === 'sequence' ? 'sequence' :
                          diagramData.diagram_type === 'flowchart' ? 'flowchart' : 'mermaid',
                      compareMode: 'current',
                      title: diagramData.title,
                    });
                    maybeAutoOpenRightPanel(); // Show panel for diagram
                  }
                }
              }
            }

            setMessagesById((prev) => {
              const next = new Map(prev);
              next.set(chatId, updatedMessages);
              return next;
            });
          },
          onEnd: (response: ChatResponseEnd) => {
            cleanupStreamListeners?.();
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

            // v3.5: Clear persistent tool indicator when stream ends
            setToolIndicator({
              active: false,
              toolName: null,
              count: 0,
              activeChatId: null,
              liveOutputLines: [],
              liveErrorLines: [],
              liveProgressLines: [],
              liveViewMode: "error_first",
              phaseLabel: null,
            });
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

            // v3.9: Clear "conversation restarted from here" divider when stream ends
            setRestartedAfterMessageId(null);

            onSettled?.();
          },
          onError: (errorMessage: string) => {
            cleanupStreamListeners?.();
            console.error(`[CHAT] Stream error for ${chatId}:`, errorMessage);
            if (errorMessage.includes(ATLARIX_AUTH_REQUIRED_PREFIX)) {
              posthog?.capture("auth:chat_stream_blocked", { chat_id: chatId });
              Sentry.captureMessage("Chat stream blocked — not signed in", {
                level: "info",
                tags: { feature: "auth" },
                extra: { chatId },
              });
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
            setToolIndicator({
              active: false,
              toolName: null,
              count: 0,
              activeChatId: null,
              liveOutputLines: [],
              liveErrorLines: [],
              liveProgressLines: [],
              liveViewMode: "error_first",
              phaseLabel: null,
            });
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
        setToolIndicator({
          active: false,
          toolName: null,
          count: 0,
          activeChatId: null,
          liveOutputLines: [],
          liveErrorLines: [],
          liveProgressLines: [],
          liveViewMode: "error_first",
          phaseLabel: null,
        });
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
      setQuestionsByMessageId,
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
      blueprintChatTierOverride,
      posthog,
      hasChatId,
    ],
  );

  // v3.9: Update questionsByMessageIdAtom when main process emits chat:questions
  useEffect(() => {
    const unsub = IpcClient.getInstance().onQuestions(({ messageId, questions }) => {
      setQuestionsByMessageId((prev) => ({ ...prev, [messageId]: questions }));
    });
    return unsub;
  }, [setQuestionsByMessageId]);

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
