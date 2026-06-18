import { File, Folder, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Composer chip for an `@`-mention of a workspace file/folder. Mirrors the
 * pasted-text / terminal chips so a picked `@file:`/`@dir:` reads as an
 * attachment instead of inline text. The badge distinguishes a folder
 * (listing only) from a file (contents included, capped).
 */
export function MentionAttachmentChip({
  kind,
  displayName,
  onRemove,
  readOnly = false,
}: {
  kind: "file" | "dir";
  displayName: string;
  onRemove?: () => void;
  readOnly?: boolean;
}) {
  const Icon = kind === "dir" ? Folder : File;
  const badge = kind === "dir" ? "Folder" : "File";
  return (
    <div
      className={cn(
        "relative flex items-center gap-1.5 rounded-md border border-border/80",
        "bg-muted/70 dark:bg-muted/40 px-2 py-1 max-w-[220px]",
      )}
      title={displayName}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate text-xs text-foreground/90 max-w-[120px]">
        {displayName}
      </span>
      <span className="rounded border border-border/60 bg-background/80 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
        {badge}
      </span>
      {!readOnly && onRemove ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="ml-auto rounded-full p-0.5 hover:bg-muted-foreground/20 shrink-0"
          aria-label="Remove mention"
        >
          <X className="h-3 w-3 text-muted-foreground" />
        </button>
      ) : null}
    </div>
  );
}
