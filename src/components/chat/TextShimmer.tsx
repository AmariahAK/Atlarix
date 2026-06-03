import { cn } from "@/lib/utils";

/**
 * Animated shimmer over text — used for in-progress tool labels so a running
 * tool reads as alive without a spinner. Falls back to plain text under
 * `prefers-reduced-motion` (handled in globals.css `.tool-shimmer-text`).
 */
export function TextShimmer({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={cn("tool-shimmer-text", className)}>{children}</span>;
}
