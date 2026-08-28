-- Refunds that understand the difference between an allowance and money.
--
-- WHAT WAS BROKEN. `order_refunded` clawed back a PAYG top-up and nothing else;
-- `subscription_payment_refunded` had no branch at all, so it fell to the
-- webhook's `default:` and was 200-ACKed in silence. Refunding a Pro month left
-- the tier active AND left the allowance sitting in the wallet.
--
-- THE DISTINCTION THIS MIGRATION EXISTS FOR. A credit top-up and a subscription
-- fee are refunded with the same word and mean opposite things:
--
--   * A top-up refund returns money the user spent ON CREDIT. The clawback is
--     the credit itself, it comes out of credit_wallet.balance_cents, and it is
--     allowed to drive that column negative — which is not a new hazard but the
--     existing documented design (credit_wallet_service has no floor, and
--     spend_from_wallet's own comment says that column may go negative because
--     the proxy's pre-flight gate is what stops runaway spend). Flooring it at
--     zero would make buy -> burn -> refund free, which is the whole reason not
--     to.
--
--   * A subscription refund returns a FEE. $19 bought entitlement plus an
--     allowance; it did not buy $19 of credit. So it claws back the GRANT, and
--     purchased credit is never touched — that is the user's own money from an
--     unrelated transaction, and taking it would be theft dressed as a refund.
--
-- WHY THE GRANT IS FLOORED AT ZERO AND THE WALLET IS NOT. Two reasons, and the
-- first is that credit_grants.cents carries `CHECK (cents >= 0)`, so an
-- unfloored subtraction does not go negative — it raises 23514 and the refund
-- fails. The second is the one that matters even without the constraint: an
-- allowance is per-period, so a negative grant would be silently carried into
-- the NEXT period's SET and eat an allowance the user has not been refunded for.
-- A past month must not bill a future one.
--
-- Owner's policy, settled 2026-08-27 and recorded in docs/TODO.md so it is not
-- re-argued: full clawback on purchased credit even when already spent; floor at
-- zero on grants; a refunded subscription month drops the tier IMMEDIATELY
-- (unlike a cancellation, which rightly runs to period end); and Reviewer
-- refunds are prorated-forward only, because a posted review cannot be unposted.

-- ---------------------------------------------------------------------------
-- 1. A ledger kind for it.
-- ---------------------------------------------------------------------------
-- The append-only ledger has to stay TRUE — summing credit_transactions must
-- keep reconciling against the wallet, because the per-source and per-repo spend
-- reporting is built on that sum. A refund that moved money with no row would
-- make the ledger drift, quietly, in the direction of overstating revenue.
--
-- 'grant_refund' rather than reusing 'grant_expiry': both remove allowance, but
-- one is a subscription ending normally and the other is money going back to a
-- customer. Collapsing them would destroy the only signal that distinguishes
-- churn from refund in the ledger.
--
-- THE TRAP: credit_transactions.kind is CHECK-constrained. Widening it is not
-- optional housekeeping — without this the INSERT below raises 23514 on a code
-- path whose entire job is to move money back quietly, so it would fail exactly
-- where it is least likely to be watched. `review_history.kind` taught this the
-- hard way on 2026-08-26.
ALTER TABLE public.credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_kind_check;
ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_kind_check
  CHECK (kind IN (
    'topup', 'debit', 'trial', 'refund', 'adjustment',
    'grant', 'grant_expiry', 'grant_refund'
  ));

-- ---------------------------------------------------------------------------
-- 2. refund_grant_service — take back allowance, never more than is there.
-- ---------------------------------------------------------------------------
-- Deliberately NOT folded into clear_monthly_grant_service. That function means
-- "this subscription has ended, the allowance goes with it" and always zeroes.
-- This one means "some fraction of this period was refunded", takes a partial
-- amount, and files a different ledger kind. Giving one function two meanings
-- depending on an argument is what made the earlier grant/expiry pair confusing
-- enough to need this comment.
--
-- RETURNS the amount actually taken, not just ok/error. The caller needs to know
-- when the grant was already spent and the clawback fell short of the refund,
-- because that is a real business fact (we refunded a month whose credit was
-- consumed) and the honest place to notice it is a log line, not silence.
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
  -- Zero is not a no-op worth accepting quietly: it means the caller computed a
  -- refund fraction wrong, and returning ok would hide that.
  IF p_cents IS NULL OR p_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;
  IF p_ref IS NULL OR length(trim(p_ref)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_ref');
  END IF;

  -- FOR UPDATE, matching spend_from_wallet: a refund and a concurrent debit on
  -- the same grant row must serialise, or the clamp below is computed against a
  -- balance that has already moved.
  SELECT cents INTO prior_cents FROM credit_grants
  WHERE user_id = p_user_id AND product = p_product FOR UPDATE;

  -- No grant, or nothing left in it. Not an error: refunding a month whose
  -- allowance was fully spent is an ordinary outcome and the subscription state
  -- still has to be updated by the caller.
  IF prior_cents IS NULL OR prior_cents = 0 THEN
    RETURN jsonb_build_object(
      'ok', true, 'taken_cents', 0, 'requested_cents', p_cents,
      'balance_cents', wallet_spendable(p_user_id), 'noop', true
    );
  END IF;

  taken := LEAST(prior_cents, p_cents);

  -- Idempotency is the ledger's, not ours: a redelivered refund webhook hits the
  -- unique (kind, ref) index and inserts nothing. Checked with FOUND rather than
  -- assumed, because the UPDATE below is NOT idempotent on its own — running it
  -- twice would take the allowance twice.
  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref)
  VALUES (p_user_id, -taken, 'grant_refund', p_product || ':' || p_ref)
  ON CONFLICT (kind, ref) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'taken_cents', 0, 'requested_cents', p_cents,
      'balance_cents', wallet_spendable(p_user_id), 'duplicate', true
    );
  END IF;

  UPDATE credit_grants SET cents = cents - taken, updated_at = now()
  WHERE user_id = p_user_id AND product = p_product;

  RETURN jsonb_build_object(
    'ok', true, 'taken_cents', taken, 'requested_cents', p_cents,
    'shortfall_cents', p_cents - taken,
    'balance_cents', wallet_spendable(p_user_id)
  );
END;
$$;

-- CREATE OR REPLACE re-adds the default PUBLIC grant, so revoke every time.
-- Postgres granting EXECUTE to PUBLIC on a SECURITY DEFINER function is the
-- single most repeated footgun in this schema.
REVOKE EXECUTE ON FUNCTION public.refund_grant_service(uuid, text, bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refund_grant_service(uuid, text, bigint, text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.refund_grant_service(uuid, text, bigint, text) TO service_role;

COMMENT ON FUNCTION public.refund_grant_service(uuid, text, bigint, text) IS
  'Claw back part or all of a product allowance on a subscription refund. Floors at zero (a grant must never carry a debt into the next period) and never touches purchased credit.';
