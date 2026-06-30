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
 * The caller passes the scroll container, the end sentinel, and (optionally) the
 * inner content wrapper. The content wrapper is observed with a `ResizeObserver`
 * so the bottom is re-pinned IN THE SAME FRAME (after layout, before paint)
 * whenever content grows — this is what kills the "jump up then catch up" flicker
 * that the old `onContentChange`-only follow could not (markdown re-parse, a tool
 * card finalizing its height, images/diffs expanding all change height without
 * changing the `messages`/`streamCount` deps).
 *
 * Two cooperating tricks borrowed from opencode's `create-auto-scroll`:
 *  1. DYNAMIC `overflow-anchor`: `none` while we're following (so the browser's
 *     CSS scroll-anchoring doesn't fight our manual pin and yank the viewport to
 *     an earlier node), `auto` once the user scrolls up (so their position stays
 *     stable when content above them grows). The OLD bug was a static
 *     `overflow-anchor:auto` on the container dueling the manual `scrollIntoView`.
 *  2. `markAuto`/`isAuto`: tag our own programmatic scrolls so the async `scroll`
 *     event they trigger isn't misread as "the user scrolled up" when fresh
 *     content lands between the pin and the event.
 */
const AT_BOTTOM_THRESHOLD_PX = 80;
const AUTO_SCROLL_GRACE_MS = 1500;

export function useStickToBottom(
  containerRef: React.RefObject<HTMLElement | null>,
  endRef: React.RefObject<HTMLElement | null>,
  contentRef?: React.RefObject<HTMLElement | null>,
) {
  const isAtBottomRef = useRef(true);
  const rafScheduledRef = useRef(false);
  // Records the scrollTop we expect after a programmatic pin, so an async scroll
  // event arriving with stale/grown content isn't misread as a user scroll.
  const autoRef = useRef<{ top: number; time: number } | null>(null);
  const [showJumpButton, setShowJumpButton] = useState(false);

  const computeAtBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return true;
    return (
      el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD_PX
    );
  }, [containerRef]);

  // `none` while following → the browser stops competing with our manual pin.
  // `auto` while the user reads history → the browser keeps their view stable.
  const applyOverflowAnchor = useCallback(
    (atBottom: boolean) => {
      const el = containerRef.current;
      if (el) el.style.overflowAnchor = atBottom ? "none" : "auto";
    },
    [containerRef],
  );

  const markAuto = useCallback((el: HTMLElement) => {
    autoRef.current = {
      top: Math.max(0, el.scrollHeight - el.clientHeight),
      time: Date.now(),
    };
  }, []);

  const isAuto = useCallback((el: HTMLElement) => {
    const a = autoRef.current;
    if (!a) return false;
    if (Date.now() - a.time > AUTO_SCROLL_GRACE_MS) {
      autoRef.current = null;
      return false;
    }
    return Math.abs(el.scrollTop - a.top) < 2;
  }, []);

  // Immediate, smooth-bypassing pin to the very bottom (used for following).
  const pinBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    markAuto(el);
    el.scrollTop = el.scrollHeight;
  }, [containerRef, markAuto]);

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
        const node = containerRef.current;
        if (!node) return;
        const atBottom = computeAtBottom();
        // Our own pin can fire a `scroll` event after new content grew the list;
        // ignore it so we don't flip into "user scrolled up" and unfollow.
        if (!atBottom && isAuto(node)) return;
        isAtBottomRef.current = atBottom;
        setShowJumpButton((prev) => (prev === !atBottom ? prev : !atBottom));
        applyOverflowAnchor(atBottom);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [containerRef, computeAtBottom, isAuto, applyOverflowAnchor]);

  // Re-pin in the same frame whenever the content wrapper resizes (token growth,
  // tool-card height changes, image loads) — the anti-flicker core.
  useEffect(() => {
    const target = contentRef?.current;
    if (!target) return;
    const ro = new ResizeObserver(() => {
      if (isAtBottomRef.current) pinBottom();
    });
    ro.observe(target);
    return () => ro.disconnect();
  }, [contentRef, pinBottom]);

  // Default to "following" anchoring on mount.
  useEffect(() => {
    applyOverflowAnchor(true);
  }, [applyOverflowAnchor]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const el = containerRef.current;
      if (behavior === "smooth") {
        endRef.current?.scrollIntoView({ behavior, block: "end" });
      } else if (el) {
        markAuto(el);
        el.scrollTop = el.scrollHeight;
      }
      isAtBottomRef.current = true;
      setShowJumpButton(false);
      applyOverflowAnchor(true);
    },
    [containerRef, endRef, markAuto, applyOverflowAnchor],
  );

  // Follow new content only when already pinned to the bottom. (The
  // ResizeObserver covers height changes that don't touch the caller's deps; this
  // covers the explicit message/stream deltas the caller drives.)
  const onContentChange = useCallback(() => {
    if (isAtBottomRef.current) pinBottom();
  }, [pinBottom]);

  return { isAtBottomRef, scrollToBottom, onContentChange, showJumpButton };
}
