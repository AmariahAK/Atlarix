import type { TerminalLine } from "@/atoms/terminalInstancesAtoms";
import type { FileAttachment } from "@/ipc/ipc_types";
import type { TerminalPasteOwner } from "@/lib/chat/terminal-paste-attachment";
import {
  terminalPasteDisplayName,
  terminalSelectionLineRange,
} from "@/lib/chat/terminal-paste-attachment";
import {
  commandFromLines,
  linesToModelText,
  linesToVisibleText,
} from "@/lib/chat/terminal-line-format";
import { readClipboardPlainText } from "@/lib/chat/text-paste-attachment";

export const TERMINAL_MAX_LINES = 600;

export const ATLARIX_TERMINAL_CLIPBOARD_MIME =
  "application/x-atlarix-terminal+json";

export type AtlarixTerminalClipboardPayload = {
  /** Visible terminal-faithful transcript. */
  content: string;
  instanceLabel: string;
  owner: TerminalPasteOwner;
  lineStart: number;
  lineEnd: number;
};

/** Keep the most recent lines (rolling window). */
export function capTerminalLines<T extends { id: string }>(
  lines: T[],
  max: number = TERMINAL_MAX_LINES,
): T[] {
  if (lines.length <= max) return lines;
  return lines.slice(-max);
}

export function commandBlockRangeAt(
  lines: TerminalLine[],
  promptIndex: number,
): { start: number; end: number; slice: TerminalLine[] } {
  let endExclusive = lines.length;
  for (let i = promptIndex + 1; i < lines.length; i++) {
    if (lines[i]!.kind === "prompt") {
      endExclusive = i;
      break;
    }
  }
  const slice = lines.slice(promptIndex, endExclusive);
  return {
    start: promptIndex + 1,
    end: endExclusive,
    slice,
  };
}

/** Most recent command block: prompt through output/status before next prompt. */
export function lastCommandBlockRange(lines: TerminalLine[]): {
  start: number;
  end: number;
  slice: TerminalLine[];
} | null {
  let lastPrompt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.kind === "prompt") {
      lastPrompt = i;
      break;
    }
  }
  if (lastPrompt < 0) return null;
  return commandBlockRangeAt(lines, lastPrompt);
}

export function commandBlockRanges(lines: TerminalLine[]): {
  promptIndex: number;
  start: number;
  end: number;
}[] {
  const blocks: { promptIndex: number; start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.kind !== "prompt") continue;
    const { start, end } = commandBlockRangeAt(lines, i);
    blocks.push({ promptIndex: i, start, end });
  }
  return blocks;
}

const TERMINAL_PREFIX_RE = /^\[(?:You|Agent)\]\s/m;

export function looksLikeTerminalTranscript(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Only the UNAMBIGUOUS Atlarix terminal markers count. A bare `$ ` or `>`
  // line appears constantly in code/docs/markdown (shell examples, prompts,
  // generics, redirects), so matching on those misclassified pasted code as a
  // terminal transcript (P1). Real terminal copies carry the custom clipboard
  // MIME and never rely on this heuristic; this fallback is only for transcripts
  // pasted from OUTSIDE Atlarix, which carry the [You]/[Agent] owner prefixes.
  if (TERMINAL_PREFIX_RE.test(trimmed)) return true;
  return false;
}

export function parsePlainTextToTerminalLines(text: string): TerminalLine[] {
  const rows = text.trim().split(/\r?\n/);
  let defaultPrefix: TerminalLine["prefix"] = "[You]";
  return rows.map((row, i) => {
    const ownerMatch = row.match(/^(\[(?:You|Agent)\])\s+(.*)$/);
    if (ownerMatch) {
      const prefix = ownerMatch[1] as TerminalLine["prefix"];
      defaultPrefix = prefix;
      const body = ownerMatch[2] ?? "";
      const kind: TerminalLine["kind"] = body.startsWith("$ ")
        ? "prompt"
        : body.startsWith("exit ") ||
            body === "failed" ||
            body.includes("timed out")
          ? "status"
          : "output";
      return {
        id: `paste-${i}`,
        prefix,
        text: body,
        kind,
      };
    }
    const shellPrompt = row.match(/^(\$\s+.*)$/);
    if (shellPrompt) {
      return {
        id: `paste-${i}`,
        prefix: defaultPrefix,
        text: shellPrompt[1]!,
        kind: "prompt",
      };
    }
    const kind: TerminalLine["kind"] =
      row.startsWith("exit ") || row === "failed" || row.includes("timed out")
        ? "status"
        : "output";
    return {
      id: `paste-${i}`,
      prefix: defaultPrefix,
      text: row,
      kind,
    };
  });
}

