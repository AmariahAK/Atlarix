/**
 * Handing Console / Network output to chat.
 *
 * Both panels used to concatenate their text straight into the composer at any
 * size, so sending a busy tab buried whatever the user was typing under
 * thousands of lines of raw log. The Terminal panel already solved this — a
 * selection becomes an attachment CHIP, and the body only travels on send — and
 * the Automations tab does the same for a fired event.
 *
 * This reuses the existing `textPaste` attachment kind rather than adding a
 * fourth. That is not only less surface: every place an attachment has to be
 * recognised — the composer list, the sent-message display, and BOTH per-kind
 * branches in `SimpleMessage` — already handles `textPaste`, so a browser log
 * survives message editing for free. A new kind would have had to be registered
 * in each of those, and the one that gets forgotten renders as raw text, which
 * is the very bug being fixed.
 *
 * A SHORT send still goes inline as text: a single console row is smaller than
 * the chip that would represent it, and pushing one line behind an expand
 * affordance is worse than just showing it.
 */

import type { FileAttachment } from "@/ipc/ipc_types";
import { extractDomain } from "@/lib/format-url";
import { shouldCaptureAsTextPaste } from "@/lib/chat/text-paste-attachment";

export type BrowserLogSource = "Console" | "Network";

/**
 * Big enough to be worth a chip? Reuses the composer's own long-paste rule
 * (>500 chars or >20 lines) so a browser log and a clipboard paste of the same
 * size behave identically — one threshold to reason about, not two.
 */
export function shouldAttachBrowserLog(text: string): boolean {
  return shouldCaptureAsTextPaste(text);
}

/**
 * Stable per (source, scope) so clicking the same card twice REPLACES its chip
 * instead of stacking a second copy. Scope is the page load or row the send came
 * from, so two different tabs still produce two chips.
 */
export function browserLogAttachmentId(
  source: BrowserLogSource,
  scopeKey: string,
): string {
  return `browser-log-${source.toLowerCase()}-${scopeKey}`;
}

/** `https://www.youtube.com/watch?v=x` → `youtube.com`; non-URLs pass through. */
function shortLabel(label: string): string {
  const domain = extractDomain(label.trim());
  return domain.length > 40 ? `${domain.slice(0, 39)}…` : domain;
}

export function browserLogDisplayName(
  source: BrowserLogSource,
  label: string,
  count: number,
): string {
  const unit =
    source === "Network"
      ? `${count} request${count === 1 ? "" : "s"}`
      : `${count} ${count === 1 ? "entry" : "entries"}`;
  return `${source} · ${shortLabel(label)} · ${unit}`;
}

export function buildBrowserLogAttachment(opts: {
  source: BrowserLogSource;
  /** Page url or card title this came from — becomes the chip's name. */
  label: string;
  /** How many rows the body covers, for the chip's name. */
  count: number;
  /** The formatted rows, exactly as the panel renders them. */
  content: string;
  /** Distinguishes two sends of the same source; usually `tabId:navSeq`. */
  scopeKey: string;
}): FileAttachment {
  return {
    type: "chat-context",
    id: browserLogAttachmentId(opts.source, opts.scopeKey),
    textPaste: {
      content: opts.content,
      displayName: browserLogDisplayName(opts.source, opts.label, opts.count),
    },
  };
}

/** Replace an existing chip with the same id; otherwise append. */
export function upsertBrowserLogAttachment(
  prev: FileAttachment[],
  next: FileAttachment,
): FileAttachment[] {
  if (!next.id) return [...prev, next];
  const filtered = prev.filter((a) => a.id !== next.id);
  return [...filtered, next];
}
