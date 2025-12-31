import { useCallback } from "react";
import type {
  ComponentSelection,
  Message,
  FileAttachment,
} from "@/ipc/ipc_types";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  chatErrorByIdAtom,
  chatMessagesByIdAtom,
  chatStreamCountByIdAtom,
  isStreamingByIdAtom,
  recentStreamChatIdsAtom,
} from "@/atoms/chatAtoms";
import {
  sourceListAtom,
  rightPanelVisibleAtom,
  pendingProposalsAtom,
  diagramStateAtom,
  previewTabAtom,
  terminalOutputAtom,
  type SourceItem,
  type FileProposal,
  type DiagramState,
} from "@/atoms/sourceAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { isPreviewOpenAtom } from "@/atoms/viewAtoms";
import type { ChatResponseEnd } from "@/ipc/ipc_types";
import { useChats } from "./useChats";
import { useLoadApp } from "./useLoadApp";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { useVersions } from "./useVersions";
import { showExtraFilesToast } from "@/lib/toast";
import { useProposal } from "./useProposal";
import { useSearch } from "@tanstack/react-router";
import { useRunApp } from "./useRunApp";
import { useCountTokens } from "./useCountTokens";
import { useUserBudgetInfo } from "./useUserBudgetInfo";
import { usePostHog } from "posthog-js/react";
import { useCheckProblems } from "./useCheckProblems";
import { useSettings } from "./useSettings";
import { playNotify, playRemaining } from "@/lib/sounds";

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
  const markdownMatch = snippet.match(/\[([^\]]+)\]\((https?:\/\/([^\/\)]+))/);
  if (markdownMatch && markdownMatch[3]) {
    return markdownMatch[3].replace('www.', '');
  }

  // Try bare URL in content
  const urlMatch = snippet.match(/https?:\/\/([^\/\s\)]+)/);
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
  const setRecentStreamChatIds = useSetAtom(recentStreamChatIdsAtom);
  const setSourceList = useSetAtom(sourceListAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const setPendingProposals = useSetAtom(pendingProposalsAtom);
  const setDiagramState = useSetAtom(diagramStateAtom);
  const setPreviewTab = useSetAtom(previewTabAtom);
  const setTerminalOutput = useSetAtom(terminalOutputAtom);
  const posthog = usePostHog();
  let chatId: number | undefined;

  if (hasChatId) {
    const { id } = useSearch({ from: "/chat" });
    chatId = id;
  }
  let { refreshProposal } = hasChatId ? useProposal(chatId) : useProposal();
  const { invalidateTokenCount } = useCountTokens(chatId ?? null, "");

  const streamMessage = useCallback(
    async ({
      prompt,
      chatId,
      redo,
      attachments,
      selectedComponents,
      onSettled,
    }: {
      prompt: string;
      chatId: number;
      redo?: boolean;
      attachments?: FileAttachment[];
      selectedComponents?: ComponentSelection[];
      onSettled?: () => void;
    }) => {
      if (
        (!prompt.trim() && (!attachments || attachments.length === 0)) ||
        !chatId
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

      let hasIncrementedStreamCount = false;
      try {
        // Register permission handler for this chat
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

            // Add to pending proposals
            setPendingProposals((prev) => {
              const newProposals = [...prev, ...allProposals];

              // If we had proposals before and got more, play sound to alert user
              if (prev.length > 0 && allProposals.length > 0) {
                playRemaining();
              }

              return newProposals;
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
            setRightPanelVisible(true); // Show panel for diagram
          }
        );

        // Register terminal output handler for this chat
        const unsubscribeTerminal = IpcClient.getInstance().onTerminalOutput(
          chatId,
          (payload) => {
            // Update terminal output atom for right panel display
            setTerminalOutput({
              commandId: payload.commandId,
              command: payload.command,
              output: payload.output ? [payload.output] : [],
              status: payload.status,
              exitCode: payload.exitCode,
            });
            // Show terminal panel when commands are running
            if (payload.status === 'running') {
              setRightPanelVisible(true);
              setPreviewTab('terminal');
            }
          }
        );

        IpcClient.getInstance().streamMessage(prompt, {
          selectedComponents: selectedComponents ?? [],
          chatId,
          redo,
          attachments,
          onUpdate: (updatedMessages: Message[]) => {
            if (!hasIncrementedStreamCount) {
              setStreamCountById((prev) => {
                const next = new Map(prev);
                next.set(chatId, (prev.get(chatId) ?? 0) + 1);
                return next;
              });
              hasIncrementedStreamCount = true;
            }

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
              setRightPanelVisible(true); // Auto-show panel when sources arrive
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
                    setRightPanelVisible(true); // Show panel for diagram
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

            // Play notification sound when AI response completes
            playNotify();

            onSettled?.();
          },
          onError: (errorMessage: string) => {
            console.error(`[CHAT] Stream error for ${chatId}:`, errorMessage);
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
      setIsStreamingById,
      setIsPreviewOpen,
      checkProblems,
      selectedAppId,
      refetchUserBudget,
      settings,
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
