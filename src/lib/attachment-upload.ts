import path from "node:path";
import type { AttachmentData } from "@/lib/attachment-store";
import { preExtractPdfFromBase64 } from "@/lib/attachment-pdf-extract";

/** Build attachment record; pre-extract PDF text once at upload time. */
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
    record.pdfExtract = await preExtractPdfFromBase64(params.base64Data);
  }
  return record;
}
