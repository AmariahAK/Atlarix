import { useState, useRef, useEffect, useCallback } from "react";
import { useAtomValue, useSetAtom, getDefaultStore } from "jotai";
import {
  chatMessagesByIdAtom,
  chatStreamCountByIdAtom,
  isStreamingByIdAtom,
} from "../atoms/chatAtoms";
import { terminalOutputsAtom } from "../atoms/sourceAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { useStreamChat } from "@/hooks/useStreamChat";
import { ToolIndicator } from "./chat/ToolIndicator";

import { ChatHeader } from "./chat/ChatHeader";
import { MessagesList } from "./chat/MessagesList";
import { ChatInput } from "./chat/ChatInput";
import { VersionPane } from "./chat/VersionPane";
import { ChatError } from "./chat/ChatError";
import { CommandOutputCard } from "./CommandOutputCard";
import { IterationProgressBar } from "./IterationProgressBar";
import { CompassQuotaInlineBanner } from "./chat/CompassQuotaInlineBanner";
import { CompassUsageStrip } from "./chat/CompassUsageStrip";
import { LoadedSessionBanner } from "./chat/LoadedSessionBanner";
import { SessionLoadingOverlay } from "./chat/SessionLoadingOverlay";
import { useCompassSendGate } from "@/hooks/useCompassSendGate";
import { formatCompassSubscriptionTier } from "@/shared/compass_product_copy";
import { Button } from "@/components/ui/button";
import { ArrowDown } from "lucide-react";

function ChatCompassMonthlyFooter() {
  const {
    usesCompass,
    tier,
    percentRemaining,
    monthlyLimit,
    tokensUsedThisMonth,
    loading,
  } = useCompassSendGate(null);
  if (!usesCompass || monthlyLimit == null || monthlyLimit <= 0) return null;
  return (
    <div className="shrink-0 border-t border-border/40 bg-muted/5">
      <CompassUsageStrip
        subscriptionTierLabel={formatCompassSubscriptionTier(tier)}
        tokensUsedThisMonth={tokensUsedThisMonth}
        monthlyLimit={monthlyLimit}
        percentRemaining={percentRemaining}
        loading={loading}
      />
    </div>
  );
}

interface ChatPanelProps {
  chatId?: number;
  isPreviewOpen: boolean;
  onTogglePreview: () => void;
}

