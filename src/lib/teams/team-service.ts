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

    const totalSeats = (team.seat_limit ?? 20) + (team.extra_seats ?? 0);
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
