import { FileCode2, Folder } from "lucide-react";
import { cn } from "@/lib/utils";

export function ToolFileRow({
  fileName,
  directory,
  trailing,
  entryType,
  className,
}: {
  fileName: string;
  directory: string;
  trailing?: string;
  entryType?: "file" | "dir";
  className?: string;
}) {
  const Icon = entryType === "dir" ? Folder : FileCode2;

  return (
    <div
      className={cn(
        "flex items-center gap-2 min-w-0 py-1 px-1 rounded-sm hover:bg-muted/30",
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0 flex items-baseline gap-1.5 flex-wrap">
        <span className="font-medium text-foreground truncate">{fileName}</span>
        <span className="text-muted-foreground truncate text-[10px]">
          {directory}
        </span>
      </div>
      {trailing ? (
        <span className="shrink-0 text-muted-foreground text-[10px] tabular-nums">
          {trailing}
        </span>
      ) : null}
    </div>
  );
}
