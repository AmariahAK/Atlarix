/**
 * Virtualized chat history (the "complete frontend" capstone).
 *
 * Completed messages render through react-virtuoso so a long session keeps a
 * bounded DOM and cheap reconcile. `followOutput` pins the view to the bottom
 * while you are there and lets Virtuoso absorb the growing last item — the exact
 * dynamic-height case that broke the earlier hand-rolled virtualizer (Virtuoso
 * is built for it). Footer extras (stream status, ask_user card, background
 * jobs) render via a STABLE module-level component fed through Virtuoso
 * `context`, so they never remount on a stream flush.
 *
 * Gated behind SimpleInlineChat's USE_VIRTUALIZED_CHAT kill-switch; when off,
 * SimpleInlineChat renders its original render-all list unchanged.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ArrowDown } from "lucide-react";
import type { Message } from "@/ipc/ipc_types";
import { splitPeerMessages } from "@/lib/peers/peer-message";
import { SimpleMessage } from "./SimpleMessage";
import { InlineStreamStatus } from "./chat/InlineStreamStatus";
import { InlineUserQuestions } from "./chat/InlineUserQuestions";
import { BackgroundJobsIndicator } from "./chat/BackgroundJobsIndicator";
import { SessionRecap } from "./chat/SessionRecap";

/** How close to the bottom counts as "at the bottom" (Virtuoso and the footer pin). */
const AT_BOTTOM_PX = 64;

interface FooterContext {
  chatId: number;
  isStreaming: boolean;
  lastMessageRole: string | undefined;
  footerRef: (el: HTMLDivElement | null) => void;
}

/** Stable footer — identity never changes, so it doesn't remount per flush. */
function ListFooter({ context }: { context?: FooterContext }) {
  if (!context) return null;
  const { chatId, isStreaming, lastMessageRole, footerRef } = context;
  return (
    <div ref={footerRef} className="px-4 pb-4 space-y-4">
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

  // A turn that opens with thoughts and tool calls streams in the FOOTER until
  // its first reply text creates the assistant row. Virtuoso follows a growing
  // item but not a growing footer, so the view stopped following with nobody
  // scrolling (W13). When the footer grows, stay at the bottom if the view was
  // there before the growth; a reader scrolled up is left where they are.
  const scrollerRef = useRef<HTMLElement | null>(null);
  const footerObserverRef = useRef<ResizeObserver | null>(null);
  const footerRef = useCallback((el: HTMLDivElement | null) => {
    footerObserverRef.current?.disconnect();
    footerObserverRef.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastHeight = el.offsetHeight;
    const observer = new ResizeObserver(() => {
      const height = el.offsetHeight;
      const grew = height - lastHeight;
      lastHeight = height;
      const scroller = scrollerRef.current;
      if (!scroller || grew <= 0) return;
      const distanceBefore =
        scroller.scrollHeight -
        grew -
        scroller.scrollTop -
        scroller.clientHeight;
      if (distanceBefore <= AT_BOTTOM_PX)
        scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(el);
    footerObserverRef.current = observer;
  }, []);

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

  // Sending takes you to the end of the conversation, even when you had
  // scrolled up to read (QA #9: the new turn ran off-screen behind "Jump to
  // latest"). A teammate's message arriving does not move you.
  const lastOwnMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user" && !splitPeerMessages(msg.content ?? "")) {
        return msg.id;
      }
    }
    return undefined;
  }, [messages]);
  const prevOwnMessageIdRef = useRef(lastOwnMessageId);
  useEffect(() => {
    const prev = prevOwnMessageIdRef.current;
    prevOwnMessageIdRef.current = lastOwnMessageId;
    if (prev === undefined || lastOwnMessageId === prev) return;
    const raf = requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
    });
    return () => cancelAnimationFrame(raf);
  }, [lastOwnMessageId]);

  const lastIndex = messages.length - 1;
  const lastMessage = lastIndex >= 0 ? messages[lastIndex] : undefined;

  const footerContext: FooterContext = {
    chatId,
    isStreaming,
    lastMessageRole: lastMessage?.role,
    footerRef,
  };

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <Virtuoso<Message, FooterContext>
        ref={virtuosoRef}
        className="flex-1 min-h-0 overscroll-contain"
        data={messages}
        context={footerContext}
        initialTopMostItemIndex={Math.max(0, lastIndex)}
        // Follow the bottom as content grows, while you are at the bottom; stay
        // put while you are scrolled up to read. Not gated on streaming: a wake
        // turn's peer row lands before the stream starts, and a missed follow
        // there left the whole turn below the fold.
        followOutput={(isAtBottom) => (isAtBottom ? "auto" : false)}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={AT_BOTTOM_PX}
        scrollerRef={(el) => {
          scrollerRef.current = el instanceof HTMLElement ? el : null;
        }}
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
