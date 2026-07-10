-- =============================================================================
-- Security remediation: team-based entitlement escalation (SB-01 / SB-03 / SB-04)
-- =============================================================================
-- Closes the chain that let any authenticated user grant themselves 'workforce'
-- effective_tier for $0:
--   SB-03  any user could INSERT a team they own (teams_owner_all FOR ALL)
--   SB-01a a user could self-INSERT an ACTIVE team_members row (owner_all FOR ALL)
--   SB-04  an invitee could redirect a pending row's team_id to any team
--   SB-01b guard_users_sensitive_columns() validated team membership but NOT the
--          resulting effective_tier value, and used IF/ELSIF so a single UPDATE
--          changing both team_id + effective_tier skipped the tier check entirely
--
-- Strategy: teams are created ONLY by the billing webhook (service_role); the
-- team's plan is an authoritative `teams.tier` column that only service_role can
-- set; membership rows can only be created as pending invites and their team_id
-- can never be redirected; and effective_tier is validated INDEPENDENTLY against
-- the joined team's real tier. service_role / superuser bypass every guard here.
-- =============================================================================

-- 1) Authoritative team plan. Only the billing webhook (service_role) sets it.
ALTER TABLE public.teams
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'workforce';

-- Existing teams are all Workforce (the only team-tier product) — backfill.
UPDATE public.teams SET tier = 'workforce' WHERE tier IS NULL OR tier = '';

-- 2) Guard trigger on teams: a client (non service_role) may never create a team
--    or change any billing-controlled column. Renaming is allowed.
CREATE OR REPLACE FUNCTION public.guard_teams_sensitive_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  is_admin boolean := COALESCE(auth.role(), '') = 'service_role'
    OR current_user IN ('postgres', 'supabase_admin', 'service_role');
BEGIN
  IF is_admin THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'teams are created by the billing webhook only';
  END IF;

  -- UPDATE: block every billing/entitlement-controlled column (name may change).
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     OR NEW.tier IS DISTINCT FROM OLD.tier
     OR NEW.active IS DISTINCT FROM OLD.active
     OR NEW.seat_limit IS DISTINCT FROM OLD.seat_limit
     OR NEW.extra_seats IS DISTINCT FROM OLD.extra_seats
     OR NEW.lemonsqueezy_subscription_id IS DISTINCT FROM OLD.lemonsqueezy_subscription_id THEN
    RAISE EXCEPTION 'this teams column is managed by billing and cannot be changed by a client';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS teams_guard_sensitive_columns ON public.teams;
CREATE TRIGGER teams_guard_sensitive_columns
  BEFORE INSERT OR UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.guard_teams_sensitive_columns();

-- 3) teams RLS: remove blanket owner INSERT/ALL. Owners get read + (guarded)
--    update only; creation is service_role (which bypasses RLS).
DROP POLICY IF EXISTS "teams_owner_all" ON public.teams;

DROP POLICY IF EXISTS "teams_owner_select" ON public.teams;
CREATE POLICY "teams_owner_select"
  ON public.teams
  FOR SELECT
  TO authenticated
  USING (auth.uid() = owner_user_id);

DROP POLICY IF EXISTS "teams_owner_update" ON public.teams;
CREATE POLICY "teams_owner_update"
  ON public.teams
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);
-- (teams_member_read from 20260329140000 is unchanged; no INSERT policy for
--  authenticated → client team creation is denied.)

-- 4) Guard trigger on team_members: a client may only create PENDING invites
--    (never an active self-membership), can never redirect a row's team_id, and
--    can only claim a membership for their own uid.
CREATE OR REPLACE FUNCTION public.guard_team_members()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  is_admin boolean := COALESCE(auth.role(), '') = 'service_role'
    OR current_user IN ('postgres', 'supabase_admin', 'service_role');
BEGIN
  IF is_admin THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Owners invite by email: the new row must be a pending invite with no user
    -- attached. Blocks self-inserting an active membership (SB-01a).
    IF NEW.status IS DISTINCT FROM 'pending' OR NEW.user_id IS NOT NULL THEN
      RAISE EXCEPTION 'team_members can only be created as pending invites';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: team_id is immutable for clients — closes the invite-redirect (SB-04).
  IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    RAISE EXCEPTION 'team_members.team_id cannot be changed';
  END IF;
  -- A member row can only be claimed for the acting user (accept), never reassigned.
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     AND NEW.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'team_members.user_id can only be set to yourself';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS team_members_guard ON public.team_members;
CREATE TRIGGER team_members_guard
  BEFORE INSERT OR UPDATE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_team_members();

