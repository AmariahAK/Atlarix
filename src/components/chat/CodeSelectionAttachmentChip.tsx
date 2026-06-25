import { useState } from "react";
import { Code2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { TextPastePreviewDialog } from "./TextPastePreviewDialog";

/**
 * C2 — chip for code selected in the Code tab. Shows `basename:lineStart-lineEnd`
 * (the model receives the full path + range + content via the
 * `<atlarix-code-selection>` block).
 */
export function CodeSelectionAttachmentChip({
  displayName,
  content,
  onRemove,
  readOnly = false,
}: {
  displayName: string;
  content: string;
  onRemove?: () => void;
  readOnly?: boolean;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <>
      <div
        className={cn(
          "relative flex items-center gap-1.5 rounded-md border border-border/80",
          "bg-muted/70 dark:bg-muted/40 px-2 py-1 max-w-[220px]",
          "text-left cursor-pointer hover:bg-muted/90 dark:hover:bg-muted/55 transition-colors",
        )}
        role="button"
        tabIndex={0}
        onClick={() => setPreviewOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setPreviewOpen(true);
          }
        }}
      >
        <Code2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs text-foreground/90 max-w-[120px]">
          {displayName}
        </span>
        <span className="rounded border border-border/60 bg-background/80 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
          Code
        </span>
        {!readOnly && onRemove ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="ml-auto rounded-full p-0.5 hover:bg-muted-foreground/20 shrink-0"
            aria-label="Remove code selection"
          >
            <X className="h-3 w-3 text-muted-foreground" />
          </button>
        ) : null}
      </div>
      <TextPastePreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        content={content}
        displayName={displayName}
      />
    </>
  );
}
