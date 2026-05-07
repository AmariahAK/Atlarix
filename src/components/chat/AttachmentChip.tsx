import { useState } from "react";
import { Download, FileText, X } from "lucide-react";
import { AttachmentStore } from "@/lib/attachment-store";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface AttachmentChipProps {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export function AttachmentChip({ id, filename, mimeType, size }: AttachmentChipProps) {
  const [showPreview, setShowPreview] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const isImage = mimeType.startsWith("image/");
  const isPdf = mimeType === "application/pdf";
  const lower = filename.toLowerCase();
  const isText =
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    /\.(md|txt|csv|json|log|yaml|yml|js|ts|tsx|jsx|py|go|rs|java|kt|swift|html|css|scss)$/.test(
      lower,
    );

  const handleDownload = () => {
    const attachment = AttachmentStore.get(id);
    if (!attachment) return;

    const binary = atob(attachment.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: attachment.mimeType });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handlePreview = () => {
    const attachment = AttachmentStore.get(id);
    if (!attachment) return;

    const binary = atob(attachment.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    let previewKind: "text" | "blob" = "blob";
    if (isText) {
      try {
        const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        setTextPreview(decoded.slice(0, 200_000));
        setPreviewUrl(null);
        setShowPreview(true);
        previewKind = "text";
      } catch {
        // fall back to blob preview if decoding fails
        const blob = new Blob([bytes], { type: attachment.mimeType });
        const url = URL.createObjectURL(blob);
        setPreviewUrl(url);
        setTextPreview(null);
        setShowPreview(true);
        previewKind = "blob";
      }
    } else {
      const blob = new Blob([bytes], { type: attachment.mimeType });
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
      setTextPreview(null);
      setShowPreview(true);
      previewKind = "blob";
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const closePreview = () => {
    setShowPreview(false);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setTextPreview(null);
  };

  return (
    <>
        <div className="inline-flex items-center gap-1.5 bg-muted/80 hover:bg-muted rounded-md px-2 py-1 text-xs group transition-colors">
        <div className="flex items-center gap-1">
          {isImage ? (
            <div className="relative">
              <FileText size={12} className="text-blue-600" />
            </div>
          ) : isPdf ? (
            <FileText size={12} className="text-red-600" />
          ) : (
            <FileText size={12} className="text-green-600" />
          )}
        </div>
        <span className="truncate max-w-[120px]" title={filename}>
          {filename}
        </span>
        <span className="text-muted-foreground">{formatSize(size)}</span>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {(isImage || isPdf || isText) && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handlePreview}
                    className="p-0.5 rounded hover:bg-muted-foreground/20"
                    title="Preview"
                  >
                    <FileText size={10} className="text-muted-foreground" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  Preview {isPdf ? "PDF" : isImage ? "image" : "text"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleDownload}
                  className="p-0.5 rounded hover:bg-muted-foreground/20"
                  title="Download"
                >
                  <Download size={10} className="text-muted-foreground" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Download</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {showPreview && (previewUrl || textPreview) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => {
            closePreview();
          }}
        >
          <div
            className="relative max-w-4xl max-h-[80vh] bg-background rounded-lg shadow-lg overflow-hidden"
            onClick={(e) => {
              // NOTE: do not stopPropagation yet; we want evidence first
              void e;
            }}
          >
            <button
              type="button"
              onClick={closePreview}
              className="absolute top-2 right-2 z-10 p-1 rounded-full bg-black/50 hover:bg-black/70 text-white"
            >
              <X size={16} />
            </button>
            {textPreview ? (
              <pre className="max-w-[80vw] max-h-[80vh] overflow-auto p-4 text-xs whitespace-pre-wrap">
                {textPreview}
              </pre>
            ) : isImage ? (
              <img
                src={previewUrl ?? undefined}
                alt={filename}
                className="max-w-full max-h-[80vh] object-contain"
              />
            ) : isPdf ? (
              <iframe
                src={previewUrl ?? undefined}
                className="w-[600px] h-[800px]"
                title={filename}
              />
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

