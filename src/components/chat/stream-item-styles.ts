/** Shared chat stream row styles — readable in light and dark mode. */

/** Tool cards, context groups, collapsed activity sections */
export const streamToolCardShell =
  "my-1.5 rounded-lg border border-border bg-muted/60 dark:bg-muted/20 text-xs shadow-sm/5 dark:shadow-none";

/** Scrollable body inside a stream card (sub-agents list, tool expand, etc.) */
export const streamCardScrollBody =
  "min-h-0 max-h-[min(70vh,28rem)] overflow-y-auto overscroll-contain pr-0.5";

/** Single-line tool row header */
export const streamToolCardButton =
  "w-full flex items-center gap-2 px-2.5 py-1.5 text-left min-h-[28px] text-foreground hover:bg-muted/80 dark:hover:bg-muted/40";

/** Multi-line header (sub-agent title + status subtitle) */
export const streamToolCardButtonMultiLine =
  "w-full flex items-start gap-2 px-2.5 py-2 text-left text-foreground hover:bg-muted/80 dark:hover:bg-muted/40";

export const streamToolCardSummary = "flex-1 min-w-0 truncate font-medium text-foreground";

export const streamToolCardChevron = "h-3.5 w-3.5 shrink-0 text-muted-foreground mt-0.5";

/** Inline reasoning / thought blocks */
export const thoughtBlockShell =
  "my-2 rounded-lg border border-emerald-700/20 bg-emerald-50 dark:border-emerald-500/25 dark:bg-emerald-500/5 overflow-hidden shadow-sm/5 dark:shadow-none";

export const thoughtBlockButton =
  "w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs text-emerald-950 dark:text-emerald-100 hover:bg-emerald-100/80 dark:hover:bg-emerald-500/10";

export const thoughtBlockMeta = "font-normal text-emerald-800/80 dark:text-emerald-200/70";

export const thoughtBlockBody =
  "border-t border-emerald-700/15 dark:border-emerald-500/20 px-2.5 py-2 text-xs text-foreground/85 dark:text-muted-foreground whitespace-pre-wrap break-words max-h-48 overflow-y-auto";
