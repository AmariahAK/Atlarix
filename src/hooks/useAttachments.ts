import React, { useRef, useState } from "react";
import type { FileAttachment } from "@/ipc/ipc_types";
import { useAtom } from "jotai";
import { attachmentsAtom } from "@/atoms/chatAtoms";

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
      // Clear the input value so the same file can be selected again
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
      e.preventDefault(); // Prevent default paste behavior for images

      const imageFiles: File[] = [];
      // Generate base timestamp once to avoid collisions
      const baseTimestamp = new Date().toISOString().replace(/[:.]/g, "-");

      for (let i = 0; i < imageItems.length; i++) {
        const item = imageItems[i];
        const file = item.getAsFile();
        if (file) {
          // Create a more descriptive filename with timestamp and counter
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
        // Show a brief toast or indication that image was pasted
        console.log(`Pasted ${imageFiles.length} image(s) from clipboard`);
      }
      return;
    }

    // v8.0.1: Check for long plain text paste (> 500 lines) → attach as file
    const plainText = clipboardData.getData("text/plain");
    if (plainText) {
      const lineCount = (plainText.match(/\n/g) || []).length + 1;
      if (lineCount > 500) {
        e.preventDefault();

        // Detect language from content
        const trimmed = plainText.trim();
        let ext = "txt";
        if (trimmed.startsWith("import ") || trimmed.startsWith("const ") ||
            trimmed.startsWith("function ") || trimmed.startsWith("class ") ||
            trimmed.startsWith("interface ") || trimmed.startsWith("type ") ||
            trimmed.startsWith("export ")) {
          ext = "ts";
        } else if (trimmed.startsWith("def ") || (trimmed.startsWith("class ") && !trimmed.includes(";"))) {
          ext = "py";
        } else if (trimmed.startsWith("<")) {
          ext = "html";
        } else if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.endsWith("}")) {
          // Basic JSON check
          try {
            JSON.parse(trimmed);
            ext = "json";
          } catch {
            // Not valid JSON, leave as .txt
          }
        }

        const timestamp = Date.now();
        const filename = `pasted-${ext}-${timestamp}.${ext}`;
        const blob = new Blob([plainText], { type: "text/plain" });
        const file = new File([blob], filename, { type: "text/plain" });
        addAttachments([file], "chat-context");
        console.log(`Pasted ${lineCount} lines → attached as ${filename}`);
      }
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
