-- 2026-10-29: the wallet contract the clients and the usage dashboard need.
--
-- 1. `credit_transactions.billing`: what a debit paid for (auto_paid | core |
--    tool | reviewer | cloud). Until now a debit's `ref` was "<provider>:<id>"
--    for Auto and Core alike, so nothing could split spend per day. Nullable:
--    rows from before this migration stay NULL and are reported as "unsplit".
-- 2. The three debit functions take `p_billing` (default NULL, so an older
--    proxy keeps working). Same signatures otherwise; the old ones are dropped
--    so PostgREST has one candidate per name.
-- 3. `get_credit_balance` / `_service` also return `plan` ('free'|'pro'),
--    `ever_funded` (any top-up, grant or trial ever) and `renews_at` (Pro only):
--    the proxy puts them on its 402 so every surface can say which of the three
--    refusals applies (never funded / spent / Pro allowance used up) without
--    guessing from the balance.
-- 4. `get_usage_credits(p_days, p_tz)`: per-day spend split by billing, own rows
--    only, for the Usage page (shape agreed with the usage session 2026-10-29).
-- 5. Index (user_id, created_at): every per-day read is a range on it.
BEGIN;

ALTER TABLE public.credit_transactions
  ADD COLUMN IF NOT EXISTS billing text
  CHECK (billing IS NULL OR billing IN ('auto_paid', 'core', 'tool', 'reviewer', 'cloud'));

CREATE INDEX IF NOT EXISTS credit_transactions_user_created_idx
  ON public.credit_transactions (user_id, created_at);

-- ── 2: debits carry what they paid for ───────────────────────────────────────

