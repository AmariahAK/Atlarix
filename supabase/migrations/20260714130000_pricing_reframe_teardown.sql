-- =============================================================================
-- Pricing reframe teardown: remove the Team/workforce tier + the monthly Core
-- allowance model. Tiers collapse to (free | pro); Atlarix Core is now PAYG via
-- credit_wallet (see 20260714120000_credit_wallet.sql).
-- =============================================================================
-- DEPLOY ORDER: apply this ONLY AFTER the new proxy + edge functions are live
-- (they must be running against credit_wallet before the compass allowance RPCs
-- are dropped below), and after 20260714120000_credit_wallet.sql.
--
-- No live paid subscribers exist — only two accounts, both moved to Pro.
-- =============================================================================

-- 1) Reconcile the two real accounts to Pro (runs as admin → passes the guard).
UPDATE public.users
SET plan = 'pro', effective_tier = 'pro', updated_at = now()
WHERE email IN ('amariah.abish@gmail.com', 'amani.kamau06@gmail.com');

-- 2) Rewrite the users guard so it no longer references team_id / has_db_studio_legacy
--    (both dropped below). effective_tier must simply equal the user's own plan.
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

  -- Team removed: effective_tier must equal the user's own billed plan.
  IF NEW.effective_tier IS DISTINCT FROM OLD.effective_tier THEN
    IF NEW.effective_tier IS DISTINCT FROM COALESCE(NEW.plan, OLD.plan, 'free') THEN
      RAISE EXCEPTION 'users.effective_tier is managed by billing webhook';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 3) Drop the team tables. CASCADE removes their RLS policies, FKs, and the
--    team_members_guard trigger.
DROP TABLE IF EXISTS public.team_members CASCADE;
DROP TABLE IF EXISTS public.teams CASCADE;

-- 4) Team helper functions are now unreferenced (guard rewritten, policies gone).
DROP FUNCTION IF EXISTS public.guard_team_members() CASCADE;
DROP FUNCTION IF EXISTS public._teams_is_active_member(uuid, uuid) CASCADE;

-- 5) Drop the now-dead user columns.
ALTER TABLE public.users DROP COLUMN IF EXISTS team_id;
ALTER TABLE public.users DROP COLUMN IF EXISTS has_db_studio_legacy;

-- 6) Tighten the tier CHECKs to (free | pro). No workforce rows remain (step 1).
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_plan_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_plan_check CHECK (plan IN ('free', 'pro'));
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_effective_tier_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_effective_tier_check CHECK (effective_tier IN ('free', 'pro'));

-- 7) Retire the monthly Core ALLOWANCE model (superseded by credit_wallet).
--    Safe only because the proxy now meters against the wallet (deploy order above).
DROP FUNCTION IF EXISTS public.get_compass_usage_state();
DROP FUNCTION IF EXISTS public.record_compass_usage(bigint);
DROP TABLE IF EXISTS public.compass_tokens;
