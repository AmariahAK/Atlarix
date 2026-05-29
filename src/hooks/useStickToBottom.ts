import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

const DEFAULT_THRESHOLD_PX = 80;

export function useStickToBottom(
  containerRef: RefObject<HTMLElement | null>,
  endRef?: RefObject<HTMLElement | null>,
  thresholdPx = DEFAULT_THRESHOLD_PX,
) {
  const stickRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const scrollRafRef = useRef<number | null>(null);
  const isProgrammaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<number | null>(null);

  const distanceFromBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return 0;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }, [containerRef]);

  const syncStickState = useCallback(() => {
    const dist = distanceFromBottom();
    const atBottom = dist <= thresholdPx;
    stickRef.current = atBottom;
    setShowJumpButton(!atBottom);
  }, [distanceFromBottom, thresholdPx]);

  const onScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;
    syncStickState();
  }, [syncStickState]);

  const clearProgrammaticScroll = useCallback(() => {
    isProgrammaticScrollRef.current = false;
    if (programmaticScrollTimerRef.current != null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
      programmaticScrollTimerRef.current = null;
    }
    syncStickState();
  }, [syncStickState]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const el = containerRef.current;
      if (!el) return;

      isProgrammaticScrollRef.current = true;
      if (programmaticScrollTimerRef.current != null) {
        window.clearTimeout(programmaticScrollTimerRef.current);
      }

      const endEl = endRef?.current;
      if (endEl) {
        endEl.scrollIntoView({ behavior, block: "end" });
      } else {
        el.scrollTo({ top: el.scrollHeight, behavior });
      }

      stickRef.current = true;
      setShowJumpButton(false);

      const container = el;
      const onScrollEnd = () => {
        container.removeEventListener("scrollend", onScrollEnd);
        clearProgrammaticScroll();
      };
      if ("onscrollend" in container) {
        container.addEventListener("scrollend", onScrollEnd, { once: true });
      }
      programmaticScrollTimerRef.current = window.setTimeout(
        clearProgrammaticScroll,
        behavior === "smooth" ? 600 : 50,
      );
    },
    [containerRef, endRef, clearProgrammaticScroll],
  );

  const maybeScrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (!stickRef.current) return;
      if (scrollRafRef.current != null) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        if (stickRef.current) scrollToBottom(behavior);
      });
    },
    [scrollToBottom],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let lastScrollHeight = container.scrollHeight;
    let debounceTimer: number | null = null;

    const onContentChange = () => {
      const el = containerRef.current;
      if (!el) return;

      if (el.scrollHeight !== lastScrollHeight) {
        lastScrollHeight = el.scrollHeight;
        if (stickRef.current) {
          maybeScrollToBottom("auto");
        } else {
          syncStickState();
        }
      }
    };

    const scheduleContentCheck = () => {
      if (debounceTimer != null) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(onContentChange, 16);
    };

    const mutationObserver = new MutationObserver(scheduleContentCheck);
    mutationObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });

    const resizeObserver = new ResizeObserver(scheduleContentCheck);
    resizeObserver.observe(container);

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      if (debounceTimer != null) window.clearTimeout(debounceTimer);
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
      if (programmaticScrollTimerRef.current != null) {
        window.clearTimeout(programmaticScrollTimerRef.current);
      }
    };
  }, [containerRef, maybeScrollToBottom, syncStickState]);

  return {
    stickRef,
    onScroll,
    scrollToBottom,
    maybeScrollToBottom,
    showJumpButton,
  };
}

/** Scroll-to-bottom when streaming deps change (messages, activity, etc.). */
export function useStreamingScrollToBottom(
  opts: {
    isStreaming: boolean;
    scrollToBottom: (behavior?: ScrollBehavior) => void;
    maybeScrollToBottom: (behavior?: ScrollBehavior) => void;
    streamActivityAt?: number;
    streamThreadLen?: number;
    activityCount?: number;
    messagesLength?: number;
  },
) {
  const wasStreamingRef = useRef(false);

  useEffect(() => {
    if (opts.isStreaming && !wasStreamingRef.current) {
      opts.scrollToBottom("auto");
    }
    wasStreamingRef.current = opts.isStreaming;
  }, [opts.isStreaming, opts.scrollToBottom]);

  useEffect(() => {
    opts.maybeScrollToBottom("auto");
  }, [
    opts.streamActivityAt,
    opts.streamThreadLen,
    opts.activityCount,
    opts.messagesLength,
    opts.maybeScrollToBottom,
  ]);
}
