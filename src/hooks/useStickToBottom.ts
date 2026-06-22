import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Stick-to-bottom scroll behaviour for streaming chat lists (parity with
 * Claude Code / Cursor / opencode):
 *
 * - Auto-follow the bottom ONLY while the user is already at/near the bottom.
 * - The moment the user scrolls up, stop force-scrolling so they can read/scroll
 *   freely without the viewport bouncing back down.
 * - Surface a "Jump to latest" affordance (`showJumpButton`) while scrolled up.
 *
 * The caller drives `onContentChange()` whenever the rendered content grows
 * (new tokens, tool cards, etc.). It only scrolls when `isAtBottomRef` is set,
 * and always with `behavior:"auto"` to avoid smooth-vs-auto thrash mid-stream;
 * smooth scrolling is reserved for the explicit `scrollToBottom()` button.
 */
const AT_BOTTOM_THRESHOLD_PX = 80;

export function useStickToBottom(
  containerRef: React.RefObject<HTMLElement | null>,
  endRef: React.RefObject<HTMLElement | null>,
) {
  const isAtBottomRef = useRef(true);
  const rafScheduledRef = useRef(false);
  const [showJumpButton, setShowJumpButton] = useState(false);

  const computeAtBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return true;
    return (
      el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD_PX
    );
  }, [containerRef]);

  // Track the user's position; coalesce scroll events through rAF so a fast
  // scroll doesn't fire the handler dozens of times per frame.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      if (rafScheduledRef.current) return;
      rafScheduledRef.current = true;
      requestAnimationFrame(() => {
        rafScheduledRef.current = false;
        const atBottom = computeAtBottom();
        isAtBottomRef.current = atBottom;
        setShowJumpButton((prev) => (prev === !atBottom ? prev : !atBottom));
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [containerRef, computeAtBottom]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      endRef.current?.scrollIntoView({ behavior, block: "end" });
      isAtBottomRef.current = true;
      setShowJumpButton(false);
    },
    [endRef],
  );

  // Follow new content only when already pinned to the bottom.
  const onContentChange = useCallback(() => {
    if (isAtBottomRef.current) {
      endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [endRef]);

  return { isAtBottomRef, scrollToBottom, onContentChange, showJumpButton };
}
