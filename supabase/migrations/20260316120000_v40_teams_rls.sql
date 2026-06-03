-- v4.0: Initial teams RLS (superseded on production)
-- Recursive subquery policies are replaced by 20260329140000_teams_rls_fix_recursion.sql.
-- This migration only removes legacy policy names so fresh installs do not hit recursion errors.

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "teams_owner_all" ON public.teams;
DROP POLICY IF EXISTS "teams_member_read" ON public.teams;
DROP POLICY IF EXISTS "team_members_owner_all" ON public.team_members;
DROP POLICY IF EXISTS "team_members_member_read" ON public.team_members;
