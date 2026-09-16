import { useState } from "react";
import { Check, Copy, Terminal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { TextPastePreviewDialog } from "./TextPastePreviewDialog";

export function TerminalOutputAttachmentChip({
  content,
  displayContent,
  displayName,
  onRemove,
  readOnly = false,
}: {
  /** Model-facing transcript (prompt tagged). */
  content: string;
  /** Terminal-faithful text for copy/preview. */
  displayContent?: string;
  displayName: string;
  onRemove?: () => void;
  readOnly?: boolean;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const title = displayName.trim() || "Terminal output";
  const previewText = displayContent ?? content;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(previewText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <div
        className={cn(
          "relative flex items-center gap-1.5 rounded-md border border-border",
          "bg-muted/80 px-2 py-1 max-w-[280px]",
          "text-left cursor-pointer hover:bg-zinc-800/90 transition-colors",
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
        <Terminal className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="truncate text-xs font-mono text-foreground max-w-[120px]">
          {title}
        </span>
        <button
          type="button"
          onClick={(e) => void handleCopy(e)}
          className="rounded p-0.5 hover:bg-zinc-700 shrink-0"
          aria-label="Copy terminal output"
          title="Copy"
        >
          {copied ? (
            <Check className="h-3 w-3 text-emerald-400" />
          ) : (
            <Copy className="h-3 w-3 text-muted-foreground" />
          )}
        </button>
        {!readOnly && onRemove ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="rounded-full p-0.5 hover:bg-zinc-700 shrink-0"
            aria-label="Remove terminal selection"
          >
            <X className="h-3 w-3 text-muted-foreground" />
          </button>
        ) : null}
      </div>
      <TextPastePreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        content={previewText}
        displayName={displayName}
        title="Terminal output"
      />
    </>
  );
}