DROP FUNCTION IF EXISTS public.debit_wallet(text, bigint, text);
CREATE FUNCTION public.debit_wallet(
  p_generation_id text,
  p_cents bigint,
  p_source text DEFAULT 'app',
  p_billing text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  bal bigint;
  DEBIT_MAX_CENTS CONSTANT bigint := 5000;
  DEBIT_FLOOR_CENTS CONSTANT bigint := -5000;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF public.account_is_banned(uid) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;
  IF p_cents IS NULL OR p_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;
  IF p_cents > DEBIT_MAX_CENTS THEN
    RETURN jsonb_build_object('ok', false, 'error', 'amount_too_large', 'max_cents', DEBIT_MAX_CENTS);
  END IF;
  IF p_generation_id IS NULL OR length(trim(p_generation_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_generation_id');
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('app', 'cli', 'extension') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_source');
  END IF;
  IF p_billing IS NOT NULL AND p_billing NOT IN ('auto_paid', 'core', 'tool') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_billing');
  END IF;

  INSERT INTO credit_wallet (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING;

  IF EXISTS (SELECT 1 FROM credit_transactions WHERE kind = 'debit' AND ref = p_generation_id) THEN
    RETURN jsonb_build_object(
      'ok', true, 'balance_cents', wallet_spendable(uid), 'duplicate', true
    );
  END IF;

  IF wallet_spendable(uid) - p_cents < DEBIT_FLOOR_CENTS THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'insufficient_funds', 'balance_cents', wallet_spendable(uid)
    );
  END IF;

  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref, source, billing)
  VALUES (uid, -p_cents, 'debit', p_generation_id, p_source, p_billing)
  ON CONFLICT (kind, ref) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'balance_cents', wallet_spendable(uid), 'duplicate', true
    );
  END IF;

  bal := spend_from_wallet(uid, p_cents, 'pro');
  RETURN jsonb_build_object('ok', true, 'balance_cents', bal);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.debit_wallet(text, bigint, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.debit_wallet(text, bigint, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.debit_wallet(text, bigint, text, text) TO authenticated;

DROP FUNCTION IF EXISTS public.debit_wallet_service(uuid, text, bigint, text, text);
CREATE FUNCTION public.debit_wallet_service(
  p_user_id uuid,
  p_generation_id text,
  p_cents bigint,
  p_source text DEFAULT 'reviewer',
  p_repo text DEFAULT NULL,
  p_billing text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  bal bigint;
  DEBIT_MAX_CENTS CONSTANT bigint := 5000;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;
  IF public.account_is_banned(p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;
  IF p_cents IS NULL OR p_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;
  IF p_cents > DEBIT_MAX_CENTS THEN
    RETURN jsonb_build_object('ok', false, 'error', 'amount_too_large', 'max_cents', DEBIT_MAX_CENTS);
  END IF;
  IF p_generation_id IS NULL OR length(trim(p_generation_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_generation_id');
  END IF;
  IF p_source NOT IN ('app', 'reviewer', 'cli', 'extension') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_source');
  END IF;
  IF p_billing IS NOT NULL AND p_billing NOT IN ('auto_paid', 'core', 'tool', 'reviewer') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_billing');
  END IF;

  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref, source, repo, billing)
  VALUES (p_user_id, -p_cents, 'debit', p_generation_id, p_source, p_repo,
          COALESCE(p_billing, CASE WHEN p_source = 'reviewer' THEN 'reviewer' END))
  ON CONFLICT (kind, ref) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'balance_cents', wallet_spendable(p_user_id), 'duplicate', true
    );
  END IF;

  bal := spend_from_wallet(
    p_user_id, p_cents, CASE WHEN p_source = 'reviewer' THEN 'reviewer' ELSE 'pro' END
  );
  RETURN jsonb_build_object('ok', true, 'balance_cents', bal);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.debit_wallet_service(uuid, text, bigint, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.debit_wallet_service(uuid, text, bigint, text, text, text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.debit_wallet_service(uuid, text, bigint, text, text, text) TO service_role;

DROP FUNCTION IF EXISTS public.debit_wallet_cloud(uuid, uuid, text, bigint);
CREATE FUNCTION public.debit_wallet_cloud(
  p_user_id uuid,
  p_job_id uuid,
  p_generation_id text,
  p_cents bigint,
  p_billing text DEFAULT 'cloud'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  bal bigint;
  job_repo text;
  DEBIT_MAX_CENTS CONSTANT bigint := 5000;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF public.account_is_banned(p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;
  IF p_cents IS NULL OR p_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;
  IF p_cents > DEBIT_MAX_CENTS THEN
    RETURN jsonb_build_object('ok', false, 'error', 'amount_too_large', 'max_cents', DEBIT_MAX_CENTS);
  END IF;
  IF p_generation_id IS NULL OR length(trim(p_generation_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_generation_id');
  END IF;

  SELECT repo INTO job_repo
    FROM cloud_jobs
   WHERE id = p_job_id AND user_id = p_user_id AND state = 'running'
   FOR UPDATE;
  IF job_repo IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'job_not_running');
  END IF;

  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref, source, repo, billing)
  VALUES (p_user_id, -p_cents, 'debit', p_generation_id, 'cloud', job_repo, COALESCE(p_billing, 'cloud'))
  ON CONFLICT (kind, ref) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'balance_cents', wallet_spendable(p_user_id), 'duplicate', true
    );
  END IF;

  bal := spend_from_wallet(p_user_id, p_cents, 'pro');
  UPDATE cloud_jobs
     SET spent_cents = spent_cents + p_cents, updated_at = now()
   WHERE id = p_job_id;
  RETURN jsonb_build_object('ok', true, 'balance_cents', bal);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.debit_wallet_cloud(uuid, uuid, text, bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.debit_wallet_cloud(uuid, uuid, text, bigint, text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.debit_wallet_cloud(uuid, uuid, text, bigint, text) TO service_role;

-- ── 3: the balance says which refusal applies ────────────────────────────────

-- ONE definition of plan / renewal / ever-funded, used by both balance reads
-- and by get_usage_credits. `plan` is 'pro' or 'free', nothing else.
CREATE OR REPLACE FUNCTION public.wallet_plan_facts(p_user_id uuid)
RETURNS TABLE (plan text, renews_at timestamptz, ever_funded boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    CASE WHEN COALESCE(u.effective_tier, u.plan, 'free') = 'pro' THEN 'pro' ELSE 'free' END,
    CASE WHEN COALESCE(u.effective_tier, u.plan, 'free') = 'pro' THEN u.subscription_ends_at END,
    EXISTS (SELECT 1 FROM credit_transactions t
             WHERE t.user_id = p_user_id AND t.kind IN ('topup', 'grant', 'trial'))
  FROM users u WHERE u.id = p_user_id;
$$;
REVOKE ALL ON FUNCTION public.wallet_plan_facts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wallet_plan_facts(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_plan_facts(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_credit_balance()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  granted bigint;
  granted_total bigint;
  purchased bigint;
  facts record;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF public.account_is_banned(uid) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;
  INSERT INTO credit_wallet (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING;
  SELECT COALESCE(SUM(cents), 0), COALESCE(SUM(total_cents), 0)
    INTO granted, granted_total FROM credit_grants WHERE user_id = uid;
  SELECT balance_cents INTO purchased FROM credit_wallet WHERE user_id = uid;
  SELECT * INTO facts FROM public.wallet_plan_facts(uid);
  RETURN jsonb_build_object(
    'ok', true,
    'balance_cents', COALESCE(granted, 0) + COALESCE(purchased, 0),
    'granted_cents', COALESCE(granted, 0),
    'granted_total_cents', COALESCE(granted_total, 0),
    'purchased_cents', COALESCE(purchased, 0),
    'plan', COALESCE(facts.plan, 'free'),
    'ever_funded', COALESCE(facts.ever_funded, false),
    'renews_at', facts.renews_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_credit_balance_service(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  granted bigint;
  granted_total bigint;
  purchased bigint;
  facts record;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;
  IF public.account_is_banned(p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;
  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT COALESCE(SUM(cents), 0), COALESCE(SUM(total_cents), 0)
    INTO granted, granted_total FROM credit_grants WHERE user_id = p_user_id;
  SELECT balance_cents INTO purchased FROM credit_wallet WHERE user_id = p_user_id;
  SELECT * INTO facts FROM public.wallet_plan_facts(p_user_id);
  RETURN jsonb_build_object(
    'ok', true,
    'balance_cents', COALESCE(granted, 0) + COALESCE(purchased, 0),
    'granted_cents', COALESCE(granted, 0),
    'granted_total_cents', COALESCE(granted_total, 0),
    'purchased_cents', COALESCE(purchased, 0),
    'plan', COALESCE(facts.plan, 'free'),
    'ever_funded', COALESCE(facts.ever_funded, false),
    'renews_at', facts.renews_at
  );
END;
$$;

-- ── 4: credits per day, for the Usage page ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_usage_credits(p_days integer DEFAULT 365, p_tz text DEFAULT 'UTC')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  uid uuid := auth.uid();
  days integer := LEAST(GREATEST(COALESCE(p_days, 365), 1), 730);
  tz text := 'UTC';
  granted bigint;
  granted_total bigint;
  purchased bigint;
  facts record;
  since date;
  days_json jsonb;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF public.account_is_banned(uid) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;
  -- A time zone name the server does not know falls back to UTC, never errors.
  IF p_tz IS NOT NULL AND length(p_tz) <= 64 THEN
    BEGIN
      PERFORM now() AT TIME ZONE p_tz;
      tz := p_tz;
    EXCEPTION WHEN OTHERS THEN
      tz := 'UTC';
    END;
  END IF;

  SELECT COALESCE(SUM(cents), 0), COALESCE(SUM(total_cents), 0)
    INTO granted, granted_total FROM credit_grants WHERE user_id = uid;
  SELECT balance_cents INTO purchased FROM credit_wallet WHERE user_id = uid;
  SELECT * INTO facts FROM public.wallet_plan_facts(uid);
  SELECT min((created_at AT TIME ZONE tz)::date) INTO since
    FROM credit_transactions WHERE user_id = uid;

  -- Debits only, as positive cents, one row per local day.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'day', to_char(t.d, 'YYYY-MM-DD'),
           'auto_paid_cents', t.auto_paid,
           'core_cents', t.core,
           'tool_cents', t.tool,
           'other_cents', t.other,
           'unsplit_cents', t.unsplit
         ) ORDER BY t.d), '[]'::jsonb)
    INTO days_json
    FROM (
      SELECT (created_at AT TIME ZONE tz)::date AS d,
             COALESCE(SUM(-delta_cents) FILTER (WHERE billing = 'auto_paid'), 0)::bigint AS auto_paid,
             COALESCE(SUM(-delta_cents) FILTER (WHERE billing = 'core'), 0)::bigint AS core,
             COALESCE(SUM(-delta_cents) FILTER (WHERE billing = 'tool'), 0)::bigint AS tool,
             COALESCE(SUM(-delta_cents) FILTER (WHERE billing IN ('reviewer', 'cloud')), 0)::bigint AS other,
             COALESCE(SUM(-delta_cents) FILTER (WHERE billing IS NULL), 0)::bigint AS unsplit
        FROM credit_transactions
       WHERE user_id = uid
         AND kind = 'debit'
         AND created_at >= now() - make_interval(days => days)
       GROUP BY 1
    ) t;

  RETURN jsonb_build_object(
    'ok', true,
    'balance_cents', COALESCE(granted, 0) + COALESCE(purchased, 0),
    'purchased_cents', COALESCE(purchased, 0),
    'granted_cents', COALESCE(granted, 0),
    'granted_total_cents', COALESCE(granted_total, 0),
    'plan', COALESCE(facts.plan, 'free'),
    'renews_at', facts.renews_at,
    'since', CASE WHEN since IS NULL THEN NULL ELSE to_char(since, 'YYYY-MM-DD') END,
    'days', days_json
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_usage_credits(integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_usage_credits(integer, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_usage_credits(integer, text) TO authenticated;

COMMIT;

-- VERIFY after applying:
--   SELECT proname, pg_get_function_identity_arguments(oid) FROM pg_proc
--    WHERE proname IN ('debit_wallet','debit_wallet_service','debit_wallet_cloud','get_usage_credits','wallet_plan_facts');
--   -- one row each, with p_billing on the three debits
--   SELECT p.proname, p.proacl FROM pg_proc p WHERE p.proname IN ('get_usage_credits','wallet_plan_facts');
--   -- get_usage_credits: authenticated; wallet_plan_facts: service_role only
