-- Production billing column guard (matches live Supabase).
-- Replaces earlier protect_users_billing_columns draft if present in dev/staging.

DROP TRIGGER IF EXISTS protect_users_billing_columns_trigger ON public.users;
DROP FUNCTION IF EXISTS public.protect_users_billing_columns();

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS lemon_variant_id TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT false;

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
  IF NEW.effective_tier IS DISTINCT FROM OLD.effective_tier THEN
    RAISE EXCEPTION 'users.effective_tier is managed by billing webhook';
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
  IF NEW.customer_portal_url IS DISTINCT FROM OLD.customer_portal_url THEN
    RAISE EXCEPTION 'users.customer_portal_url is managed by billing webhook';
  END IF;
  IF NEW.has_db_studio_legacy IS DISTINCT FROM OLD.has_db_studio_legacy THEN
    RAISE EXCEPTION 'users.has_db_studio_legacy is managed by billing webhook';
  END IF;
  IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    RAISE EXCEPTION 'users.team_id is managed via the team membership flow';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_guard_sensitive_columns ON public.users;

CREATE TRIGGER users_guard_sensitive_columns
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_users_sensitive_columns();

COMMENT ON FUNCTION public.guard_users_sensitive_columns() IS
  'Blocks client updates to billing and identity columns; service_role bypasses.';
