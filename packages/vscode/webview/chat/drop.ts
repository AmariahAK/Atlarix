/**
 * What a file dropped from the desktop into the panel becomes (TODO 2026-11-03:
 * "drag and drop does not work"). Images were the only desktop files taken; any
 * other file was dropped silently. A text file now comes in as its text; one too
 * big, or binary, is named in a notice instead of vanishing.
 *
 * Files from the editor's own explorer arrive as URIs and become path chips
 * (composer.ts). VS Code only lets a drag into a webview through while Shift is
 * held, so without it nothing reaches here at all: the chat box says so.
 */

/** Big enough for a source file or a log excerpt; a larger one belongs as a path. */
export const DROPPED_TEXT_MAX_BYTES = 256 * 1024;

export type DropKind = "image" | "text" | "too-big" | "binary";

/** Decide from the file's type and size; `head` is its first bytes, read by the caller. */
export function droppedFileKind(file: { type: string; size: number }, head?: Uint8Array): DropKind {
  if (file.type.startsWith("image/")) return "image";
  if (file.size > DROPPED_TEXT_MAX_BYTES) return "too-big";
  if (head && head.includes(0)) return "binary";
  return "text";
}

/** The chat box's hint for VS Code's Shift rule. */
export const DROP_HINT = "Hold Shift while dropping files here";