export function ChatPanel({
  chatId,
  isPreviewOpen,
  onTogglePreview,
}: ChatPanelProps) {
  const messagesById = useAtomValue(chatMessagesByIdAtom);
  const setMessagesById = useSetAtom(chatMessagesByIdAtom);
  const [isVersionPaneOpen, setIsVersionPaneOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamCountById = useAtomValue(chatStreamCountByIdAtom);
  const isStreamingById = useAtomValue(isStreamingByIdAtom);
  const setTerminalOutputs = useSetAtom(terminalOutputsAtom);

  const { streamMessage } = useStreamChat();

  const terminalOutputs = useAtomValue(terminalOutputsAtom);
  const activeCommands = Array.from(terminalOutputs.values()).filter(
    (t) => t.status === "running" || t.status === "error",
  );

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);

  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const userScrollTimeoutRef = useRef<number | null>(null);
  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  const getDistanceFromBottom = () => {
    if (!messagesContainerRef.current) return 0;
    const container = messagesContainerRef.current;
    return (
      container.scrollHeight - (container.scrollTop + container.clientHeight)
    );
  };

  const isNearBottom = (threshold: number = 100) => {
    return getDistanceFromBottom() <= threshold;
  };

  const scrollAwayThreshold = 150;

  const handleScroll = useCallback(() => {
    if (!messagesContainerRef.current) return;

    const container = messagesContainerRef.current;
    const distanceFromBottom =
      container.scrollHeight - (container.scrollTop + container.clientHeight);

    if (distanceFromBottom > scrollAwayThreshold) {
      setIsUserScrolling(true);
      setShowScrollButton(true);

      if (userScrollTimeoutRef.current) {
        window.clearTimeout(userScrollTimeoutRef.current);
      }

      userScrollTimeoutRef.current = window.setTimeout(() => {
        setIsUserScrolling(false);
      }, 2000);
    } else {
      setIsUserScrolling(false);
      setShowScrollButton(false);
    }
  }, []);

  const wasStreamingRef = useRef(false);

  useEffect(() => {
    const streamCount = chatId ? (streamCountById.get(chatId) ?? 0) : 0;
    const currentlyStreaming = chatId
      ? (isStreamingById.get(chatId) ?? false)
      : false;

    if (currentlyStreaming && streamCount > 1 && !isUserScrolling) {
      requestAnimationFrame(() => {
        scrollToBottom("smooth");
      });
    }

    wasStreamingRef.current = currentlyStreaming;
  }, [
    chatId,
    chatId ? (streamCountById.get(chatId) ?? 0) : 0,
    chatId ? (isStreamingById.get(chatId) ?? false) : false,
    isUserScrolling,
  ]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (container) {
      container.addEventListener("scroll", handleScroll, { passive: true });
    }

    return () => {
      if (container) {
        container.removeEventListener("scroll", handleScroll);
      }
      if (userScrollTimeoutRef.current) {
        window.clearTimeout(userScrollTimeoutRef.current);
      }
    };
  }, [handleScroll]);

  const fetchChatMessages = useCallback(async () => {
    if (!chatId) return;
    const existing = getDefaultStore().get(chatMessagesByIdAtom).get(chatId);
    if (existing && existing.length > 0) {
      const { replaceDisplayHydrationForChat } = await import(
        "@/lib/chat/apply-stream-display-hydration"
      );
      replaceDisplayHydrationForChat(chatId, existing);
      return;
    }
    const chat = await IpcClient.getInstance().getChat(chatId);
    setMessagesById((prev) => {
      const next = new Map(prev);
      next.set(chatId, chat.messages);
      return next;
    });
    const { applyStreamDisplayHydration } = await import(
      "@/lib/chat/apply-stream-display-hydration"
    );
    applyStreamDisplayHydration(chat.messages);
  }, [chatId, setMessagesById]);

  useEffect(() => {
    fetchChatMessages();
  }, [fetchChatMessages]);

  const messages = chatId ? (messagesById.get(chatId) ?? []) : [];
  const isStreaming = chatId ? (isStreamingById.get(chatId) ?? false) : false;

  useEffect(() => {
    if (
      !isUserScrolling &&
      isStreaming &&
      messagesContainerRef.current &&
      messages.length > 0
    ) {
      if (isNearBottom(280)) {
        requestAnimationFrame(() => {
          scrollToBottom("auto");
        });
      }
    }
  }, [messages, isUserScrolling, isStreaming]);

  const handleFixWithAI = useCallback(
    (cmd: { command: string; output?: string }) => {
      if (!chatId) return;
      const fixPrompt = `The previous command failed:\n\`\`\`\n${cmd.command}\n\`\`\`\n\nError output:\n\`\`\`\n${cmd.output || "No output"}\n\`\`\`\n\nPlease analyze this error and suggest a fix.`;
      streamMessage({ chatId, prompt: fixPrompt });
    },
    [chatId, streamMessage],
  );

  const handleRetry = useCallback(
    async (_operationId: string, command: string) => {
      if (!chatId) return;
      const retryPrompt = `Please run this command again:\n\`\`\`bash\n${command}\n\`\`\``;
      streamMessage({ chatId, prompt: retryPrompt });
    },
    [chatId, streamMessage],
  );

  const handleIgnore = useCallback(
    (operationId: string) => {
      setTerminalOutputs((prev) => {
        const next = new Map(prev);
        next.delete(operationId);
        return next;
      });
    },
    [setTerminalOutputs],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <ChatHeader
        isVersionPaneOpen={isVersionPaneOpen}
        isPreviewOpen={isPreviewOpen}
        onTogglePreview={onTogglePreview}
        onVersionClick={() => setIsVersionPaneOpen(!isVersionPaneOpen)}
      />
      <CompassQuotaInlineBanner />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {!isVersionPaneOpen && (
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <IterationProgressBar chatId={chatId ?? -999} />
            <LoadedSessionBanner />
            <div className="flex-1 relative min-h-0 overflow-hidden">
              <SessionLoadingOverlay />
              <MessagesList
                messages={messages}
                messagesEndRef={messagesEndRef}
                ref={messagesContainerRef}
              />
              {showScrollButton && (
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10">
                  <Button
                    onClick={() => scrollToBottom("smooth")}
                    size="icon"
                    className="rounded-full shadow-lg hover:shadow-xl transition-all border border-border/50 backdrop-blur-sm bg-background/95 hover:bg-accent"
                    variant="outline"
                    title="Scroll to bottom"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
            <ChatError error={error} onDismiss={() => setError(null)} />
            {activeCommands.length > 0 && (
              <div className="px-4 pb-2 space-y-2">
                {activeCommands.map((cmd) => (
                  <CommandOutputCard
                    key={cmd.operationId}
                    command={cmd.command}
                    status={
                      cmd.status === "completed" ? "success" : cmd.status
                    }
                    output={cmd.output}
                    exitCode={cmd.exitCode}
                    duration={cmd.duration}
                    onFixWithAI={
                      cmd.status === "error"
                        ? () => handleFixWithAI(cmd)
                        : undefined
                    }
                    onRetry={
                      cmd.status === "error"
                        ? () => handleRetry(cmd.operationId, cmd.command)
                        : undefined
                    }
                    onIgnore={
                      cmd.status === "error"
                        ? () => handleIgnore(cmd.operationId)
                        : undefined
                    }
                  />
                ))}
              </div>
            )}
            <ChatCompassMonthlyFooter />
            <div className="flex-shrink-0">
              {chatId != null ? <ToolIndicator forChatId={chatId} /> : null}
              <ChatInput chatId={chatId} />
            </div>
          </div>
        )}
        <VersionPane
          isVisible={isVersionPaneOpen}
          onClose={() => setIsVersionPaneOpen(false)}
        />
      </div>
    </div>
  );
}