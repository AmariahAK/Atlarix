/**
 * Resend email — team invite and status notifications (main process only).
 * Uses RESEND_API_KEY and EMAIL_SOURCE from build config. No-op if unset.
 */

import log from "electron-log";
import { buildConfig } from "@/generated/build-config";

const logger = log.scope("resend");

const APP_LINK = "atlarix://auth/callback";
const FOOTER =
  "This email was sent automatically by Atlarix. Please do not reply to this address.";

const PRIMARY = "#0f172a";
const BORDER = "#e2e8f0";
const MUTED = "#64748b";

function wrapBody(content: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;padding:24px;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid ${BORDER};border-radius:8px;overflow:hidden;">
    <div style="background:${PRIMARY};color:#fff;padding:16px 20px;">
      <span style="font-weight:600;font-size:18px;">Atlarix</span>
    </div>
    <div style="padding:24px 20px;">
      ${content}
    </div>
    <div style="padding:12px 20px;border-top:1px solid ${BORDER};font-size:12px;color:${MUTED};">
      ${FOOTER}
    </div>
  </div>
</body>
</html>`;
}

function ctaButton(text: string): string {
  return `<p style="margin:24px 0 0;"><a href="${APP_LINK}" style="display:inline-block;background:${PRIMARY};color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:500;">${text}</a></p>`;
}

export type TeamEmailType =
  | "invite"
  | "accepted_owner"
  | "accepted_invitee"
  | "rejected_owner"
  | "rejected_invitee"
  | "left_owner";

export interface TeamEmailParams {
  type: TeamEmailType;
  to: string[];
  teamName: string;
  inviterName?: string;
  inviterEmail?: string;
  memberNameOrEmail?: string;
}

function buildHtml(params: TeamEmailParams): string {
  const { type, teamName, inviterName, inviterEmail, memberNameOrEmail } = params;
  const inviter = inviterName || inviterEmail || "A team owner";
  let content = "";
  switch (type) {
    case "invite":
      content = `<p style="margin:0;color:${PRIMARY};font-size:16px;">You've been invited to <strong>${escapeHtml(teamName)}</strong> by <strong>${escapeHtml(inviter)}</strong>.</p><p style="margin:16px 0 0;color:${MUTED};font-size:14px;">Open Atlarix to accept or reject the invite.</p>${ctaButton("Open Atlarix")}`;
      break;
    case "accepted_owner":
      content = `<p style="margin:0;color:${PRIMARY};font-size:16px;"><strong>${escapeHtml(memberNameOrEmail ?? "A member")}</strong> has accepted your invite and joined <strong>${escapeHtml(teamName)}</strong>.</p>${ctaButton("Open Atlarix")}`;
      break;
    case "accepted_invitee":
      content = `<p style="margin:0;color:${PRIMARY};font-size:16px;">You've joined <strong>${escapeHtml(teamName)}</strong>.</p><p style="margin:16px 0 0;color:${MUTED};font-size:14px;">Open Atlarix to get started.</p>${ctaButton("Open Atlarix")}`;
      break;
    case "rejected_owner":
      content = `<p style="margin:0;color:${PRIMARY};font-size:16px;"><strong>${escapeHtml(memberNameOrEmail ?? "Someone")}</strong> has declined the invite to <strong>${escapeHtml(teamName)}</strong>.</p>${ctaButton("Open Atlarix")}`;
      break;
    case "rejected_invitee":
      content = `<p style="margin:0;color:${PRIMARY};font-size:16px;">You've declined the invite to <strong>${escapeHtml(teamName)}</strong>.</p>${ctaButton("Open Atlarix")}`;
      break;
    case "left_owner":
      content = `<p style="margin:0;color:${PRIMARY};font-size:16px;"><strong>${escapeHtml(memberNameOrEmail ?? "A member")}</strong> has left <strong>${escapeHtml(teamName)}</strong>.</p>${ctaButton("Open Atlarix")}`;
      break;
    default:
      content = `<p style="margin:0;">Team update for ${escapeHtml(teamName)}.</p>${ctaButton("Open Atlarix")}`;
  }
  return wrapBody(content);
}

function getSubject(params: TeamEmailParams): string {
  const { type, teamName, inviterName, inviterEmail, memberNameOrEmail } = params;
  const inviter = inviterName || inviterEmail || "A team owner";
  switch (type) {
    case "invite":
      return `You're invited to ${teamName} on Atlarix`;
    case "accepted_owner":
      return `${memberNameOrEmail ?? "A member"} joined ${teamName}`;
    case "accepted_invitee":
      return `You've joined ${teamName} on Atlarix`;
    case "rejected_owner":
      return `${memberNameOrEmail ?? "Someone"} declined your invite to ${teamName}`;
    case "rejected_invitee":
      return `You declined the invite to ${teamName}`;
    case "left_owner":
      return `${memberNameOrEmail ?? "A member"} left ${teamName}`;
    default:
      return `Atlarix team update: ${teamName}`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Send a single email via Resend REST API.
 * No-op if RESEND_API_KEY or EMAIL_SOURCE is missing (logs only).
 */
export async function sendTeamEmail(params: {
  to: string[];
  subject: string;
  html: string;
}): Promise<{ ok: boolean; error?: string }> {
  const apiKey = buildConfig.RESEND_API_KEY;
  const from = buildConfig.EMAIL_SOURCE;
  if (!apiKey || !from) {
    logger.warn("[Resend] Missing RESEND_API_KEY or EMAIL_SOURCE, skipping send");
    return { ok: false, error: "Resend not configured" };
  }
  if (!params.to.length) {
    return { ok: false, error: "No recipients" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: params.to,
        subject: params.subject,
        html: params.html,
      }),
    });
    const data = (await res.json()) as { id?: string; message?: string };
    if (!res.ok) {
      logger.warn("[Resend] Send failed:", res.status, data);
      return { ok: false, error: data.message || String(res.status) };
    }
    logger.log("[Resend] Sent:", data.id);
    return { ok: true };
  } catch (err) {
    logger.error("[Resend] Send exception:", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Build and send a team notification email (invite, accepted, rejected, left).
 * Fire-and-forget: errors are logged, not thrown.
 */
export async function sendTeamNotificationEmail(params: TeamEmailParams): Promise<void> {
  const html = buildHtml(params);
  const subject = getSubject(params);
  const result = await sendTeamEmail({ to: params.to, subject, html });
  if (!result.ok) {
    logger.warn("[Resend] Team email failed:", params.type, result.error);
  }
}
