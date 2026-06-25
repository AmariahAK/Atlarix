import type { FileAttachment } from "@/ipc/ipc_types";

/**
 * P1 — code-from-editor clipboard format. Mirrors the terminal's custom-MIME
 * approach (`terminal-line-buffer.ts`) so a Cmd+C in the Monaco Code tab paste
 * into chat is unambiguously recognized as a CODE selection (→ the C2 code chip),
 * instead of falling through to the terminal-transcript heuristic. The payload
 * rides alongside `text/plain`, so pasting anywhere else still yields the code.
 */
export const ATLARIX_CODE_CLIPBOARD_MIME = "application/x-atlarix-code+json";

export type AtlarixCodeClipboardPayload = {
  /** Workspace-relative path of the file the selection came from. */
  relpath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
};

/** Write a code selection to the clipboard with the custom MIME + plain text. */
export function writeCodeClipboard(payload: AtlarixCodeClipboardPayload): void {
  const json = JSON.stringify(payload);
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    void navigator.clipboard
      .write([
        new ClipboardItem({
          "text/plain": new Blob([payload.content], { type: "text/plain" }),
          [ATLARIX_CODE_CLIPBOARD_MIME]: new Blob([json], {
            type: ATLARIX_CODE_CLIPBOARD_MIME,
          }),
        }),
      ])
      .catch(() => {
        void navigator.clipboard.writeText(payload.content);
      });
    return;
  }
  void navigator.clipboard?.writeText(payload.content);
}

/**
 * If the clipboard carries an Atlarix code payload, build a `codeSelection`
 * attachment (the C2 chip). Returns null otherwise (so the caller falls through
 * to terminal/text classification).
 */
export function parseCodeFromClipboard(
  clipboardData: DataTransfer,
): FileAttachment | null {
  const json = clipboardData.getData(ATLARIX_CODE_CLIPBOARD_MIME);
  if (!json) return null;
  try {
    const p = JSON.parse(json) as AtlarixCodeClipboardPayload;
    if (!p?.relpath || !p.content?.trim()) return null;
    return {
      type: "chat-context",
      codeSelection: {
        relpath: p.relpath,
        lineStart: p.lineStart,
        lineEnd: p.lineEnd,
        content: p.content,
      },
    };
  } catch {
    return null;
  }
}
