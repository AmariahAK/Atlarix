import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatPasteMetadata } from "@/lib/chat/text-paste-attachment";

export function TextPastePreviewDialog({
  open,
  onOpenChange,
  content,
  displayName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  content: string;
  displayName?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-3">
        <DialogHeader>
          <DialogTitle>Pasted content</DialogTitle>
          <p className="text-xs text-muted-foreground font-normal">
            {formatPasteMetadata(content)}
            {displayName ? ` · ${displayName}` : ""}
            {" · Formatting may be inconsistent from source"}
          </p>
        </DialogHeader>
        <pre className="flex-1 min-h-0 max-h-[60vh] overflow-auto rounded-lg border border-border bg-muted/50 p-4 text-xs font-mono leading-relaxed text-foreground whitespace-pre-wrap break-words">
          {content}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
