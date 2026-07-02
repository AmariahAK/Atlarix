import { useState, useRef, useEffect } from "react";
import { useSetAtom } from "jotai";
import { Check, Copy, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  aiPanelIntentAtom,
  previewTabAtom,
  rightPanelSuppressAutoOpenAtom,
  rightPanelVisibleAtom,
  selectedErrorForCodeAtom,
} from "@/atoms/sourceAtoms";

/** Small hover/focus copy button for tool result bodies. */
export function CopyButton({
  text,
  className,
  label = "Copy",
}: {
  text: string;
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const onCopy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!text.trim()) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied!" : label}
      className={cn(
        "inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors",
        className,
      )}
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-500" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

/**
 * Opens a workspace file in the Code tab — the SAME wiring QuickFileOpen /
 * the file tree use (`sourceAtoms`). The previous `selectedFileAtom` /
 * `isPreviewOpenAtom` writes were dead (no readers), so the button did nothing.
 * Pass `line` (e.g. a read_file snippet's start line) to jump to it.
 */
export function OpenFileButton({
  path,
  line,
  className,
}: {
  path: string;
  line?: number;
  className?: string;
}) {
  const setSelectedErrorForCode = useSetAtom(selectedErrorForCodeAtom);
  const setSuppressRightAutoOpen = useSetAtom(rightPanelSuppressAutoOpenAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const setPreviewTab = useSetAtom(previewTabAtom);
  const setAIPanelIntent = useSetAtom(aiPanelIntentAtom);

  if (!path.trim()) return null;

  const onOpen = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedErrorForCode(line != null ? { filePath: path, line } : { filePath: path });
    setSuppressRightAutoOpen(false);
    setRightPanelVisible(true);
    setPreviewTab("code");
    setAIPanelIntent({
      intent: "show-preview",
      timestamp: Date.now(),
      source: "user",
    });
  };

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Open in editor"
      title="Open in editor"
      className={cn(
        "inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors",
        className,
      )}
    >
      <FileText className="h-3 w-3" />
      Open
    </button>
  );
}
