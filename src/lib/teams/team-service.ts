/**
 * Team Service — v4.0 Workforce
 * Uses Supabase with user session (RLS applies).
 */

import { getSupabaseClient } from "../auth/supabase-client";
import log from "electron-log";

const logger = log.scope("team-service");

export interface Team {
  id: string;
  name: string;
  owner_user_id: string;
  lemonsqueezy_subscription_id: string | null;
  seat_limit: number;
  extra_seats: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string | null;
  email: string;
  status: string;
  role: string;
  invited_by: string | null;
  joined_at: string | null;
  created_at: string;
}

/**
 * Workforce subscriber but no teams row yet (e.g. webhook lag or plan vs effective_tier mismatch).
 * Creates a team owned by this user; RLS allows INSERT when owner_user_id = auth.uid().
 * Skips if the user is already an active member of a team (avoid a second personal team for seat members).
 */
export async function ensureWorkforceTeamIfMissing(
  userId: string,
  userEmail: string,
): Promise<Team | null> {
  const existing = await getMyTeam(userId);
  if (existing) return existing;

  const supabase = getSupabaseClient();

  const { data: activeMember, error: memErr } = await supabase
    .from("team_members")
    .select("team_id")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (!memErr && activeMember?.team_id) {
    const asMemberTeam = await getTeamById(activeMember.team_id);
    if (asMemberTeam) return asMemberTeam;
    logger.warn(
      "[team-service] Active team_members row but teams row missing/unreadable; not auto-creating a second team",
    );
    return null;
  }

  const { data: userRow, error: uErr } = await supabase
    .from("users")
    .select("plan, effective_tier, lemon_subscription_id")
    .eq("id", userId)
    .maybeSingle();

  if (uErr || !userRow) {
    return null;
  }

  const plan = String(userRow.plan ?? "free");
  const eff = String(userRow.effective_tier ?? plan);
  const hasSub = !!userRow.lemon_subscription_id;

  const workforceEntitled = plan === "workforce" || eff === "workforce";
  if (!workforceEntitled) {
    return null;
  }

  // Seat member: free plan row + workforce effective tier + no own subscription — do not create a personal org
  if (plan === "free" && eff === "workforce" && !hasSub) {
    return null;
  }

  const owned = await getTeamByOwner(userId);
  if (owned) return owned;

  const local = (userEmail || "team").split("@")[0] || "My";
  const { data: inserted, error: insErr } = await supabase
    .from("teams")
    .insert({
      name: `Team ${local}`,
      owner_user_id: userId,
      lemonsqueezy_subscription_id: userRow.lemon_subscription_id ?? null,
      seat_limit: 5,
      extra_seats: 0,
      active: true,
    })
    .select("*")
    .single();

  if (insErr) {
    logger.warn("[team-service] ensureWorkforceTeamIfMissing:", insErr.message);
    return null;
  }
  return inserted as Team;
}

export async function getMyTeam(userId: string): Promise<Team | null> {
  try {
    const supabase = getSupabaseClient();
    const asOwner = await getTeamByOwner(userId);
    if (asOwner) return asOwner;
    const { data: memberRow } = await supabase
      .from("team_members")
      .select("team_id")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();
    if (!memberRow?.team_id) return null;
    const { data: team } = await supabase
      .from("teams")
      .select("*")
      .eq("id", memberRow.team_id)
      .eq("active", true)
      .maybeSingle();
    return team as Team | null;
  } catch (err) {
    logger.error("[team-service] getMyTeam exception:", err);
    return null;
  }
}

export async function getTeamByOwner(ownerUserId: string): Promise<Team | null> {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("teams")
      .select("*")
      .eq("owner_user_id", ownerUserId)
      .eq("active", true)
      .maybeSingle();

    if (error) {
      logger.warn("[team-service] getTeamByOwner error:", error.message);
      return null;
    }
    return data as Team | null;
  } catch (err) {
    logger.error("[team-service] getTeamByOwner exception:", err);
    return null;
  }
}

export async function getTeamById(teamId: string): Promise<Team | null> {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("teams")
      .select("*")
      .eq("id", teamId)
      .eq("active", true)
      .maybeSingle();

    if (error) {
      logger.warn("[team-service] getTeamById error:", error.message);
      return null;
    }
    return data as Team | null;
  } catch (err) {
    logger.error("[team-service] getTeamById exception:", err);
    return null;
  }
}

