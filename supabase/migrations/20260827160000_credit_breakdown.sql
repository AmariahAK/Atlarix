-- Per-product allowance, and per-product SPEND.
--
-- WHY A SECOND READ RATHER THAN MORE KEYS ON get_credit_balance. That RPC is on
-- the hot path — the proxy calls it before every request — and it must stay one
-- cheap row. This one is for the account page, called when a human opens it.
--
-- WHAT IT CAN AND CANNOT SAY, because the difference matters:
--
--   * PER-PRODUCT ALLOWANCE IS REAL. `credit_grants` is one row per (user,
--     product), so "Pro allowance 30% used" is a true statement about a row that
--     exists.
--   * PER-PRODUCT PURCHASED CREDIT DOES NOT EXIST. `credit_wallet` is a SINGLE
--     shared balance. There is no "the reviewer's credit" to report, and
--     inventing one would be a lie with money attached.
--   * SO SPEND IS THE HONEST PER-PRODUCT NUMBER. Every debit already carries a
--     `source` ('app' or 'reviewer'), written at the point of spend, so what each
--     product has CONSUMED is recorded fact rather than a derived guess.
--
-- And the spill is why the distinction is not pedantic: `spend_from_wallet`
-- deliberately lets one product's allowance pay for the other, so a reviewer
-- debit may well have come out of the Pro allowance. Reporting spend by source
-- says what happened; reporting a per-product balance would claim a boundary the
-- wallet does not have.

CREATE OR REPLACE FUNCTION public.get_credit_breakdown(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  allowances jsonb;
  spend jsonb;
  purchased bigint;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE id = uid AND banned_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'product', product,
             'cents', cents,
             'total_cents', total_cents
           ) ORDER BY product
         ), '[]'::jsonb)
    INTO allowances
    FROM credit_grants
   WHERE user_id = uid AND total_cents > 0;

  -- Debits only, and negated so the caller reads a positive amount spent.
  -- A window rather than "this period": with one shared wallet and two products
  -- there is no single period boundary to point at, and a made-up one would be
  -- less honest than a stated number of days.
  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.cents_spent DESC), '[]'::jsonb)
    INTO spend
    FROM (
      SELECT COALESCE(source, 'app') AS source,
             SUM(-delta_cents)::bigint AS cents_spent,
             COUNT(*)::bigint AS entries
        FROM credit_transactions
       WHERE user_id = uid
         AND kind = 'debit'
         AND created_at >= now() - make_interval(days => days)
       GROUP BY COALESCE(source, 'app')
    ) t;

  SELECT balance_cents INTO purchased FROM credit_wallet WHERE user_id = uid;

  RETURN jsonb_build_object(
    'ok', true,
    'window_days', days,
    -- The one shared pot. Named so nobody reads it as per-product.
    'purchased_cents', COALESCE(purchased, 0),
    'allowances', allowances,
    'spend_by_source', spend
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_credit_breakdown(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_credit_breakdown(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_credit_breakdown(integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_credit_breakdown(integer) IS
  'Account-page detail: per-product allowance (real, one row per product) and per-product SPEND from the ledger source column. Purchased credit is a single shared pot and is returned as one number, deliberately — there is no per-product balance to report.';
