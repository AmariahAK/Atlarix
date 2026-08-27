-- What the period GRANTED, alongside what is left of it.
--
-- WHY. `credit_grants.cents` is a balance, not a budget: it records what remains
-- and nothing about how much there was. So the usage bar could only ever show
-- what the allowance and the purchased credit are worth side by side — the
-- COMPOSITION of what is left — when the question a reader actually asks is
-- "how much of my included usage have I spent". Consumption is not derivable
-- from a balance. Reported on the packaged v14.38.0 build, where the bar read
-- "$999,999.73 included / $1,000,000.67 credit" and answered nothing.
--
-- `cents` keeps its exact meaning. `total_cents` is what the period granted, so
-- CONSUMED = total_cents - cents, and the invariant `total_cents >= cents` must
-- hold after every write or that subtraction renders as "$8.00 of $5.00 used".
--
-- WHY A COLUMN AND NOT A LEDGER SCAN. The value is already known at the one
-- moment it changes (`grant_monthly_credit_service` is handed `p_cents`), so
-- storing it is a write we are already making. Reconstructing it instead would
-- mean the newest `kind='grant'` row per (user, product) on every balance read —
-- a scan of an append-only table on the hottest RPC in the system, to recover
-- something we chose to throw away.

ALTER TABLE public.credit_grants
  ADD COLUMN IF NOT EXISTS total_cents bigint NOT NULL DEFAULT 0
    CHECK (total_cents >= 0);

COMMENT ON COLUMN public.credit_grants.total_cents IS
  'What this period GRANTED. `cents` is what is left of it, so consumed = total_cents - cents. Set (not incremented) by grant_monthly_credit_service; untouched by spending, which is the point.';

-- ---------------------------------------------------------------------------
-- Backfill from the LEDGER, not from `cents`.
-- ---------------------------------------------------------------------------
-- `total_cents = cents` would be the easy default and it would lie: it says
-- every existing subscriber has consumed nothing, which is wrong on every
-- account that has spent anything — including the one this was reported from.
--
-- The truth is in `credit_transactions`: `grant_monthly_credit_service` writes a
-- `kind='grant'` row with the full period amount and a product-scoped ref, so
-- the newest such row per (user, product) IS the period total. `GREATEST(...,
-- cents)` guards the invariant against a hand-inserted grant row that is somehow
-- smaller than the balance it produced.
UPDATE public.credit_grants g
   SET total_cents = GREATEST(t.delta_cents, g.cents)
  FROM (
    SELECT DISTINCT ON (user_id, split_part(ref, ':', 1))
           user_id,
           split_part(ref, ':', 1) AS product,
           delta_cents
      FROM public.credit_transactions
     WHERE kind = 'grant' AND ref IS NOT NULL
     ORDER BY user_id, split_part(ref, ':', 1), created_at DESC
  ) t
 WHERE t.user_id = g.user_id
   AND t.product = g.product
   AND g.total_cents = 0;

-- Rows with no grant row to learn from (a comp inserted by hand, say) fall back
-- to what is left. It claims nothing was consumed, which is the least wrong
-- statement available when the ledger has no record either way.
UPDATE public.credit_grants
   SET total_cents = cents
 WHERE total_cents = 0 AND cents > 0;

-- ---------------------------------------------------------------------------
-- grant_monthly_credit_service — the ONE place that knows the period total.
-- ---------------------------------------------------------------------------
-- Unchanged except that `p_cents` now lands in both columns. Everything else is
-- reproduced verbatim from 20260826130000 because CREATE OR REPLACE has no way
-- to amend a body in place.
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
  IF p_product NOT IN ('pro', 'reviewer') THEN
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

-- ---------------------------------------------------------------------------
-- clear_monthly_grant_service — the subscription ended, so nothing is included.
-- ---------------------------------------------------------------------------
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
  IF p_product NOT IN ('pro', 'reviewer') THEN
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

-- ---------------------------------------------------------------------------
-- refund_grant_service — reduce BOTH by what was actually taken.
-- ---------------------------------------------------------------------------
-- By `taken`, NOT by `p_cents`. Two reasons and they point the same way:
--
--   * CONSUMED MUST NOT MOVE. A refund does not un-spend anything, so
--     `total - cents` has to come out the same before and after. Reducing both
--     by the same number is what guarantees that.
--   * THE INVARIANT SURVIVES. Reducing `total_cents` by the requested amount
--     while `cents` only drops by what was there produces total < cents on a
--     refund of a mostly-spent period — "$8.00 of $5.00 used".
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
  IF p_product NOT IN ('pro', 'reviewer') THEN
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
-- Both balance reads gain granted_total_cents. ADDITIVE ONLY.
-- ---------------------------------------------------------------------------
-- `balance_cents`, `granted_cents` and `purchased_cents` keep their exact
-- current meaning. That is what makes this safe for the two money paths that
-- read this row: atlarix-proxy's pre-flight gate (src/entitlement.ts) and the
-- reviewer's balance check (src/jobs/queue.ts) both parse it through a plain
-- TypeScript cast with no runtime validator, and both touch only `ok`, `error`
-- and `balance_cents`. A new key is ignored by both. Verified before relying on
-- it rather than assumed.
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
  IF EXISTS (SELECT 1 FROM users WHERE id = uid AND banned_at IS NOT NULL) THEN
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

CREATE OR REPLACE FUNCTION public.get_credit_balance_service(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  granted bigint;
  granted_total bigint;
  purchased bigint;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE id = p_user_id AND banned_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;
  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT COALESCE(SUM(cents), 0), COALESCE(SUM(total_cents), 0)
    INTO granted, granted_total FROM credit_grants WHERE user_id = p_user_id;
  SELECT balance_cents INTO purchased FROM credit_wallet WHERE user_id = p_user_id;
  RETURN jsonb_build_object(
    'ok', true,
    'balance_cents', COALESCE(granted, 0) + COALESCE(purchased, 0),
    'granted_cents', COALESCE(granted, 0),
    'granted_total_cents', COALESCE(granted_total, 0),
    'purchased_cents', COALESCE(purchased, 0)
  );
END;
$$;

-- CREATE OR REPLACE re-adds the default PUBLIC EXECUTE grant every time, and
-- revoking from authenticated/anon does not remove it. Re-assert all of it.
REVOKE EXECUTE ON FUNCTION public.grant_monthly_credit_service(uuid, text, bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.grant_monthly_credit_service(uuid, text, bigint, text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.grant_monthly_credit_service(uuid, text, bigint, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.clear_monthly_grant_service(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clear_monthly_grant_service(uuid, text, text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.clear_monthly_grant_service(uuid, text, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.refund_grant_service(uuid, text, bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refund_grant_service(uuid, text, bigint, text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.refund_grant_service(uuid, text, bigint, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.get_credit_balance() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_credit_balance() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_credit_balance() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_credit_balance_service(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_credit_balance_service(uuid) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.get_credit_balance_service(uuid) TO service_role;