export interface PendingInvite {
  memberId: string;
  teamId: string;
  teamName: string;
  inviterEmail: string | null;
}

export async function getPendingInvitesForEmail(email: string): Promise<PendingInvite[]> {
  try {
    const supabase = getSupabaseClient();
    const normalized = email.trim().toLowerCase();
    const { data: rows, error } = await supabase
      .from("team_members")
      .select("id, team_id, invited_by")
      .eq("email", normalized)
      .eq("status", "pending");

    if (error) {
      logger.warn("[team-service] getPendingInvitesForEmail error:", error.message);
      return [];
    }
    if (!rows?.length) return [];

    const teamIds = [...new Set(rows.map((r) => r.team_id))];
    const { data: teams } = await supabase
      .from("teams")
      .select("id, name")
      .in("id", teamIds);
    const teamMap = new Map((teams ?? []).map((t) => [t.id, t.name]));

    const inviterIds = [...new Set(rows.map((r) => r.invited_by).filter(Boolean) as string[])];
    let inviterMap = new Map<string, string>();
    if (inviterIds.length > 0) {
      const { data: users } = await supabase
        .from("users")
        .select("id, email")
        .in("id", inviterIds);
      inviterMap = new Map((users ?? []).map((u) => [u.id, u.email ?? ""]));
    }

    return rows.map((r) => ({
      memberId: r.id,
      teamId: r.team_id,
      teamName: teamMap.get(r.team_id) ?? "Unknown",
      inviterEmail: (r.invited_by && inviterMap.get(r.invited_by)) ?? null,
    }));
  } catch (err) {
    logger.error("[team-service] getPendingInvitesForEmail exception:", err);
    return [];
  }
}

export interface AcceptRejectResult {
  success: boolean;
  error?: string;
  teamId?: string;
  teamName?: string;
  ownerUserId?: string;
  memberEmail?: string;
}