export function buildTerminalPasteAttachment(opts: {
  lines: TerminalLine[];
  instanceLabel: string;
  owner: TerminalPasteOwner;
  lineStart: number;
  lineEnd: number;
}): FileAttachment {
  const commandHint = commandFromLines(opts.lines);
  const content = linesToModelText(opts.lines);
  const displayContent = linesToVisibleText(opts.lines);
  const displayName = terminalPasteDisplayName(
    opts.owner,
    opts.instanceLabel,
    opts.lineStart,
    opts.lineEnd,
    commandHint,
  );
  return {
    type: "chat-context",
    terminalPaste: {
      content,
      displayContent,
      displayName,
      instanceLabel: opts.instanceLabel,
      owner: opts.owner,
      lineStart: opts.lineStart,
      lineEnd: opts.lineEnd,
    },
  };
}

export function buildTerminalPasteFromSelection(opts: {
  allLines: TerminalLine[];
  selectedText: string;
  instanceLabel: string;
  owner: TerminalPasteOwner;
}): FileAttachment {
  const visibleFull = linesToVisibleText(opts.allLines);
  const { start, end } = terminalSelectionLineRange(
    opts.allLines,
    opts.selectedText,
    visibleFull,
  );
  const slice = opts.allLines.slice(start - 1, end);
  return buildTerminalPasteAttachment({
    lines: slice.length > 0 ? slice : opts.allLines,
    instanceLabel: opts.instanceLabel,
    owner: opts.owner,
    lineStart: start,
    lineEnd: end,
  });
}

export function parseTerminalPasteFromClipboard(
  clipboardData: DataTransfer,
  /** Pre-read plain text (the caller usually already read it) — avoids a second
   *  clipboard read + DOMParser pass on a large rich-text paste. */
  preReadPlainText?: string,
): FileAttachment | null {
  const json = clipboardData.getData(ATLARIX_TERMINAL_CLIPBOARD_MIME);
  if (json) {
    try {
      const payload = JSON.parse(json) as AtlarixTerminalClipboardPayload;
      if (payload.content?.trim()) {
        const lines = parsePlainTextToTerminalLines(payload.content);
        return buildTerminalPasteAttachment({
          lines,
          instanceLabel: payload.instanceLabel,
          owner: payload.owner,
          lineStart: payload.lineStart,
          lineEnd: payload.lineEnd,
        });
      }
    } catch {
      // fall through
    }
  }

  const plainText = preReadPlainText ?? readClipboardPlainText(clipboardData);
  if (!plainText?.trim() || !looksLikeTerminalTranscript(plainText)) {
    return null;
  }

  const parsed = parsePlainTextToTerminalLines(plainText);
  const visibleFull = linesToVisibleText(parsed);
  const { start, end } = terminalSelectionLineRange(
    parsed,
    plainText,
    visibleFull,
  );
  const slice = parsed.slice(start - 1, end);
  const owner: TerminalPasteOwner = parsed.some((l) => l.prefix === "[Agent]")
    ? "agent"
    : "user";
  return buildTerminalPasteAttachment({
    lines: slice.length > 0 ? slice : parsed,
    instanceLabel: owner === "agent" ? "Agent" : "Shell",
    owner,
    lineStart: start,
    lineEnd: end,
  });
}

/**
 * Write a terminal selection synchronously onto a `copy` event's DataTransfer.
 *
 * The caller must `preventDefault()` the copy event. Same rationale as
 * `writeCodeToDataTransfer`: a custom MIME placed via the async
 * `navigator.clipboard.write([ClipboardItem])` does not survive to a
 * paste-event `getData(mime)` here, but a synchronous `setData` on the live
 * copy event does — so the terminal chip round-trips. `text/plain` keeps an
 * ordinary paste elsewhere yielding the transcript text.
 */
export function writeTerminalToDataTransfer(
  dataTransfer: DataTransfer,
  payload: AtlarixTerminalClipboardPayload,
): void {
  dataTransfer.setData("text/plain", payload.content);
  dataTransfer.setData(
    ATLARIX_TERMINAL_CLIPBOARD_MIME,
    JSON.stringify(payload),
  );
}

export function attachmentTerminalKey(att: FileAttachment): string | null {
  if (!att.terminalPaste) return null;
  const { instanceLabel, lineStart, lineEnd } = att.terminalPaste;
  return `${instanceLabel}:${lineStart}-${lineEnd}`;
}

export function upsertTerminalAttachment(
  prev: FileAttachment[],
  next: FileAttachment,
): FileAttachment[] {
  const key = attachmentTerminalKey(next);
  if (!key) return [...prev, next];
  const filtered = prev.filter((a) => attachmentTerminalKey(a) !== key);
  return [...filtered, next];
}
