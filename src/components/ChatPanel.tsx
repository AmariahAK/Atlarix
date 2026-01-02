import { useState, useRef, useEffect, useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  chatMessagesByIdAtom,
  chatStreamCountByIdAtom,
  isStreamingByIdAtom,
} from "../atoms/chatAtoms";
import { terminalOutputsAtom } from "../atoms/sourceAtoms";
import { IpcClient } from "@/ipc/ipc_client";

import { ChatHeader } from "./chat/ChatHeader";
import { MessagesList } from "./chat/MessagesList";
import { ChatInput } from "./chat/ChatInput";
import { VersionPane } from "./chat/VersionPane";
import { ChatError } from "./chat/ChatError";
import { CommandOutputCard } from "./CommandOutputCard";
import { Button } from "@/components/ui/button";
import { ArrowDown } from "lucide-react";

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

  // Terminal output listener - tracks running commands
  // Note: Terminal events are handled in useStreamChat which updates terminalOutputsAtom
  const terminalOutputs = useAtomValue(terminalOutputsAtom);
  const runningCommands = Array.from(terminalOutputs.values())
    .filter(t => t.status === 'running');

  // Reference to store the processed prompt so we don't submit it twice

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);

  // Scroll-related properties
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const userScrollTimeoutRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef<number>(0);
  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  const handleScrollButtonClick = () => {
    if (!messagesContainerRef.current) return;

    scrollToBottom("smooth");
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

  const scrollAwayThreshold = 150; // pixels from bottom to consider "scrolled away"

  const handleScroll = useCallback(() => {
    if (!messagesContainerRef.current) return;

    const container = messagesContainerRef.current;
    const distanceFromBottom =
      container.scrollHeight - (container.scrollTop + container.clientHeight);

    // User has scrolled away from bottom
    if (distanceFromBottom > scrollAwayThreshold) {
      setIsUserScrolling(true);
      setShowScrollButton(true);

      if (userScrollTimeoutRef.current) {
        window.clearTimeout(userScrollTimeoutRef.current);
      }

      userScrollTimeoutRef.current = window.setTimeout(() => {
        setIsUserScrolling(false);
      }, 2000); // Increased timeout to 2 seconds
    } else {
      // User is near bottom
      setIsUserScrolling(false);
      setShowScrollButton(false);
    }
    lastScrollTopRef.current = container.scrollTop;
  }, []);

  // Track if we're in an active streaming session (to differentiate from initial load)
  const wasStreamingRef = useRef(false);

  useEffect(() => {
    const streamCount = chatId ? (streamCountById.get(chatId) ?? 0) : 0;
    const currentlyStreaming = chatId ? (isStreamingById.get(chatId) ?? false) : false;

    // Only auto-scroll when:
    // 1. We're actively streaming (not just loading a chat)
    // 2. Stream count > 1 (skip first chunk so user sees their message first)
    // 3. User hasn't scrolled away
    if (currentlyStreaming && streamCount > 1 && !isUserScrolling) {
      console.log("[ChatPanel] Streaming detected, scrolling to bottom");
      requestAnimationFrame(() => {
        scrollToBottom("smooth");
      });
    }

    // Track streaming state for next render
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
    if (!chatId) {
      // no-op when no chat
      return;
    }
    const chat = await IpcClient.getInstance().getChat(chatId);
    setMessagesById((prev) => {
      const next = new Map(prev);
      next.set(chatId, chat.messages);
      return next;
    });
  }, [chatId, setMessagesById]);

  useEffect(() => {
    fetchChatMessages();
  }, [fetchChatMessages]);

  const messages = chatId ? (messagesById.get(chatId) ?? []) : [];
  const isStreaming = chatId ? (isStreamingById.get(chatId) ?? false) : false;

  // Auto-scroll effect when messages change during streaming
  useEffect(() => {
    if (
      !isUserScrolling &&
      isStreaming &&
      messagesContainerRef.current &&
      messages.length > 0
    ) {
      // Only auto-scroll if user is close to bottom
      if (isNearBottom(280)) {
        requestAnimationFrame(() => {
          scrollToBottom("instant");
        });
      }
    }
  }, [messages, isUserScrolling, isStreaming]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <ChatHeader
        isVersionPaneOpen={isVersionPaneOpen}
        isPreviewOpen={isPreviewOpen}
        onTogglePreview={onTogglePreview}
        onVersionClick={() => setIsVersionPaneOpen(!isVersionPaneOpen)}
      />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {!isVersionPaneOpen && (
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <div className="flex-1 relative min-h-0 overflow-hidden">
              <MessagesList
                messages={messages}
                messagesEndRef={messagesEndRef}
                ref={messagesContainerRef}
              />

              {/* Scroll to bottom button */}
              {showScrollButton && (
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10">
                  <Button
                    onClick={handleScrollButtonClick}
                    size="icon"
                    className="rounded-full shadow-lg hover:shadow-xl transition-all border border-border/50 backdrop-blur-sm bg-background/95 hover:bg-accent"
                    variant="outline"
                    title={"Scroll to bottom"}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>

            <ChatError error={error} onDismiss={() => setError(null)} />

            {/* Running commands - show spinner cards above input */}
            {runningCommands.length > 0 && (
              <div className="px-4 pb-2 space-y-2">
                {runningCommands.map(cmd => (
                  <CommandOutputCard
                    key={cmd.operationId}
                    command={cmd.command}
                    status={cmd.status === 'completed' ? 'success' : cmd.status}
                    output={cmd.output}
                    exitCode={cmd.exitCode}
                    duration={cmd.duration}
                  />
                ))}
              </div>
            )}

            {/* flex-shrink-0 ensures input controls are never clipped */}
            <div className="flex-shrink-0">
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
