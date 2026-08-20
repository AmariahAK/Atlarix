-- Account bans.
--
-- SCOPE, decided deliberately and stated honestly: a ban blocks Atlarix Core
-- spend and the account. It does NOT block the user's own API keys or local
-- models, and nothing here pretends to — the app runs offline by design, so a
-- client-side block on a key the user owns is theatre. The enforcement point that
-- matters is the proxy, which reads this state server-side on every request.
--
-- WHY `banned_at` LIVES ON `users` BUT `ban_reason` DOES NOT:
-- `public.users` has a "Users can read own data" SELECT policy, and the client
-- subscribes to postgres_changes UPDATEs on its own row (supabase-client.ts) —
-- that payload carries every column. So a reason stored here would be delivered
-- straight to the banned user's client. `banned_at` is fine to expose (the client
-- has to know it is banned); the reason is internal, so it lives in a
-- service-role-only table instead.

-- ---------------------------------------------------------------------------
-- 1. The flag the client and the proxy both read.
-- ---------------------------------------------------------------------------
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ;

COMMENT ON COLUMN public.users.banned_at IS
  'When set, this account is banned: the proxy refuses Core requests and the client refuses to proceed. Service-role only (see guard_users_sensitive_columns). Reason/audit live in public.user_bans.';

CREATE INDEX IF NOT EXISTS users_banned_at_idx
  ON public.users (banned_at)
  WHERE banned_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Reason + audit trail. NEVER reaches a client.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_bans (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  reason TEXT,
  banned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  banned_by TEXT,
  lifted_at TIMESTAMPTZ,
  lifted_by TEXT
);

CREATE INDEX IF NOT EXISTS user_bans_user_id_idx ON public.user_bans (user_id);

ALTER TABLE public.user_bans ENABLE ROW LEVEL SECURITY;

-- No policy for `authenticated` at all: with RLS on and no permissive policy,
-- every non-service-role read and write is denied. That is the whole point — the
-- reason must not be reachable from a client, by query OR by realtime.
DROP POLICY IF EXISTS "user_bans_service_role_only" ON public.user_bans;
CREATE POLICY "user_bans_service_role_only"
  ON public.user_bans
  USING ((SELECT auth.role()) = 'service_role')
  WITH CHECK ((SELECT auth.role()) = 'service_role');

REVOKE ALL ON public.user_bans FROM PUBLIC;
REVOKE ALL ON public.user_bans FROM authenticated;
REVOKE ALL ON SEQUENCE public.user_bans_id_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.user_bans_id_seq FROM authenticated;

-- ---------------------------------------------------------------------------
-- 3. A banned user must not be able to un-ban themselves.
-- ---------------------------------------------------------------------------
-- `public.users` has "Users can update own row" FOR UPDATE TO authenticated
-- USING (auth.uid() = id), so without this the first thing a banned user could
-- do is `update users set banned_at = null where id = auth.uid()`.
--
-- WHERE THIS BODY CAME FROM, AND THE MISTAKE THAT NEARLY SHIPPED:
-- It is the body from 20260714130000_pricing_reframe_teardown.sql — the NEWEST
-- migration that defines this function — with one clause added.
--
-- The first draft copied it from supabase/audit/prod_schema.sql instead, because
-- an earlier comment here said to. That snapshot is STALE: it predates the
-- pricing-reframe teardown, which DROPPED public.team_members, public.teams,
-- users.team_id and users.has_db_studio_legacy. A body referencing those still
-- CREATEs without complaint (plpgsql resolves record fields at RUNTIME, not at
-- definition time) and then raises `record "new" has no field
-- "has_db_studio_legacy"` on the first client UPDATE to public.users — i.e. it
-- would have broken every authenticated write to that table in production, from a
-- migration that applied cleanly.
--
-- So: the source of truth for a CREATE OR REPLACE body is the newest MIGRATION
-- that defines it, never an audit snapshot. This function has now been replaced
-- five times and CREATE OR REPLACE takes a whole body, so starting from any older
-- copy silently reverts whatever the newer ones changed.
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
  -- NEW: a ban is set and lifted by us, never by the account it applies to.
  IF NEW.banned_at IS DISTINCT FROM OLD.banned_at THEN
    RAISE EXCEPTION 'users.banned_at is managed by Atlarix';
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

COMMENT ON FUNCTION public.guard_users_sensitive_columns() IS
  'Blocks client updates to billing, identity and ban columns; service_role bypasses.';

-- The trigger already exists (users_guard_sensitive_columns); CREATE OR REPLACE
-- above rebinds it to the new body without touching it.

-- ---------------------------------------------------------------------------
-- 4. The hard stop: no Core spend while banned.
-- ---------------------------------------------------------------------------
-- Folded into get_credit_balance rather than added as a second RPC, so the check
-- rides the wallet read the proxy ALREADY makes on every request — no extra
-- round-trip, and it inherits balance-cache.ts's 3s TTL, which is the honest
-- bound on how long a ban takes to bite (not "at next sign-in", which would not
-- be a ban at all).
--
-- Deliberately NOT added to debit_wallet: tokens a user already consumed should
-- still be billed. The gate belongs at the start of a call, not after it.
--
-- CREATE OR REPLACE preserves existing privileges, but the REVOKE/GRANT from
-- 20260714150000 is re-asserted below anyway — the standing rule is that
-- CREATE FUNCTION grants EXECUTE to PUBLIC, and this is a SECURITY DEFINER RPC.
CREATE OR REPLACE FUNCTION public.get_credit_balance()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  bal bigint;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  -- Before the wallet upsert: a banned account should not even get a row created.
  IF EXISTS (SELECT 1 FROM users WHERE id = uid AND banned_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;
  INSERT INTO credit_wallet (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING;
  SELECT balance_cents INTO bal FROM credit_wallet WHERE user_id = uid;
  RETURN jsonb_build_object('ok', true, 'balance_cents', COALESCE(bal, 0));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_credit_balance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_credit_balance() TO authenticated;
