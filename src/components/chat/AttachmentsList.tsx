import { Fragment, type ReactNode } from "react";
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
import { FoldedAttachmentsChip } from "./FoldedAttachmentsChip";

/** Collapse the chips into a summary once more than this many are foldable. */
const FOLD_THRESHOLD = 3;

/**
 * Render one attachment as its own chip (or the generic file tile). Shared by
 * the inline list and the folded popover so the per-kind preview + remove UI is
 * defined exactly once.
 */
function renderAttachmentNode(
  attachment: FileAttachment,
  _index: number,
  remove: () => void,
): ReactNode {
  if (isMentionAttachment(attachment)) {
    return (
      <MentionAttachmentChip
        kind={attachment.mention.kind}
        displayName={attachment.mention.displayName}
        onRemove={remove}
      />
    );
  }
  if (isTextPasteAttachment(attachment)) {
    return (
      <PastedTextAttachmentChip
        content={attachment.textPaste.content}
        displayName={attachment.textPaste.displayName}
        onRemove={remove}
      />
    );
  }
  if (isTerminalPasteAttachment(attachment)) {
    return (
      <TerminalOutputAttachmentChip
        content={attachment.terminalPaste.content}
        displayContent={attachment.terminalPaste.displayContent}
        displayName={attachment.terminalPaste.displayName}
        onRemove={remove}
      />
    );
  }
  if (isCodeSelectionAttachment(attachment)) {
    const { relpath, lineStart, lineEnd, content } = attachment.codeSelection;
    return (
      <CodeSelectionAttachmentChip
        displayName={codeSelectionDisplayName(relpath, lineStart, lineEnd)}
        content={content}
        onRemove={remove}
      />
    );
  }
  if (isBackgroundJobAttachment(attachment)) {
    const { jobId, command, outputTail } = attachment.backgroundJob;
    return (
      <BackgroundJobAttachmentChip
        displayName={backgroundJobDisplayName(jobId)}
        command={command}
        outputTail={outputTail}
        onRemove={remove}
      />
    );
  }
  // Generic file attachment: attach button / pasted image / dropped file.
  return (
    <div
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
        onClick={remove}
        className="hover:bg-muted-foreground/20 rounded-full p-0.5"
        aria-label="Remove attachment"
      >
        <X size={12} />
      </button>
    </div>
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

  const indexed = attachments.map((attachment, index) => ({
    attachment,
    index,
  }));
  // Background-job attachments keep their own chip + popup; never folded.
  const foldable = indexed.filter(
    ({ attachment }) => !isBackgroundJobAttachment(attachment),
  );
  const backgroundJobs = indexed.filter(({ attachment }) =>
    isBackgroundJobAttachment(attachment),
  );

  const inlineNode = ({
    attachment,
    index,
  }: {
    attachment: FileAttachment;
    index: number;
  }) => (
    <Fragment key={index}>
      {renderAttachmentNode(attachment, index, () => onRemove(index))}
    </Fragment>
  );

  if (foldable.length > FOLD_THRESHOLD) {
    return (
      <div className="px-2 pt-2 flex flex-wrap gap-1">
        <FoldedAttachmentsChip
          items={foldable}
          onRemove={onRemove}
          renderNode={renderAttachmentNode}
        />
        {backgroundJobs.map(inlineNode)}
      </div>
    );
  }

  return (
    <div className="px-2 pt-2 flex flex-wrap gap-1">{indexed.map(inlineNode)}</div>
  );
}
