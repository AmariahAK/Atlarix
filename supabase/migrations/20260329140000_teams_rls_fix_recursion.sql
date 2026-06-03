-- =============================================================================
-- Fix: infinite recursion between teams and team_members RLS policies
-- =============================================================================
-- Postgres error: "infinite recursion detected in policy for relation teams"
-- Cause: teams_member_read queried team_members; team_members_owner_all queried teams.
-- Fix: SECURITY DEFINER helpers read underlying rows without re-entering RLS.
-- Run in Supabase SQL Editor after v40 teams migrations if you see recursion errors.
-- =============================================================================

CREATE OR REPLACE FUNCTION public._teams_is_owner(uid uuid, team_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.teams t
    WHERE t.id = team_id
      AND t.owner_user_id = uid
      AND t.active IS NOT FALSE
  );
$$;

CREATE OR REPLACE FUNCTION public._teams_is_active_member(uid uuid, team_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.team_members tm
    WHERE tm.team_id = team_id
      AND tm.user_id = uid
      AND tm.status = 'active'
  );
$$;

REVOKE ALL ON FUNCTION public._teams_is_owner(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._teams_is_owner(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public._teams_is_owner(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public._teams_is_active_member(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._teams_is_active_member(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public._teams_is_active_member(uuid, uuid) TO service_role;

DROP POLICY IF EXISTS "teams_owner_all" ON public.teams;
CREATE POLICY "teams_owner_all"
  ON public.teams
  FOR ALL
  TO authenticated
  USING (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

DROP POLICY IF EXISTS "teams_member_read" ON public.teams;
CREATE POLICY "teams_member_read"
  ON public.teams
  FOR SELECT
  TO authenticated
  USING (public._teams_is_active_member(auth.uid(), id));

DROP POLICY IF EXISTS "team_members_owner_all" ON public.team_members;
CREATE POLICY "team_members_owner_all"
  ON public.team_members
  FOR ALL
  TO authenticated
  USING (public._teams_is_owner(auth.uid(), team_id))
  WITH CHECK (public._teams_is_owner(auth.uid(), team_id));

DROP POLICY IF EXISTS "team_members_member_read" ON public.team_members;
CREATE POLICY "team_members_member_read"
  ON public.team_members
  FOR SELECT
  TO authenticated
  USING (public._teams_is_active_member(auth.uid(), team_id));
