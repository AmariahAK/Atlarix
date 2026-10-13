/**
 * Virtualized chat history (the "complete frontend" capstone).
 *
 * Completed messages render through react-virtuoso so a long session keeps a
 * bounded DOM and cheap reconcile. `followOutput` pins the view to the bottom
 * during streaming and lets Virtuoso absorb the growing last item — the exact
 * dynamic-height case that broke the earlier hand-rolled virtualizer (Virtuoso
 * is built for it). Footer extras (stream status, ask_user card, background
 * jobs) render via a STABLE module-level component fed through Virtuoso
 * `context`, so they never remount on a stream flush.
 *
 * Gated behind SimpleInlineChat's USE_VIRTUALIZED_CHAT kill-switch; when off,
 * SimpleInlineChat renders its original render-all list unchanged.
 */
import { useEffect, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ArrowDown } from "lucide-react";
import type { Message } from "@/ipc/ipc_types";
import { SimpleMessage } from "./SimpleMessage";
import { InlineStreamStatus } from "./chat/InlineStreamStatus";
import { InlineUserQuestions } from "./chat/InlineUserQuestions";
import { BackgroundJobsIndicator } from "./chat/BackgroundJobsIndicator";
import { SessionRecap } from "./chat/SessionRecap";

interface FooterContext {
  chatId: number;
  isStreaming: boolean;
  lastMessageRole: string | undefined;
}

/** Stable footer — identity never changes, so it doesn't remount per flush. */
function ListFooter({ context }: { context?: FooterContext }) {
  if (!context) return null;
  const { chatId, isStreaming, lastMessageRole } = context;
  return (
    <div className="px-4 pb-4 space-y-4">
      {isStreaming && lastMessageRole === "user" && (
        <div className="flex justify-start">
          <div className="bg-muted rounded-lg px-4 py-2">
            <InlineStreamStatus chatId={chatId} active />
          </div>
        </div>
      )}
      <InlineUserQuestions chatId={chatId} />
      <BackgroundJobsIndicator chatId={chatId} />
      <SessionRecap chatId={chatId} />
    </div>
  );
}

export function VirtualizedMessageList({
  messages,
  chatId,
  workspaceAppId,
  isStreaming,
  lastAssistantIndex,
  onEditUserMessage,
  onContinue,
  onPlanArtifactBuild,
  planArtifactBuildDisabled,
}: {
  messages: Message[];
  chatId: number;
  workspaceAppId: number | null | undefined;
  isStreaming: boolean;
  lastAssistantIndex: number;
  onEditUserMessage: (messageId: number, newContent: string) => Promise<void>;
  onContinue: (message: Message) => void;
  onPlanArtifactBuild?: (planId: string) => void;
  planArtifactBuildDisabled?: boolean;
}) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  // When streaming ends while the user is at the bottom, `followOutput` switches
  // off in the same commit that the final message re-renders at a different
  // height — so Virtuoso stops holding the bottom and the view drifts up to a
  // stale position. Re-pin to the last item's end explicitly (next frame, after
  // the final layout settles) so "at the bottom when it finishes" stays there.
  const wasStreamingRef = useRef(isStreaming);
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming && atBottom) {
      const raf = requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
      });
      wasStreamingRef.current = isStreaming;
      return () => cancelAnimationFrame(raf);
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, atBottom]);

  const lastIndex = messages.length - 1;
  const lastMessage = lastIndex >= 0 ? messages[lastIndex] : undefined;

  const footerContext: FooterContext = {
    chatId,
    isStreaming,
    lastMessageRole: lastMessage?.role,
  };

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <Virtuoso<Message, FooterContext>
        ref={virtuosoRef}
        className="flex-1 min-h-0 overscroll-contain"
        data={messages}
        context={footerContext}
        initialTopMostItemIndex={Math.max(0, lastIndex)}
        // Follow the bottom as content grows — Virtuoso suppresses this while the
        // user is scrolled up, so reading history isn't yanked.
        followOutput={isStreaming ? "auto" : false}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={64}
        increaseViewportBy={{ top: 600, bottom: 900 }}
        components={{ Footer: ListFooter }}
        itemContent={(index, message) => (
          <div className="px-4 py-2">
            <SimpleMessage
              message={message}
              chatId={chatId}
              workspaceAppId={workspaceAppId}
              isStreaming={
                isStreaming &&
                index === lastIndex &&
                message.role === "assistant"
              }
              isLatestAssistant={index === lastAssistantIndex}
              onEditUserMessage={onEditUserMessage}
              onContinue={onContinue}
              onPlanArtifactBuild={onPlanArtifactBuild}
              planArtifactBuildDisabled={planArtifactBuildDisabled}
            />
          </div>
        )}
      />

      {!atBottom && (
        <button
          type="button"
          onClick={() =>
            virtuosoRef.current?.scrollToIndex({
              index: "LAST",
              // Pin the BOTTOM of the last item to the viewport bottom — during
              // streaming the assistant message is taller than the viewport, so the
              // default top-align would land mid-message (above the generating edge).
              align: "end",
              behavior: "smooth",
            })
          }
          aria-label="Jump to latest"
          className="absolute bottom-3 right-4 z-10 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground bg-background/95 backdrop-blur-sm border border-border/60 rounded-full shadow-md hover:bg-accent transition-colors"
        >
          <ArrowDown size={14} />
          <span>Jump to latest</span>
        </button>
      )}
    </div>
  );
}