-- 5) Rewrite the users guard: validate effective_tier INDEPENDENTLY of team_id
--    (no more IF/ELSIF skip), and pin it to the joined team's authoritative tier.
CREATE OR REPLACE FUNCTION public.guard_users_sensitive_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  jwt_role text := COALESCE(auth.role(), '');
  is_admin boolean := jwt_role = 'service_role'
    OR current_user IN ('postgres', 'supabase_admin', 'service_role');
  team_tier text;
BEGIN
  IF is_admin THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'users.id is immutable';
  END IF;
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'users.email cannot be changed via client';
  END IF;
  IF NEW.plan IS DISTINCT FROM OLD.plan THEN
    RAISE EXCEPTION 'users.plan is managed by billing webhook';
  END IF;
  IF NEW.subscription_status IS DISTINCT FROM OLD.subscription_status THEN
    RAISE EXCEPTION 'users.subscription_status is managed by billing webhook';
  END IF;
  IF NEW.subscription_ends_at IS DISTINCT FROM OLD.subscription_ends_at THEN
    RAISE EXCEPTION 'users.subscription_ends_at is managed by billing webhook';
  END IF;
  IF NEW.lemon_customer_id IS DISTINCT FROM OLD.lemon_customer_id THEN
    RAISE EXCEPTION 'users.lemon_customer_id is managed by billing webhook';
  END IF;
  IF NEW.lemon_subscription_id IS DISTINCT FROM OLD.lemon_subscription_id THEN
    RAISE EXCEPTION 'users.lemon_subscription_id is managed by billing webhook';
  END IF;
  IF NEW.lemon_variant_id IS DISTINCT FROM OLD.lemon_variant_id THEN
    RAISE EXCEPTION 'users.lemon_variant_id is managed by billing webhook';
  END IF;
  IF NEW.customer_portal_url IS DISTINCT FROM OLD.customer_portal_url THEN
    RAISE EXCEPTION 'users.customer_portal_url is managed by billing webhook';
  END IF;
  IF NEW.has_db_studio_legacy IS DISTINCT FROM OLD.has_db_studio_legacy THEN
    RAISE EXCEPTION 'users.has_db_studio_legacy is managed by billing webhook';
  END IF;

  -- team_id may only point to a team where the caller is an ACTIVE member,
  -- and can only be cleared when actually leaving one.
  IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    IF NEW.team_id IS NOT NULL THEN
      IF NOT public._teams_is_active_member(NEW.id, NEW.team_id) THEN
        RAISE EXCEPTION 'users.team_id can only change when you are an active member of that team';
      END IF;
    ELSIF OLD.team_id IS NULL THEN
      RAISE EXCEPTION 'users.team_id cannot be cleared without leaving a team';
    END IF;
  END IF;

  -- effective_tier is validated on its OWN, so a combined team_id+effective_tier
  -- UPDATE can never slip the tier through unchecked (SB-01b). In a team it must
  -- equal that team's authoritative tier; solo it must equal your own billed plan.
  IF NEW.effective_tier IS DISTINCT FROM OLD.effective_tier THEN
    IF NEW.team_id IS NOT NULL THEN
      IF NOT public._teams_is_active_member(NEW.id, NEW.team_id) THEN
        RAISE EXCEPTION 'users.effective_tier cannot change without active team membership';
      END IF;
      SELECT t.tier INTO team_tier
      FROM public.teams t
      WHERE t.id = NEW.team_id AND t.active IS NOT FALSE;
      IF team_tier IS NULL OR NEW.effective_tier IS DISTINCT FROM team_tier THEN
        RAISE EXCEPTION 'users.effective_tier must equal your team plan';
      END IF;
    ELSE
      IF NEW.effective_tier IS DISTINCT FROM COALESCE(OLD.plan, 'free') THEN
        RAISE EXCEPTION 'users.effective_tier is managed by billing webhook';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
