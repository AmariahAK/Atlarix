import type { FileAttachment } from "@/ipc/ipc_types";
import { escapeXmlAttr } from "@/lib/chat/attachment-tag-blocks";

/**
 * C3 — background-job reference chips. From the background-jobs UI a user can
 * "send to chat" a running job; it appears as an `id-<jobId>` chip (like terminal
 * / code-selection chips). The model receives the job id, command, and the
 * output tail so the user can ask about a slow/stuck job.
 */
export type BackgroundJobAttachment = FileAttachment & {
  backgroundJob: NonNullable<FileAttachment["backgroundJob"]>;
};

export function isBackgroundJobAttachment(
  attachment: FileAttachment,
): attachment is BackgroundJobAttachment {
  return Boolean(attachment.backgroundJob?.jobId);
}

/** Human chip label — matches the terminal copy/paste convention `id-<jobId>`. */
export function backgroundJobDisplayName(jobId: string): string {
  return `id-${jobId}`;
}

/** Model-facing block: job id + command + current output tail. */
export function buildBackgroundJobModelBlock(att: BackgroundJobAttachment): string {
  const { jobId, command, outputTail } = att.backgroundJob;
  return [
    `<atlarix-background-job job_id="${escapeXmlAttr(jobId)}" command="${escapeXmlAttr(command)}">`,
    outputTail?.trim() ? outputTail : "(no output captured yet)",
    "</atlarix-background-job>",
  ].join("\n");
}

/** Display-only stub (the chip already shows the job id). */
export function buildBackgroundJobDisplayBlock(att: BackgroundJobAttachment): string {
  return `<atlarix-background-job job_id="${escapeXmlAttr(att.backgroundJob.jobId)}" />`;
}
