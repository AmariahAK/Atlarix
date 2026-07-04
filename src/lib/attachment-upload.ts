import path from "node:path";
import type { AttachmentData } from "@/lib/attachment-store";
import { preExtractPdfFromBase64 } from "@/lib/attachment-pdf-extract";
import { AttachmentStore } from "@/lib/attachment-store";

/**
 * Build attachment record. v14.8.11: PDF pre-extraction moved OFF the send
 * path — it used to block the turn's preflight for the full parse of every
 * attached PDF (user-felt as "drag-and-drop attachments start slower than
 * pastes"). It now runs fire-and-forget in the background; if the model calls
 * read_attachment before it lands, the tool extracts on demand and caches
 * (W3 extractCache) — same result, nothing blocks.
 */
export async function buildAttachmentRecord(params: {
  id: string;
  filename: string;
  mimeType: string;
  base64Data: string;
  size: number;
}): Promise<AttachmentData> {
  const record: AttachmentData = {
    id: params.id,
    filename: params.filename,
    mimeType: params.mimeType,
    data: params.base64Data,
    size: params.size,
    addedAt: Date.now(),
  };
  if (path.extname(params.filename).toLowerCase() === ".pdf") {
    void preExtractPdfFromBase64(params.base64Data)
      .then((extract) => {
        // Attach to the LIVE store record (the caller has usually added it by
        // now); also set on the local record in case add() happens after.
        const live = AttachmentStore.get(params.id);
        if (live && !live.pdfExtract) live.pdfExtract = extract;
        if (!record.pdfExtract) record.pdfExtract = extract;
      })
      .catch(() => {
        // Best-effort — read_attachment extracts on demand either way.
      });
  }
  return record;
}
