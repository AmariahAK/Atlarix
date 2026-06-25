import { FileText, X } from "lucide-react";
import type { FileAttachment } from "@/ipc/ipc_types";
import { isTextPasteAttachment } from "@/lib/chat/text-paste-attachment";
import { isTerminalPasteAttachment } from "@/lib/chat/terminal-paste-attachment";
import { isMentionAttachment } from "@/lib/chat/mention-attachment";
import {
  isCodeSelectionAttachment,
  codeSelectionDisplayName,
} from "@/lib/chat/code-selection-attachment";
import {
  isBackgroundJobAttachment,
  backgroundJobDisplayName,
} from "@/lib/chat/background-job-attachment";
import { PastedTextAttachmentChip } from "./PastedTextAttachmentChip";
import { TerminalOutputAttachmentChip } from "./TerminalOutputAttachmentChip";
import { MentionAttachmentChip } from "./MentionAttachmentChip";
import { CodeSelectionAttachmentChip } from "./CodeSelectionAttachmentChip";
import { BackgroundJobAttachmentChip } from "./BackgroundJobAttachmentChip";

/** Attachments rendered as their own chip (not the generic file-attachment tile). */
function isChipAttachment(attachment: FileAttachment): boolean {
  return (
    isTextPasteAttachment(attachment) ||
    isTerminalPasteAttachment(attachment) ||
    isMentionAttachment(attachment) ||
    isCodeSelectionAttachment(attachment) ||
    isBackgroundJobAttachment(attachment)
  );
}

interface AttachmentsListProps {
  attachments: FileAttachment[];
  onRemove: (index: number) => void;
}

export function AttachmentsList({
  attachments,
  onRemove,
}: AttachmentsListProps) {
  if (attachments.length === 0) return null;

  const fileAttachments = attachments.filter((a) => !isChipAttachment(a));

  return (
    <div className="px-2 pt-2 flex flex-wrap gap-1">
      {attachments.map((attachment, index) => {
        if (isMentionAttachment(attachment)) {
          return (
            <MentionAttachmentChip
              key={`mention-${index}`}
              kind={attachment.mention.kind}
              displayName={attachment.mention.displayName}
              onRemove={() => onRemove(index)}
            />
          );
        }
        if (isTextPasteAttachment(attachment)) {
          return (
            <PastedTextAttachmentChip
              key={`paste-${index}`}
              content={attachment.textPaste.content}
              displayName={attachment.textPaste.displayName}
              onRemove={() => onRemove(index)}
            />
          );
        }
        if (isTerminalPasteAttachment(attachment)) {
          return (
            <TerminalOutputAttachmentChip
              key={`terminal-${index}`}
              content={attachment.terminalPaste.content}
              displayContent={attachment.terminalPaste.displayContent}
              displayName={attachment.terminalPaste.displayName}
              onRemove={() => onRemove(index)}
            />
          );
        }
        if (isCodeSelectionAttachment(attachment)) {
          const { relpath, lineStart, lineEnd, content } = attachment.codeSelection;
          return (
            <CodeSelectionAttachmentChip
              key={`code-${index}`}
              displayName={codeSelectionDisplayName(relpath, lineStart, lineEnd)}
              content={content}
              onRemove={() => onRemove(index)}
            />
          );
        }
        if (isBackgroundJobAttachment(attachment)) {
          const { jobId, command, outputTail } = attachment.backgroundJob;
          return (
            <BackgroundJobAttachmentChip
              key={`job-${index}`}
              displayName={backgroundJobDisplayName(jobId)}
              command={command}
              outputTail={outputTail}
              onRemove={() => onRemove(index)}
            />
          );
        }
        return null;
      })}
      {fileAttachments.length > 0 ? (
        <>
          {attachments.map((attachment, index) => {
            if (isChipAttachment(attachment)) return null;
            return (
              <div
                key={`file-${index}`}
                className="flex items-center bg-muted rounded-md px-2 py-1 text-xs gap-1"
                title={`${attachment.file?.name ?? "file"} (${((attachment.file?.size ?? 0) / 1024).toFixed(1)}KB)`}
              >
                {attachment.file?.type.startsWith("image/") ? (
                  <div className="relative group">
                    <img
                      src={URL.createObjectURL(attachment.file)}
                      alt={attachment.file.name}
                      className="w-5 h-5 object-cover rounded"
                      onLoad={(e) =>
                        URL.revokeObjectURL((e.target as HTMLImageElement).src)
                      }
                      onError={(e) =>
                        URL.revokeObjectURL((e.target as HTMLImageElement).src)
                      }
                    />
                    <div className="absolute hidden group-hover:block top-6 left-0 z-10">
                      <img
                        src={URL.createObjectURL(attachment.file)}
                        alt={attachment.file.name}
                        className="max-w-[200px] max-h-[200px] object-contain bg-white p-1 rounded shadow-lg"
                        onLoad={(e) =>
                          URL.revokeObjectURL((e.target as HTMLImageElement).src)
                        }
                        onError={(e) =>
                          URL.revokeObjectURL((e.target as HTMLImageElement).src)
                        }
                      />
                    </div>
                  </div>
                ) : (
                  <FileText size={12} />
                )}
                <span className="truncate max-w-[120px]">
                  {attachment.file?.name ?? "Attachment"}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(index)}
                  className="hover:bg-muted-foreground/20 rounded-full p-0.5"
                  aria-label="Remove attachment"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </>
      ) : null}
    </div>
  );
}
