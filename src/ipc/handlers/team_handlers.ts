/**
 * Team IPC handlers — v4.0 Workforce
 */

import { ipcMain } from "electron";
import { SubscriptionManager } from "../../lib/SubscriptionManager";
import { capture as analyticsCapture } from "../../main/lib/analytics";
import {
  getMyTeam,
  getTeamByOwner,
  listTeamMembers,
  inviteMember,
  removeMember,
} from "../../lib/teams/team-service";

export function registerTeamHandlers(): void {
  ipcMain.handle("team:get", async () => {
    const user = SubscriptionManager.getCurrentUser();
    if (!user) return { team: null, error: "Not signed in" };
    if (SubscriptionManager.getEffectiveTier() !== "workforce") {
      return { team: null, error: "Workforce tier required" };
    }
    const team = await getMyTeam(user.id);
    return { team };
  });

  ipcMain.handle("team:list-members", async (_event, teamId: string) => {
    const user = SubscriptionManager.getCurrentUser();
    if (!user) return { members: [], error: "Not signed in" };
    const members = await listTeamMembers(teamId);
    return { members };
  });

  ipcMain.handle(
    "team:invite",
    async (_event, teamId: string, email: string) => {
      const user = SubscriptionManager.getCurrentUser();
      if (!user) return { success: false, error: "Not signed in" };
      const result = await inviteMember(teamId, email, user.id);
      if (result.success) analyticsCapture("team_invite_sent", {});
      return result;
    }
  );

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
