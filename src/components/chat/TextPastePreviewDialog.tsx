import { useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatPasteMetadata } from "@/lib/chat/text-paste-attachment";

export function TextPastePreviewDialog({
  open,
  onOpenChange,
  content,
  displayName,
  title = "Pasted content",
  showCopy = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  content: string;
  displayName?: string;
  title?: string;
  showCopy?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-3">
        <DialogHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
          <div className="min-w-0">
            <DialogTitle>{title}</DialogTitle>
            <p className="text-xs text-muted-foreground font-normal mt-1">
              {formatPasteMetadata(content)}
              {displayName ? ` · ${displayName}` : ""}
              {" · Formatting may be inconsistent from source"}
            </p>
          </div>
          {showCopy ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              onClick={() => void handleCopy()}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          ) : null}
        </DialogHeader>
        <pre className="flex-1 min-h-0 max-h-[60vh] overflow-auto rounded-lg border border-border bg-muted/50 p-4 text-xs font-mono leading-relaxed text-foreground whitespace-pre-wrap break-words select-text">
          {content}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
