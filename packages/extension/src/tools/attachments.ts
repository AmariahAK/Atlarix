/**
 * `read_attachment` — the rest of a file the message only previewed.
 *
 * THE POINT IS THAT NOTHING IS TRUNCATED. The message carries the first 1,500
 * characters and an id; everything past that is here, a page at a time, for as
 * many pages as the model wants. A cap on a page is not a cap on a file — and
 * the difference matters, because a truncated attachment is one the model
 * answers confidently and wrongly about, having been shown the first third of a
 * spreadsheet and told nothing.
 *
 * SCOPE COMES FROM THE HARNESS, NOT THE MODEL. `ctx.sessionId` is injected by
 * the panel and is not a parameter — so a conversation can only read its own
 * files, and no prompt injected into a page can widen that. The desktop enforces
 * the same rule with a filter at read time; here it is the key prefix, which
 * cannot be forgotten at a call site.
 */

import {
  DEFAULT_PAGE_LINES,
  getAttachment,
  listAttachments,
  pageOf,
} from "../attachments/store";
import type { ToolContext, ToolOutcome } from "./dispatch";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number.parseInt(str(v), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function readAttachmentTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const id = str(args.attachmentId).trim();

  // The happy path is ONE keyed read. `listAttachments` scans the whole of
  // `storage.local` — every transcript and archive included — so doing it up
  // front would put that scan on every successful call as well. It belongs on
  // the path that actually needs it.
  const file = id ? await getAttachment(ctx.sessionId, id) : null;

  if (!file) {
    // A MISSING ID ANSWERS WITH THE REAL ONES. Told only "not found", a model
    // that mistyped an id asks the user to attach the file again — the single
    // thing the system prompt tells it not to do, because it is already here.
    const attached = await listAttachments(ctx.sessionId);
    if (attached.length === 0) {
      return {
        content:
          "Nothing is attached to this conversation. Ask the user to attach " +
          "the file rather than guessing at its contents.",
        label: "No attachments",
      };
    }
    const list = attached
      .map((a) => `- ${a.name} | id: ${a.id} | ${a.body.length} chars`)
      .join("\n");
    return {
      content:
        (id
          ? `There is no attachment with id "${id}" in this conversation.`
          : "Pass `attachmentId`.") + `\n\nAttached here:\n${list}`,
      label: "Attachment not found",
    };
  }

  const offset = num(args.offset, 1);
  const limit = num(args.limit, DEFAULT_PAGE_LINES);
  const page = pageOf(file.body, offset, limit);

  const header =
    `${file.name} — lines ${page.startLine}–${page.endLine} of ${page.totalLines}` +
    ` (${file.body.length} chars total)`;

  // THE NEXT CALL IS SPELLED OUT rather than implied. The desktop does this and
  // it is the difference between a model that pages through a file and one that
  // reads page one, says "the file continues", and stops.
  const more = page.hasMore
    ? `\n\n[${page.totalLines - page.endLine} more lines. Continue with ` +
      `read_attachment({ "attachmentId": "${file.id}", "offset": ${page.endLine + 1} })]`
    : "\n\n[End of file.]";

  return {
    content: `${header}\n\n${page.text}${more}`,
    label:
      page.startLine === 1 && !page.hasMore
        ? `Read ${file.name}`
        : `Read ${file.name} (lines ${page.startLine}–${page.endLine})`,
  };
}
