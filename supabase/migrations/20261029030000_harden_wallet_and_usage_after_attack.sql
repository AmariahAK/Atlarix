-- 2026-10-29: after the overnight attack (one throwaway account, ~7 h of fuzzing).
--
-- What it found on the money side: `debit_wallet` is callable by any signed-in
-- user (by design: the proxy debits with the user's own JWT), it accepted ANY
-- positive amount, and `spend_from_wallet` lets the purchased balance go
-- negative on purpose (a reconciling debit may overshoot slightly). Fourteen
-- calls with p_cents up to 2^31 took the wallet to -8,589,934,601 cents.
-- The ban was applied at the auth level (`auth.users.banned_until`), which the
-- app-level checks (`users.banned_at`) never see.
--
-- This migration:
--  1. `account_is_banned(uuid)`: ONE definition of banned, reading both the
--     app-level column and the auth-level ban.
--  2. `debit_wallet`: refuses banned accounts, caps one call at $50
--     (DEBIT_MAX_CENTS), and refuses a debit that would take the wallet below
--     -$50 (DEBIT_FLOOR_CENTS). A real generation costs cents to a few dollars;
--     the proxy's pre-flight reserve is still the first gate, this is the last.
--  3. `get_credit_balance`, `record_client_usage`, `record_client_seen`: refuse
--     banned accounts (the usage ones silently wrote rows for a banned user).
-- Nothing else changes: idempotency, sources, grants and return shapes are as
-- before.
BEGIN;

CREATE OR REPLACE FUNCTION public.account_is_banned(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND banned_at IS NOT NULL)
      OR EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id AND banned_until IS NOT NULL AND banned_until > now());
