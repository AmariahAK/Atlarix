-- Security gap fix: guard lemon_variant_id; allow validated team join/leave on users.
-- See Atlarix/src/lib/teams/team-service.ts (acceptInvite updates team_members then users).

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
  allowed_leave_tier text;
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

  -- team_id / effective_tier: allow only validated team membership flows
  IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    IF NEW.team_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.team_members tm
        WHERE tm.team_id = NEW.team_id
          AND tm.user_id = NEW.id
          AND tm.status = 'active'
      ) THEN
        RAISE EXCEPTION 'users.team_id can only change when you are an active member of that team';
      END IF;
    ELSE
      IF OLD.team_id IS NULL THEN
        RAISE EXCEPTION 'users.team_id cannot be cleared without leaving a team';
      END IF;
      allowed_leave_tier := COALESCE(OLD.plan, 'free');
      IF NEW.effective_tier IS DISTINCT FROM allowed_leave_tier THEN
        RAISE EXCEPTION 'users.effective_tier must match your own plan when leaving a team';
      END IF;
    END IF;
  ELSIF NEW.effective_tier IS DISTINCT FROM OLD.effective_tier THEN
    IF NEW.team_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.team_members tm
        WHERE tm.team_id = NEW.team_id
          AND tm.user_id = NEW.id
          AND tm.status = 'active'
      ) THEN
        RAISE EXCEPTION 'users.effective_tier cannot change without active team membership';
      END IF;
    ELSE
      RAISE EXCEPTION 'users.effective_tier is managed by billing webhook';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