export async function acceptInvite(
  memberId: string,
  userId: string,
  userEmail: string
): Promise<AcceptRejectResult> {
  try {
    const supabase = getSupabaseClient();
    const { data: row, error: fetchErr } = await supabase
      .from("team_members")
      .select("id, team_id, email, status")
      .eq("id", memberId)
      .single();

    if (fetchErr || !row || row.status !== "pending") {
      return { success: false, error: "Invite not found or already used" };
    }
    if (row.email.toLowerCase() !== userEmail.trim().toLowerCase()) {
      return { success: false, error: "This invite was sent to a different email" };
    }

    const { error: updateErr } = await supabase
      .from("team_members")
      .update({
        status: "active",
        user_id: userId,
        joined_at: new Date().toISOString(),
      })
      .eq("id", memberId);

    if (updateErr) {
      logger.warn("[team-service] acceptInvite update error:", updateErr.message);
      return { success: false, error: updateErr.message };
    }

    const team = await getTeamById(row.team_id);
    if (!team) return { success: true, teamId: row.team_id, teamName: "Unknown", ownerUserId: undefined, memberEmail: row.email };

    const { error: userUpdateErr } = await supabase
      .from("users")
      .update({ team_id: team.id, effective_tier: "workforce" })
      .eq("id", userId);

    if (userUpdateErr) {
      logger.warn("[team-service] acceptInvite user update error:", userUpdateErr.message);
    }

    return {
      success: true,
      teamId: team.id,
      teamName: team.name,
      ownerUserId: team.owner_user_id,
      memberEmail: row.email,
    };
  } catch (err) {
    logger.error("[team-service] acceptInvite exception:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function rejectInvite(
  memberId: string,
  userId: string,
  userEmail: string
): Promise<AcceptRejectResult> {
  try {
    const supabase = getSupabaseClient();
    const { data: row, error: fetchErr } = await supabase
      .from("team_members")
      .select("id, team_id, email, status")
      .eq("id", memberId)
      .single();

    if (fetchErr || !row || row.status !== "pending") {
      return { success: false, error: "Invite not found or already used" };
    }
    if (row.email.toLowerCase() !== userEmail.trim().toLowerCase()) {
      return { success: false, error: "This invite was sent to a different email" };
    }

    const { error: updateErr } = await supabase
      .from("team_members")
      .update({ status: "removed" })
      .eq("id", memberId);

    if (updateErr) {
      logger.warn("[team-service] rejectInvite error:", updateErr.message);
      return { success: false, error: updateErr.message };
    }

    const team = await getTeamById(row.team_id);
    return {
      success: true,
      teamId: team?.id ?? row.team_id,
      teamName: team?.name ?? "Unknown",
      ownerUserId: team?.owner_user_id,
      memberEmail: row.email,
    };
  } catch (err) {
    logger.error("[team-service] rejectInvite exception:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function leaveTeam(userId: string): Promise<AcceptRejectResult> {
  try {
    const supabase = getSupabaseClient();
    const { data: memberRow, error: findErr } = await supabase
      .from("team_members")
      .select("id, team_id, email")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();

    if (findErr || !memberRow) {
      return { success: false, error: "You are not in a team" };
    }

    const { error: updateErr } = await supabase
      .from("team_members")
      .update({ status: "removed" })
      .eq("id", memberRow.id);

    if (updateErr) {
      logger.warn("[team-service] leaveTeam error:", updateErr.message);
      return { success: false, error: updateErr.message };
    }

    const { data: userRow } = await supabase
      .from("users")
      .select("plan")
      .eq("id", userId)
      .single();

    const fallbackTier = (userRow?.plan as string) ?? "free";
    const { error: userUpdateErr } = await supabase
      .from("users")
      .update({ team_id: null, effective_tier: fallbackTier })
      .eq("id", userId);

    if (userUpdateErr) {
      logger.warn("[team-service] leaveTeam user update error:", userUpdateErr.message);
    }

    const team = await getTeamById(memberRow.team_id);
    return {
      success: true,
      teamId: team?.id ?? memberRow.team_id,
      teamName: team?.name ?? "Unknown",
      ownerUserId: team?.owner_user_id,
      memberEmail: memberRow.email,
    };
  } catch (err) {
    logger.error("[team-service] leaveTeam exception:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function getOwnerEmailForTeam(teamId: string): Promise<string | null> {
  try {
    const supabase = getSupabaseClient();
    const { data: team } = await supabase
      .from("teams")
      .select("owner_user_id")
      .eq("id", teamId)
      .single();
    if (!team?.owner_user_id) return null;
    const { data: user } = await supabase
      .from("users")
      .select("email")
      .eq("id", team.owner_user_id)
      .single();
    return user?.email ?? null;
  } catch (err) {
    logger.error("[team-service] getOwnerEmailForTeam exception:", err);
    return null;
  }
}

export async function listTeamMembers(teamId: string): Promise<TeamMember[]> {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("team_members")
      .select("*")
      .eq("team_id", teamId)
      .order("created_at", { ascending: true });

    if (error) {
      logger.warn("[team-service] listTeamMembers error:", error.message);
      return [];
    }
    return (data ?? []) as TeamMember[];
  } catch (err) {
    logger.error("[team-service] listTeamMembers exception:", err);
    return [];
  }
}

export async function inviteMember(
  teamId: string,
  email: string,
  invitedByUserId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = getSupabaseClient();
    const { data: team } = await supabase.from("teams").select("seat_limit, extra_seats").eq("id", teamId).single();
    if (!team) return { success: false, error: "Team not found" };

    const { data: members } = await supabase
      .from("team_members")
      .select("id")
      .eq("team_id", teamId)
      .in("status", ["pending", "active"]);

    const totalSeats = (team.seat_limit ?? 5) + (team.extra_seats ?? 0);
    if ((members?.length ?? 0) >= totalSeats) {
      return { success: false, error: "No seats available. Add more seats for $10/month each." };
    }

    const { error } = await supabase.from("team_members").insert({
      team_id: teamId,
      email: email.trim().toLowerCase(),
      status: "pending",
      role: "member",
      invited_by: invitedByUserId,
    });

    if (error) {
      logger.warn("[team-service] inviteMember error:", error.message);
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err) {
    logger.error("[team-service] inviteMember exception:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function removeMember(teamId: string, memberId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from("team_members")
      .update({ status: "removed" })
      .eq("id", memberId)
      .eq("team_id", teamId);

    if (error) {
      logger.warn("[team-service] removeMember error:", error.message);
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err) {
    logger.error("[team-service] removeMember exception:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
