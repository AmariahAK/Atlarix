import { useState } from "react";
import { Paperclip } from "lucide-react";
import type { ReactNode } from "react";
import type { FileAttachment } from "@/ipc/ipc_types";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * Overflow folding for chat-input attachments. When the foldable attachments
 * exceed the threshold, AttachmentsList collapses them into this single summary
 * chip (`📎 N`). Clicking it opens a scrollable popover that renders each
 * attachment with its own original chip — so the per-kind preview and remove
 * behavior are reused verbatim, nothing is reimplemented.
 *
 * Background-job attachments are intentionally NOT folded (they keep their own
 * chip + popup), so they never reach this component.
 */
export function FoldedAttachmentsChip({
  items,
  onRemove,
  renderNode,
}: {
  /** Foldable attachments paired with their original index in the attachments array. */
  items: { attachment: FileAttachment; index: number }[];
  /** Removes by the attachment's ORIGINAL array index. */
  onRemove: (index: number) => void;
  /** Renders an attachment as its own chip (shared with the inline path). */
  renderNode: (
    attachment: FileAttachment,
    index: number,
    remove: () => void,
  ) => ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 rounded-md border border-border/80",
            "bg-muted/70 dark:bg-muted/40 px-2 py-1",
            "text-left cursor-pointer hover:bg-muted/90 dark:hover:bg-muted/55 transition-colors",
          )}
          title={`${items.length} attachments`}
        >
          <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs font-semibold text-foreground/90">
            {items.length}
          </span>
          <span className="rounded border border-border/60 bg-background/80 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
            Attachments
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-2">
        <div className="mb-2 px-1 text-xs font-semibold text-muted-foreground">
          Attachments ({items.length})
        </div>
        <ScrollArea className="max-h-72">
          <div className="flex flex-col items-start gap-1 pr-2">
            {items.map(({ attachment, index }) => (
              <div key={index} className="flex max-w-full">
                {renderNode(attachment, index, () => onRemove(index))}
              </div>
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
