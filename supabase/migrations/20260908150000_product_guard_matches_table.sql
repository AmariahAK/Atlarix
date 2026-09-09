-- Make the product guard agree with the table it writes to.
--
-- 20260908120000 narrowed `credit_grants.product` to CHECK (product IN ('pro')), but the
-- three service RPCs that write that column still accepted 'reviewer' in their own guards.
-- So a caller passing 'reviewer' got past the function's validation and failed on the
-- table constraint instead — a raw 23514 rather than the clean
-- `{"ok": false, "error": "invalid_product"}` these functions exist to return.
--
-- NOTHING COULD TRIGGER IT TODAY: `handle-lemon-webhook` no longer classifies by product
-- and never passes anything but 'pro'. This is closed because a validation layer that
-- disagrees with its storage layer is how the NEXT caller gets a confusing error, and
-- because "the guard is wider than the constraint" is not a state anyone should have to
-- rediscover by reading two migrations side by side.
--
-- `<> 'pro'` rather than `NOT IN ('pro')`, so a second product cannot be added here
-- without also widening the table CHECK — the mismatch this migration is fixing.
--
-- Bodies are otherwise VERBATIM from 20260827140000. `CREATE OR REPLACE` needs the whole
-- function, so the only edit is the guard line in each.

CREATE OR REPLACE FUNCTION public.grant_monthly_credit_service(
  p_user_id uuid,
  p_product text,
  p_cents bigint,
  p_ref text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  prior_cents bigint;
  prior_ref text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;
  IF p_product <> 'pro' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_product');
  END IF;
  IF p_cents IS NULL OR p_cents < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;
  IF p_ref IS NULL OR length(trim(p_ref)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_ref');
  END IF;

  -- NO ban check, matching debit_wallet: the ban gate rides the BALANCE READ
  -- every request already makes (20260819120000).

  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;

  SELECT cents, ref INTO prior_cents, prior_ref FROM credit_grants
  WHERE user_id = p_user_id AND product = p_product FOR UPDATE;

  IF prior_ref IS NOT NULL AND prior_ref = p_ref THEN
    RETURN jsonb_build_object(
      'ok', true, 'balance_cents', wallet_spendable(p_user_id),
      'granted_cents', COALESCE(prior_cents, 0), 'duplicate', true
    );
  END IF;

  IF COALESCE(prior_cents, 0) > 0 THEN
    INSERT INTO credit_transactions (user_id, delta_cents, kind, ref)
    VALUES (p_user_id, -prior_cents, 'grant_expiry', p_product || ':' || p_ref)
    ON CONFLICT (kind, ref) DO NOTHING;
  END IF;

  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref)
  VALUES (p_user_id, p_cents, 'grant', p_product || ':' || p_ref)
  ON CONFLICT (kind, ref) DO NOTHING;

  -- BOTH columns. A new period resets what is left AND what was included; a
  -- renewal that moved only `cents` would leave last month's total in place and
  -- report consumption against the wrong denominator.
  INSERT INTO credit_grants (user_id, product, cents, total_cents, ref)
  VALUES (p_user_id, p_product, p_cents, p_cents, p_ref)
  ON CONFLICT (user_id, product) DO UPDATE
  SET cents = EXCLUDED.cents,
      total_cents = EXCLUDED.total_cents,
      ref = EXCLUDED.ref,
      updated_at = now();

  RETURN jsonb_build_object(
    'ok', true, 'balance_cents', wallet_spendable(p_user_id), 'granted_cents', p_cents
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_monthly_grant_service(
  p_user_id uuid,
  p_product text,
  p_ref text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  prior_cents bigint;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;
  IF p_product <> 'pro' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_product');
  END IF;
  IF p_ref IS NULL OR length(trim(p_ref)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_ref');
  END IF;

  SELECT cents INTO prior_cents FROM credit_grants
  WHERE user_id = p_user_id AND product = p_product FOR UPDATE;

  IF prior_cents IS NULL OR prior_cents = 0 THEN
    -- Still zero the total: a subscription that ended after its allowance was
    -- fully spent must stop reporting "$10 included this month".
    UPDATE credit_grants SET total_cents = 0, updated_at = now()
    WHERE user_id = p_user_id AND product = p_product AND total_cents <> 0;
    RETURN jsonb_build_object(
      'ok', true, 'balance_cents', wallet_spendable(p_user_id), 'noop', true
    );
  END IF;

  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref)
  VALUES (p_user_id, -prior_cents, 'grant_expiry', p_product || ':' || p_ref)
  ON CONFLICT (kind, ref) DO NOTHING;

  UPDATE credit_grants SET cents = 0, total_cents = 0, ref = NULL, updated_at = now()
  WHERE user_id = p_user_id AND product = p_product;

  RETURN jsonb_build_object('ok', true, 'balance_cents', wallet_spendable(p_user_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.refund_grant_service(
  p_user_id uuid,
  p_product text,
  p_cents bigint,
  p_ref text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  prior_cents bigint;
  taken bigint;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;
  IF p_product <> 'pro' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_product');
  END IF;
  IF p_cents IS NULL OR p_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;
  IF p_ref IS NULL OR length(trim(p_ref)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_ref');
  END IF;

  SELECT cents INTO prior_cents FROM credit_grants
  WHERE user_id = p_user_id AND product = p_product FOR UPDATE;

  IF prior_cents IS NULL OR prior_cents = 0 THEN
    RETURN jsonb_build_object(
      'ok', true, 'taken_cents', 0, 'requested_cents', p_cents,
      'balance_cents', wallet_spendable(p_user_id), 'noop', true
    );
  END IF;

  taken := LEAST(prior_cents, p_cents);

  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref)
  VALUES (p_user_id, -taken, 'grant_refund', p_product || ':' || p_ref)
  ON CONFLICT (kind, ref) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'taken_cents', 0, 'requested_cents', p_cents,
      'balance_cents', wallet_spendable(p_user_id), 'duplicate', true
    );
  END IF;

  UPDATE credit_grants
     SET cents = cents - taken,
         total_cents = GREATEST(total_cents - taken, cents - taken),
         updated_at = now()
   WHERE user_id = p_user_id AND product = p_product;

  RETURN jsonb_build_object(
    'ok', true, 'taken_cents', taken, 'requested_cents', p_cents,
    'shortfall_cents', p_cents - taken,
    'balance_cents', wallet_spendable(p_user_id)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- RE-REVOKE. This is not optional and it is not defensive.
-- ---------------------------------------------------------------------------
-- `CREATE OR REPLACE FUNCTION` re-grants EXECUTE to PUBLIC, and a REVOKE from
-- authenticated/anon does NOT remove a PUBLIC grant. That is exactly how
-- `credit_wallet_service` — which credits ANY user by parameter — stayed callable by anon
-- after being replaced (see 20260714150000). Every replacement of a SECURITY DEFINER
-- money function has to redo this, and the in-function `auth.role()` check is the second
-- layer, not the first.
--
-- Verify by reading `proacl` back, not by trusting this file:
--   select proname, proacl from pg_proc where proname like '%grant%service';

REVOKE EXECUTE ON FUNCTION public.grant_monthly_credit_service(uuid, text, bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.grant_monthly_credit_service(uuid, text, bigint, text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.grant_monthly_credit_service(uuid, text, bigint, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.clear_monthly_grant_service(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clear_monthly_grant_service(uuid, text, text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.clear_monthly_grant_service(uuid, text, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.refund_grant_service(uuid, text, bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refund_grant_service(uuid, text, bigint, text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.refund_grant_service(uuid, text, bigint, text) TO service_role;
