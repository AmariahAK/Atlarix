import React, { useRef, useState } from "react";
import type { FileAttachment } from "@/ipc/ipc_types";
import { useAtom } from "jotai";
import { attachmentsAtom } from "@/atoms/chatAtoms";
import {
  shouldCaptureAsTextPaste,
  textPasteDisplayName,
  readClipboardPlainText,
} from "@/lib/chat/text-paste-attachment";
import {
  parseTerminalPasteFromClipboard,
  upsertTerminalAttachment,
} from "@/lib/chat/terminal-line-buffer";

function tryCaptureTerminalPaste(
  clipboardData: DataTransfer,
  preReadPlainText?: string,
): FileAttachment | null {
  return parseTerminalPasteFromClipboard(clipboardData, preReadPlainText);
}

/**
 * Stable content identity used to dedupe the composer's attachment array across
 * ALL kinds, so the same file/paste/image/mention registered twice (double
 * paste, both paste handlers firing, re-drop) never becomes two chips — or two
 * copies sent to the model. Terminal pastes have their own line-range upsert.
 * Returns null when there's no stable key (then we just append).
 */
function attachmentContentKey(att: FileAttachment): string | null {
  if (att.file)
    return `file:${att.file.name}\u0000${att.file.size}\u0000${att.file.lastModified}`;
  // Cheap signature (length + head + tail) instead of the full body, so deduping
  // a huge paste against the attachment list isn't an O(n) string compare per
  // entry — enough to catch an accidental double-paste of the same content.
  if (att.textPaste) {
    const c = att.textPaste.content;
    return `text:${c.length}:${c.slice(0, 64)}:${c.slice(-64)}`;
  }
  if (att.mention) return `mention:${att.mention.kind}:${att.mention.relpath}`;
  if (att.backgroundJob) return `job:${att.backgroundJob.jobId}`;
  return null;
}

/** Append attachments idempotently — skip any whose content key already exists;
 * terminal pastes use the existing line-range upsert. */
function mergeAttachments(
  prev: FileAttachment[],
  incoming: FileAttachment[],
): FileAttachment[] {
  let result = prev;
  for (const att of incoming) {
    if (att.terminalPaste) {
      result = upsertTerminalAttachment(result, att);
      continue;
    }
    const key = attachmentContentKey(att);
    if (key != null && result.some((e) => attachmentContentKey(e) === key)) {
      continue; // duplicate — skip
    }
    result = result === prev ? [...prev, att] : [...result, att];
  }
  return result;
}

function applyPasteAttachment(
  setAttachments: React.Dispatch<React.SetStateAction<FileAttachment[]>>,
  att: FileAttachment,
) {
  setAttachments((prev) => mergeAttachments(prev, [att]));
}

export function useAttachments() {
  const [attachments, setAttachments] = useAtom(attachmentsAtom);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const handleAttachmentClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    type: "chat-context" | "upload-to-codebase" = "chat-context",
  ) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = Array.from(e.target.files);
      const fileAttachments: FileAttachment[] = files.map((file) => ({
        file,
        type,
      }));
      setAttachments((attachments) =>
        mergeAttachments(attachments, fileAttachments),
      );
      e.target.value = "";
    }
  };

  const handleFileSelect = (
    fileList: FileList,
    type: "chat-context" | "upload-to-codebase" = "chat-context",
  ) => {
    const files = Array.from(fileList);
    const fileAttachments: FileAttachment[] = files.map((file) => ({
      file,
      type,
    }));
    setAttachments((attachments) =>
      mergeAttachments(attachments, fileAttachments),
    );
  };

  const removeAttachment = (index: number) => {
    setAttachments(attachments.filter((_, i) => i !== index));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(true);
  };

  const handleDragLeave = () => {
    setIsDraggingOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files);
      const fileAttachments: FileAttachment[] = files.map((file) => ({
        file,
        type: "chat-context" as const,
      }));
      setAttachments((attachments) =>
        mergeAttachments(attachments, fileAttachments),
      );
    }
  };

  const clearAttachments = () => {
    setAttachments([]);
  };

  const addAttachments = (
    files: File[],
    type: "chat-context" | "upload-to-codebase" = "chat-context",
  ) => {
    const fileAttachments: FileAttachment[] = files.map((file) => ({
      file,
      type,
    }));
    setAttachments((attachments) =>
      mergeAttachments(attachments, fileAttachments),
    );
  };

  // Synchronous on purpose: a paste handler must call preventDefault() during
  // the event's synchronous dispatch, or the browser's default paste (dumping
  // the text into the textarea) may still win.
  const handlePaste = (e: React.ClipboardEvent) => {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return;

    const items = Array.from(clipboardData.items);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));

    if (imageItems.length > 0) {
      e.preventDefault();

      const imageFiles: File[] = [];
      const baseTimestamp = new Date().toISOString().replace(/[:.]/g, "-");

      for (let i = 0; i < imageItems.length; i++) {
        const item = imageItems[i];
        const file = item.getAsFile();
        if (file) {
          const extension = file.type.split("/")[1] || "png";
          const filename =
            imageItems.length === 1
              ? `pasted-image-${baseTimestamp}.${extension}`
              : `pasted-image-${baseTimestamp}-${i + 1}.${extension}`;

          const newFile = new File([file], filename, {
            type: file.type,
          });
          imageFiles.push(newFile);
        }
      }

      if (imageFiles.length > 0) {
        addAttachments(imageFiles, "chat-context");
        console.log(`Pasted ${imageFiles.length} image(s) from clipboard`);
      }
      return;
    }

    // Read the clipboard text ONCE and reuse it — a large rich-text paste (only
    // text/html) is otherwise parsed by DOMParser twice (terminal check + text
    // check), which is the main source of the multi-hundred-ms "beach ball".
    const plainText = readClipboardPlainText(clipboardData);

    const terminalAtt = tryCaptureTerminalPaste(clipboardData, plainText);
    if (terminalAtt) {
      e.preventDefault();
      e.stopPropagation();
      applyPasteAttachment(setAttachments, terminalAtt);
      return;
    }

    if (plainText && shouldCaptureAsTextPaste(plainText)) {
      // preventDefault synchronously so a long paste is NEVER dumped into the
      // controlled textarea (which re-renders + re-tokenizes on every change —
      // the freeze that made it land as inline text until re-pasted).
      e.preventDefault();
      e.stopPropagation();
      const displayName = textPasteDisplayName(plainText);
      applyPasteAttachment(setAttachments, {
        type: "chat-context",
        textPaste: { content: plainText, displayName },
      });
    }
  };

  return {
    attachments,
    fileInputRef,
    isDraggingOver,
    handleAttachmentClick,
    handleFileChange,
    handleFileSelect,
    removeAttachment,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    clearAttachments,
    handlePaste,
    addAttachments,
  };
}
