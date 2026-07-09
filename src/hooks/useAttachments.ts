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
): FileAttachment | null {
  return parseTerminalPasteFromClipboard(clipboardData);
}

function applyPasteAttachment(
  setAttachments: React.Dispatch<React.SetStateAction<FileAttachment[]>>,
  att: FileAttachment,
) {
  if (att.terminalPaste) {
    setAttachments((prev) => upsertTerminalAttachment(prev, att));
    return;
  }
  setAttachments((prev) => [...prev, att]);
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
      setAttachments((attachments) => [...attachments, ...fileAttachments]);
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
    setAttachments((attachments) => [...attachments, ...fileAttachments]);
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
      setAttachments((attachments) => [...attachments, ...fileAttachments]);
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
    setAttachments((attachments) => [...attachments, ...fileAttachments]);
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
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

    const terminalAtt = tryCaptureTerminalPaste(clipboardData);
    if (terminalAtt) {
      e.preventDefault();
      e.stopPropagation();
      applyPasteAttachment(setAttachments, terminalAtt);
      return;
    }

    const plainText = readClipboardPlainText(clipboardData);
    if (plainText && shouldCaptureAsTextPaste(plainText)) {
      e.preventDefault();
      e.stopPropagation();
      const displayName = textPasteDisplayName(plainText);
      applyPasteAttachment(setAttachments, {
        type: "chat-context",
        textPaste: { content: plainText, displayName },
      });
    }
  };

  /** Capture-phase handler for wrappers around Lexical (paste may not bubble). */
  const handlePasteCapture = (e: React.ClipboardEvent) => {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return;
    const hasImage = Array.from(clipboardData.items).some((item) =>
      item.type.startsWith("image/"),
    );
    if (hasImage) return;

    const terminalAtt = tryCaptureTerminalPaste(clipboardData);
    if (terminalAtt) {
      e.preventDefault();
      e.stopPropagation();
      applyPasteAttachment(setAttachments, terminalAtt);
      return;
    }

    const plainText = readClipboardPlainText(clipboardData);
    if (plainText && shouldCaptureAsTextPaste(plainText)) {
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
    handlePasteCapture,
    addAttachments,
  };
}
