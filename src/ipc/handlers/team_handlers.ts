/**
 * Team IPC handlers — v4.0 Workforce
 */

import { ipcMain } from "electron";
import { SubscriptionManager } from "../../lib/SubscriptionManager";
import { capture as analyticsCapture } from "../../main/lib/analytics";
import { sendTeamNotificationEmail } from "../../lib/email/resend";
import {
  getMyTeam,
  getTeamByOwner,
  getTeamById,
  listTeamMembers,
  inviteMember,
  removeMember,
  getPendingInvitesForEmail,
  acceptInvite,
  rejectInvite,
  leaveTeam,
  getOwnerEmailForTeam,
  ensureWorkforceTeamIfMissing,
} from "../../lib/teams/team-service";

export function registerTeamHandlers(): void {
  ipcMain.handle("team:get", async () => {
    const user = SubscriptionManager.getCurrentUser();
    if (!user) return { team: null, error: "Not signed in" };
    if (SubscriptionManager.getEffectiveTier() !== "workforce") {
      return { team: null, error: "Workforce tier required" };
    }
    let team = await getMyTeam(user.id);
    if (!team) {
      team = await ensureWorkforceTeamIfMissing(user.id, user.email);
      if (team) {
        await SubscriptionManager.refreshPlan();
      }
    }
    return { team };
  });

  ipcMain.handle("team:list-members", async (_event, teamId: string) => {
    const user = SubscriptionManager.getCurrentUser();
    if (!user) return { members: [], error: "Not signed in" };
    const members = await listTeamMembers(teamId);
    return { members };
  });

  ipcMain.handle("team:get-pending-invites", async () => {
    const user = SubscriptionManager.getCurrentUser();
    if (!user?.email) return { invites: [], error: "Not signed in" };
    const invites = await getPendingInvitesForEmail(user.email);
    return { invites };
  });

  ipcMain.handle(
    "team:invite",
    async (_event, teamId: string, email: string) => {
      const user = SubscriptionManager.getCurrentUser();
      if (!user) return { success: false, error: "Not signed in" };
      const result = await inviteMember(teamId, email, user.id);
      if (result.success) {
        analyticsCapture("team_invite_sent", {});
        const team = await getTeamById(teamId);
        const teamName = team?.name ?? "Unknown";
        sendTeamNotificationEmail({
          type: "invite",
          to: [email.trim().toLowerCase()],
          teamName,
          inviterName: user.name,
          inviterEmail: user.email,
        }).catch(() => {});
      }
      return result;
    }
  );

  ipcMain.handle("team:accept-invite", async (_event, memberId: string) => {
    const user = SubscriptionManager.getCurrentUser();
    if (!user?.email) return { success: false, error: "Not signed in" };
    const result = await acceptInvite(memberId, user.id, user.email);
    if (result.success && result.teamId && result.teamName) {
      const ownerEmail = result.ownerUserId ? await getOwnerEmailForTeam(result.teamId) : null;
      if (ownerEmail) {
        sendTeamNotificationEmail({
          type: "accepted_owner",
          to: [ownerEmail],
          teamName: result.teamName,
          memberNameOrEmail: result.memberEmail ?? user.email,
        }).catch(() => {});
      }
      sendTeamNotificationEmail({
        type: "accepted_invitee",
        to: [user.email],
        teamName: result.teamName,
      }).catch(() => {});
    }
    return result;
  });

  ipcMain.handle("team:reject-invite", async (_event, memberId: string) => {
    const user = SubscriptionManager.getCurrentUser();
    if (!user?.email) return { success: false, error: "Not signed in" };
    const result = await rejectInvite(memberId, user.id, user.email);
    if (result.success && result.teamId && result.teamName) {
      const ownerEmail = result.ownerUserId ? await getOwnerEmailForTeam(result.teamId) : null;
      if (ownerEmail) {
        sendTeamNotificationEmail({
          type: "rejected_owner",
          to: [ownerEmail],
          teamName: result.teamName,
          memberNameOrEmail: result.memberEmail ?? user.email,
        }).catch(() => {});
      }
      sendTeamNotificationEmail({
        type: "rejected_invitee",
        to: [user.email],
        teamName: result.teamName,
      }).catch(() => {});
    }
    return result;
  });

  ipcMain.handle("team:leave", async () => {
    const user = SubscriptionManager.getCurrentUser();
    if (!user) return { success: false, error: "Not signed in" };
    const result = await leaveTeam(user.id);
    if (result.success && result.teamId && result.teamName) {
      const ownerEmail = result.ownerUserId ? await getOwnerEmailForTeam(result.teamId) : null;
      if (ownerEmail) {
        sendTeamNotificationEmail({
          type: "left_owner",
          to: [ownerEmail],
          teamName: result.teamName,
          memberNameOrEmail: result.memberEmail ?? user.email,
        }).catch(() => {});
      }
    }
    return result;
  });

  ipcMain.handle("team:send-test-email", async () => {
    const { sendTeamEmail } = await import("../../lib/email/resend");
    const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:20px;"><p>This is a test email from Atlarix.</p><p><a href="atlarix://auth/callback">Open Atlarix</a></p><p style="font-size:12px;color:#64748b;">This email was sent automatically by Atlarix. Please do not reply to this address.</p></body></html>`;
    const result = await sendTeamEmail({
      to: ["amariah.abish@gmail.com"],
      subject: "Atlarix — Test email",
      html,
    });
    return { success: result.ok, error: result.error };
  });

  ipcMain.handle(
    "team:remove-member",
    async (_event, teamId: string, memberId: string) => {
      const user = SubscriptionManager.getCurrentUser();
      if (!user) return { success: false, error: "Not signed in" };
      const result = await removeMember(teamId, memberId);
      if (result.success) analyticsCapture("team_member_removed", {});
      return result;
    }
  );

  ipcMain.handle("team:add-seats", async () => {
    const user = SubscriptionManager.getCurrentUser();
    if (!user) return { success: false, error: "Not signed in" };
    if (SubscriptionManager.getEffectiveTier() !== "workforce") {
      return { success: false, error: "Workforce tier required" };
    }
    const team = await getTeamByOwner(user.id);
    if (!team) return { success: false, error: "Team not found" };
    if (!team.lemonsqueezy_subscription_id) {
      return { success: false, error: "No subscription linked to team" };
    }
    analyticsCapture("team_add_seats_clicked", {});
    return {
      success: false,
      error: "Add seats via Manage billing (LemonSqueezy portal). Extra seats $10/month each.",
    };
  });
}