$$;
REVOKE ALL ON FUNCTION public.account_is_banned(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.account_is_banned(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_is_banned(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.debit_wallet(
  p_generation_id text,
  p_cents bigint,
  p_source text DEFAULT 'app'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  bal bigint;
  -- One generation. Frontier models on a long context cost a few dollars;
  -- $50 is far above any real call and far below what the fuzzer sent.
  DEBIT_MAX_CENTS CONSTANT bigint := 5000;
  -- How far a reconciling debit may overshoot the balance. Was unbounded.
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
  -- 'reviewer' is deliberately NOT accepted here. That path is service-token
  -- only, and letting a user-JWT call claim it would put reviewer spend on the
  -- account page for work no installation did.
  IF p_source IS NULL OR p_source NOT IN ('app', 'cli', 'extension') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_source');
  END IF;

  INSERT INTO credit_wallet (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING;

  -- A repeat of a generation already charged is answered before the floor, so
  -- the idempotent reply stays identical whatever the balance did since.
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

  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref, source)
  VALUES (uid, -p_cents, 'debit', p_generation_id, p_source)
  ON CONFLICT (kind, ref) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'balance_cents', wallet_spendable(uid), 'duplicate', true
    );
  END IF;

  -- Every user-path surface draws the Pro allowance first. Only 'reviewer'
  -- prefers a different one, and it cannot reach this function.
  bal := spend_from_wallet(uid, p_cents, 'pro');
  RETURN jsonb_build_object('ok', true, 'balance_cents', bal);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.debit_wallet(text, bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.debit_wallet(text, bigint, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.debit_wallet(text, bigint, text) TO authenticated;

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
  RETURN jsonb_build_object(
    'ok', true,
    'balance_cents', COALESCE(granted, 0) + COALESCE(purchased, 0),
    'granted_cents', COALESCE(granted, 0),
    'granted_total_cents', COALESCE(granted_total, 0),
    'purchased_cents', COALESCE(purchased, 0)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_client_seen(p_surface text, p_app_version text, p_os text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  uid uuid := auth.uid();
  v text := CASE WHEN p_app_version ~ '^[0-9A-Za-z.+-]{1,32}$' THEN p_app_version END;
  o text := CASE WHEN p_os ~ '^[a-z0-9_]{1,16}$' THEN p_os END;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF public.account_is_banned(uid) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;
  IF p_surface IS NULL OR p_surface NOT IN ('app', 'cli', 'acp', 'vscode', 'website') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_arguments');
  END IF;
  UPDATE public.users SET
    first_surface     = COALESCE(first_surface, p_surface),
    first_seen_at     = COALESCE(first_seen_at, now()),
    first_app_version = CASE WHEN first_surface IS NULL THEN v ELSE first_app_version END,
    first_os          = CASE WHEN first_surface IS NULL THEN o ELSE first_os END,
    last_app_version  = COALESCE(v, last_app_version),
    last_os           = COALESCE(o, last_os)
  WHERE id = uid;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_client_usage(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  uid uuid := auth.uid();
  r jsonb;
  d date;
  t_first timestamptz;
  t_last timestamptz;
  n_turns bigint;
  n_failed bigint;
  written integer := 0;
  skipped integer := 0;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF public.account_is_banned(uid) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 50 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_arguments');
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    BEGIN
      d := (r->>'day')::date;
      n_turns := COALESCE((r->>'turns')::bigint, 0);
      n_failed := COALESCE((r->>'failed_turns')::bigint, 0);
      IF d IS NULL OR d < (now() AT TIME ZONE 'UTC')::date - 1 OR d > (now() AT TIME ZONE 'UTC')::date + 1
         OR n_turns < 1 OR n_turns > 10000 OR n_failed < 0 OR n_failed > n_turns
         OR COALESCE((r->>'tokens_in')::bigint, 0) NOT BETWEEN 0 AND 1000000000
         OR COALESCE((r->>'tokens_out')::bigint, 0) NOT BETWEEN 0 AND 1000000000 THEN
        skipped := skipped + 1;
        CONTINUE;
      END IF;
      t_last := LEAST(COALESCE((r->>'last_seen')::timestamptz, now()), now());
      t_first := GREATEST(LEAST(COALESCE((r->>'first_seen')::timestamptz, t_last), t_last), now() - interval '3 days');

      INSERT INTO public.client_usage_daily AS u
        (user_id, day, surface, editor, billing, provider_type, model, turns, failed_turns,
         last_error_kind, tokens_in, tokens_out, first_seen, last_seen)
      VALUES (
        uid, d,
        r->>'surface',
        COALESCE(r->>'editor', ''),
        r->>'billing',
        r->>'provider_type',
        r->>'model',
        n_turns, n_failed,
        NULLIF(r->>'last_error_kind', ''),
        COALESCE((r->>'tokens_in')::bigint, 0),
        COALESCE((r->>'tokens_out')::bigint, 0),
        t_first, t_last
      )
      ON CONFLICT (user_id, day, surface, editor, billing, provider_type, model) DO UPDATE SET
        turns           = u.turns + EXCLUDED.turns,
        failed_turns    = u.failed_turns + EXCLUDED.failed_turns,
        last_error_kind = CASE WHEN EXCLUDED.last_error_kind IS NOT NULL AND EXCLUDED.last_seen >= u.last_seen
                               THEN EXCLUDED.last_error_kind ELSE u.last_error_kind END,
        tokens_in       = u.tokens_in + EXCLUDED.tokens_in,
        tokens_out      = u.tokens_out + EXCLUDED.tokens_out,
        first_seen      = LEAST(u.first_seen, EXCLUDED.first_seen),
        last_seen       = GREATEST(u.last_seen, EXCLUDED.last_seen);

      UPDATE public.users SET
        first_surface = COALESCE(first_surface, r->>'surface'),
        first_seen_at = COALESCE(first_seen_at, t_first),
        last_surface  = CASE WHEN last_seen_at IS NULL OR t_last >= last_seen_at
                             THEN r->>'surface' ELSE last_surface END,
        last_seen_at  = GREATEST(COALESCE(last_seen_at, '-infinity'), t_last)
      WHERE id = uid;

      written := written + 1;
    EXCEPTION WHEN check_violation OR invalid_text_representation OR not_null_violation
                   OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN
      skipped := skipped + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'written', written, 'skipped', skipped);
END;
$$;

COMMIT;

-- VERIFY after applying:
--   SELECT p.proname, p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname IN ('account_is_banned', 'debit_wallet');
--   -- account_is_banned: no authenticated/anon; debit_wallet: authenticated only, no PUBLIC.
