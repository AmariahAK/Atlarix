/**
 * Mention chips for a SENT user message, with click-to-preview.
 *
 * WHY: the composer already shows an `@file:`/`@dir:` pick as a chip
 * (`AttachmentsList` → `MentionAttachmentChip`), but on send `mentionToken()`
 * re-emits `@file:<relpath>` into the prompt — required, because the server needs it
 * for `parseContextMentions → extractMentionedContext`. Nothing turned it back into
 * a chip for display, so a message composed by picking a file rendered as the raw
 * string `@file:text.txt`: the attachment looked like text and could not be previewed.
 *
 * Preview reads the file ON DEMAND via `file:read-content` rather than from the
 * message. Mentions deliberately carry no base64 blob (see mention-attachment.ts),
 * so there is nothing stored to show — but the file is in the workspace, so it can
 * simply be read when asked for.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";
import { mentionDisplayName, type ParsedMention } from "@/lib/chat/mention-attachment";
import { cn } from "@/lib/utils";

/** Long files are clipped in the preview; read_attachment/the agent see the whole file. */
const PREVIEW_CHAR_LIMIT = 4000;

function MentionChip({ mention }: { mention: ParsedMention }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const Icon = mention.kind === "dir" ? Folder : File;
  const label = mentionDisplayName(mention.kind, mention.relpath);
  // A directory mention contributes a LISTING, not contents — there is no single
  // file to show, so it stays a non-expandable badge rather than a dead toggle.
  const expandable = mention.kind === "file";

  const toggle = async () => {
    if (!expandable) return;
    const next = !open;
    setOpen(next);
    if (!next || content !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await IpcClient.getInstance().readFileContent(mention.relpath);
      const text = typeof result?.content === "string" ? result.content : "";
      setContent(
        text.length > PREVIEW_CHAR_LIMIT
          ? `${text.slice(0, PREVIEW_CHAR_LIMIT)}\n\n… clipped (${text.length} chars total)`
          : text,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-full">
      <button
        type="button"
        onClick={toggle}
        disabled={!expandable}
        title={expandable ? `Preview ${label}` : label}
        className={cn(
          "flex items-center gap-1.5 rounded-md border border-border/80",
          "bg-muted/70 dark:bg-muted/40 px-2 py-1 max-w-[260px] text-left",
          expandable && "hover:bg-muted",
          !expandable && "cursor-default",
        )}
      >
        {expandable ? (
          open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          )
        ) : null}
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs text-foreground/90">{label}</span>
        <span className="rounded border border-border/60 bg-background/80 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
          {mention.kind === "dir" ? "Folder" : "File"}
        </span>
      </button>

      {open ? (
        <div className="mt-1 max-h-64 overflow-auto rounded-md border border-border/60 bg-background/60 p-2">
          {loading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : error ? (
            // Say why. The file may have been moved or deleted since it was sent,
            // which is worth distinguishing from "preview is broken".
            <p className="text-xs text-destructive">Could not read this file: {error}</p>
          ) : (
            <pre className="whitespace-pre-wrap break-words text-[11px] leading-snug text-foreground/80">
              {content || "(empty file)"}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function SentMentionChips({ mentions }: { mentions: ParsedMention[] }) {
  if (mentions.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-col gap-1.5 items-start">
      {mentions.map((m) => (
        <MentionChip key={`${m.kind}:${m.relpath}`} mention={m} />
      ))}
    </div>
  );
}
