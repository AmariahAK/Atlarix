-- Subscription allowances: expiring credit that lives BESIDE the purchased kind.
--
-- WHY A SEPARATE BALANCE AT ALL. Pro is $19/month including a monthly Core
-- allowance, PAYG on top; Reviewer is $19/month including enough Core to cover
-- normal review volume. Those allowances have to expire monthly — otherwise a
-- light user banks one, stops needing the subscription, and we have sold a
-- savings account. Purchased credit must NEVER expire: that is the user's money,
-- and expiring it is both a bad look and, in some jurisdictions, illegal.
--
-- Those two rules cannot coexist inside ONE pooled `balance_cents`, because a
-- single number cannot say how much of itself was granted.
--
-- WHY A TABLE AND NOT A `granted_cents` COLUMN. Because there are two products
-- and a customer can hold both. An allowance is applied with SET semantics (it
-- replaces the period's amount rather than adding to it), so two products
-- sharing one column means whichever renews second silently wipes the other's
-- allowance. One row per (user, product) makes that structurally impossible, and
-- it generalises to a third product without another migration of this shape.
--
-- SPEND ORDER: granted before purchased, and within granted, the allowance
-- belonging to the product being used first. If purchased credit went first, a
-- monthly reset would forfeit an allowance the user could have spent while their
-- own money was already gone — charging them for what the subscription covered.
-- Allowances DO spill across products, deliberately: it is one wallet, and
-- refusing to spill would show "out of credit" to somebody holding $8 of unspent
-- allowance.
--
-- WHAT THE BALANCE RPCs NOW MEAN. `balance_cents` in every RPC result becomes
-- SPENDABLE total (all allowances + purchased). That is why this migration needs
-- no client change: the proxy's pre-flight gate
-- (atlarix-proxy/src/entitlement.ts:114), the app's balance display
-- (src/ipc/handlers/auth_handlers.ts:337), `--doctor` (src/main/doctor.ts:121)
-- and the low-balance nudge all read that one key through an RPC, and all four
-- become correct the moment it includes allowances. Nothing reads credit_wallet
-- directly — checked across the app, the proxy and the reviewer.

-- ---------------------------------------------------------------------------
-- 1. credit_grants — one row per (user, product).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.credit_grants (
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  product text NOT NULL CHECK (product IN ('pro', 'reviewer')),
  cents bigint NOT NULL DEFAULT 0 CHECK (cents >= 0),
  -- The reference of the LAST APPLIED period, e.g. a LemonSqueezy invoice id.
  -- This is what makes a SET operation idempotent. The ledger's own (kind, ref)
  -- index cannot do that job: it makes repeated INSERTS safe, which assumes
  -- deltas ADD UP. An allowance does not add, it replaces — so a replay has to
  -- be refused before any arithmetic, not deduplicated after it.
  ref text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product)
);

COMMENT ON TABLE public.credit_grants IS
  'Expiring subscription allowances, one row per (user, product). Spent BEFORE credit_wallet.balance_cents and RESET (not incremented) each period — unspent allowance is forfeited by design.';

ALTER TABLE public.credit_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "credit_grants_select_own" ON public.credit_grants;
CREATE POLICY "credit_grants_select_own" ON public.credit_grants
  FOR SELECT USING (auth.uid() = user_id);

-- EXPLICIT GRANTS. A fresh table lands with service_role=Dxtm — no SELECT for
-- anyone — which makes the policy above UNREACHABLE rather than merely wrong: a
-- policy narrows rows a role may ALREADY read. Measured on this project's own
-- reviewer tables in 20260825120000.
REVOKE INSERT, UPDATE, DELETE ON public.credit_grants FROM authenticated, anon;
GRANT SELECT ON public.credit_grants TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.credit_grants TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Two new ledger kinds.
-- ---------------------------------------------------------------------------
-- 'grant_expiry' exists so the append-only ledger stays TRUE. Forfeiting unspent
-- allowance moves money out of the wallet; with no row for it, summing
-- credit_transactions would stop reconciling against the wallet and the
-- per-repo/per-source spend reporting built on this table would quietly drift.
ALTER TABLE public.credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_kind_check;
ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_kind_check
  CHECK (kind IN ('topup', 'debit', 'trial', 'refund', 'adjustment', 'grant', 'grant_expiry'));

-- ---------------------------------------------------------------------------
-- 3. spend_from_wallet — the ONE place the spend order lives.
-- ---------------------------------------------------------------------------
-- Extracted because debit_wallet and debit_wallet_service both need it, and a
-- spend order implemented twice is a spend order that will eventually disagree
-- with itself. Not SECURITY DEFINER and not granted to anyone: it is an internal
-- helper, called only from the two definer functions below, which have already
-- established who the caller is.
CREATE OR REPLACE FUNCTION public.spend_from_wallet(
  p_user_id uuid,
  p_cents bigint,
  p_preferred_product text
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  remaining bigint := p_cents;
  take bigint;
  rec record;
  total bigint;
BEGIN
  -- The allowance for the product actually being used, first.
  IF p_preferred_product IS NOT NULL THEN
    SELECT cents INTO take FROM credit_grants
    WHERE user_id = p_user_id AND product = p_preferred_product FOR UPDATE;
    IF take IS NOT NULL AND take > 0 THEN
      take := LEAST(take, remaining);
      UPDATE credit_grants SET cents = cents - take, updated_at = now()
      WHERE user_id = p_user_id AND product = p_preferred_product;
      remaining := remaining - take;
    END IF;
  END IF;

  -- Then any other allowance. Ordered by product so the outcome is
  -- deterministic rather than dependent on physical row order.
  FOR rec IN
    SELECT product, cents FROM credit_grants
    WHERE user_id = p_user_id
      AND cents > 0
      AND (p_preferred_product IS NULL OR product <> p_preferred_product)
    ORDER BY product
    FOR UPDATE
  LOOP
    EXIT WHEN remaining <= 0;
    take := LEAST(rec.cents, remaining);
    UPDATE credit_grants SET cents = cents - take, updated_at = now()
    WHERE user_id = p_user_id AND product = rec.product;
    remaining := remaining - take;
  END LOOP;

  -- Whatever is left comes out of the user's own money. This is the column
  -- allowed to go slightly negative on a reconciling debit, exactly as before —
  -- the proxy's pre-flight gate is what stops runaway spend, not this.
  UPDATE credit_wallet
  SET balance_cents = balance_cents - remaining, updated_at = now()
  WHERE user_id = p_user_id;

  SELECT COALESCE((SELECT SUM(cents) FROM credit_grants WHERE user_id = p_user_id), 0)
       + COALESCE((SELECT balance_cents FROM credit_wallet WHERE user_id = p_user_id), 0)
    INTO total;
  RETURN total;
END;
$$;
REVOKE ALL ON FUNCTION public.spend_from_wallet(uuid, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.spend_from_wallet(uuid, bigint, text) FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- 4. wallet_spendable — the ONE definition of "spendable".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wallet_spendable(p_user_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE((SELECT SUM(cents) FROM credit_grants WHERE user_id = p_user_id), 0)
       + COALESCE((SELECT balance_cents FROM credit_wallet WHERE user_id = p_user_id), 0);
$$;
REVOKE ALL ON FUNCTION public.wallet_spendable(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wallet_spendable(uuid) FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- 5. grant_monthly_credit_service — SET, not add. Service-role only.
-- ---------------------------------------------------------------------------
-- Deliberately NOT folded into credit_wallet_service. That function is
-- additive-only by contract ("Positive cents for topups, negative for refund
-- clawbacks") and every caller relies on it; giving one of its `kind` values
-- replace-semantics would make the same function mean two different things
-- depending on an argument.
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
  -- every request already makes (20260819120000). Granting to a banned account
  -- is harmless because they cannot spend it, and refusing would silently
  -- under-credit an account that is later unbanned.

  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;

  SELECT cents, ref INTO prior_cents, prior_ref FROM credit_grants
  WHERE user_id = p_user_id AND product = p_product FOR UPDATE;

  -- Idempotency: LemonSqueezy retries webhooks, and a redelivered
  -- subscription_payment_success must not re-grant a period already granted.
  IF prior_ref IS NOT NULL AND prior_ref = p_ref THEN
    RETURN jsonb_build_object(
      'ok', true, 'balance_cents', wallet_spendable(p_user_id),
      'granted_cents', COALESCE(prior_cents, 0), 'duplicate', true
    );
  END IF;

  -- Forfeit whatever is left of the previous period, on the record. The ref is
  -- product-scoped so two products expiring against the same invoice cannot
  -- collide on (kind, ref).
  IF COALESCE(prior_cents, 0) > 0 THEN
    INSERT INTO credit_transactions (user_id, delta_cents, kind, ref)
    VALUES (p_user_id, -prior_cents, 'grant_expiry', p_product || ':' || p_ref)
    ON CONFLICT (kind, ref) DO NOTHING;
  END IF;

  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref)
  VALUES (p_user_id, p_cents, 'grant', p_product || ':' || p_ref)
  ON CONFLICT (kind, ref) DO NOTHING;

  INSERT INTO credit_grants (user_id, product, cents, ref)
  VALUES (p_user_id, p_product, p_cents, p_ref)
  ON CONFLICT (user_id, product) DO UPDATE
  SET cents = EXCLUDED.cents, ref = EXCLUDED.ref, updated_at = now();

  RETURN jsonb_build_object(
    'ok', true, 'balance_cents', wallet_spendable(p_user_id), 'granted_cents', p_cents
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. clear_monthly_grant_service — cancellation / expiry.
-- ---------------------------------------------------------------------------
-- When a subscription ends, its allowance goes with it. Purchased credit is
-- untouched, and the OTHER product's allowance is untouched — which is the whole
-- reason this is a per-product row rather than a shared column.
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
    RETURN jsonb_build_object(
      'ok', true, 'balance_cents', wallet_spendable(p_user_id), 'noop', true
    );
  END IF;

  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref)
  VALUES (p_user_id, -prior_cents, 'grant_expiry', p_product || ':' || p_ref)
  ON CONFLICT (kind, ref) DO NOTHING;

  UPDATE credit_grants SET cents = 0, ref = NULL, updated_at = now()
  WHERE user_id = p_user_id AND product = p_product;

  RETURN jsonb_build_object('ok', true, 'balance_cents', wallet_spendable(p_user_id));
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. debit_wallet — allowance first, then purchased.
-- ---------------------------------------------------------------------------
-- A session-authenticated debit is always app usage, so 'pro' is the preferred
-- allowance. Everything else is the 20260714120000 original unchanged, including
-- the (kind, ref) duplicate no-op.
CREATE OR REPLACE FUNCTION public.debit_wallet(p_generation_id text, p_cents bigint)
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
  IF p_cents IS NULL OR p_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;
  IF p_generation_id IS NULL OR length(trim(p_generation_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_generation_id');
  END IF;

  INSERT INTO credit_wallet (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref)
  VALUES (uid, -p_cents, 'debit', p_generation_id)
  ON CONFLICT (kind, ref) DO NOTHING;
  IF NOT FOUND THEN
    -- Already charged for this generation — no-op.
    RETURN jsonb_build_object(
      'ok', true, 'balance_cents', wallet_spendable(uid), 'duplicate', true
    );
  END IF;

  bal := spend_from_wallet(uid, p_cents, 'pro');
  RETURN jsonb_build_object('ok', true, 'balance_cents', bal);
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. debit_wallet_service — same change; the preferred allowance follows source.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.debit_wallet_service(
  p_user_id uuid,
  p_generation_id text,
  p_cents bigint,
  p_source text DEFAULT 'reviewer',
  p_repo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bal bigint;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;
  IF p_cents IS NULL OR p_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;
  IF p_generation_id IS NULL OR length(trim(p_generation_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_generation_id');
  END IF;
  IF p_source NOT IN ('app', 'reviewer') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_source');
  END IF;

  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref, source, repo)
  VALUES (p_user_id, -p_cents, 'debit', p_generation_id, p_source, p_repo)
  ON CONFLICT (kind, ref) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'balance_cents', wallet_spendable(p_user_id), 'duplicate', true
    );
  END IF;

  -- 'app' -> the Pro allowance, 'reviewer' -> the Reviewer allowance. Spilling
  -- into the other one is allowed (see the header) — this only decides which is
  -- drawn down first, so that a review consumes the allowance bought for reviews.
  bal := spend_from_wallet(
    p_user_id, p_cents, CASE WHEN p_source = 'reviewer' THEN 'reviewer' ELSE 'pro' END
  );
  RETURN jsonb_build_object('ok', true, 'balance_cents', bal);
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. The two balance reads — now SPENDABLE total, with the split alongside.
-- ---------------------------------------------------------------------------
-- The ban gate is re-asserted verbatim in both. It rides the wallet read the
-- proxy ALREADY makes on every request, which is the only reason it cannot be
-- skipped — and a rewrite of these functions is exactly where it would be lost.
CREATE OR REPLACE FUNCTION public.get_credit_balance()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  granted bigint;
  purchased bigint;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  -- Before the wallet upsert: a banned account should not even get a row created.
  IF EXISTS (SELECT 1 FROM users WHERE id = uid AND banned_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;
  INSERT INTO credit_wallet (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING;
  SELECT COALESCE(SUM(cents), 0) INTO granted FROM credit_grants WHERE user_id = uid;
  SELECT balance_cents INTO purchased FROM credit_wallet WHERE user_id = uid;
  RETURN jsonb_build_object(
    'ok', true,
    'balance_cents', COALESCE(granted, 0) + COALESCE(purchased, 0),
    'granted_cents', COALESCE(granted, 0),
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
  purchased bigint;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;
  -- Same ban gate, same error string: the proxy maps 'account_banned' to a 403
  -- for both callers, so that handling is not written twice.
  IF EXISTS (SELECT 1 FROM users WHERE id = p_user_id AND banned_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;
  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT COALESCE(SUM(cents), 0) INTO granted FROM credit_grants WHERE user_id = p_user_id;
  SELECT balance_cents INTO purchased FROM credit_wallet WHERE user_id = p_user_id;
  RETURN jsonb_build_object(
    'ok', true,
    'balance_cents', COALESCE(granted, 0) + COALESCE(purchased, 0),
    'granted_cents', COALESCE(granted, 0),
    'purchased_cents', COALESCE(purchased, 0)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 10. GRANTS. CREATE OR REPLACE re-adds the default PUBLIC EXECUTE grant on
-- EVERY run, and revoking from authenticated/anon does NOT remove it. This is
-- the hole that made credit_wallet_service anon-callable in v14.11.0. Revoke
-- AFTER the final definition, never before.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.grant_monthly_credit_service(uuid, text, bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.grant_monthly_credit_service(uuid, text, bigint, text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.grant_monthly_credit_service(uuid, text, bigint, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.clear_monthly_grant_service(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clear_monthly_grant_service(uuid, text, text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.clear_monthly_grant_service(uuid, text, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.debit_wallet(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.debit_wallet(text, bigint) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.debit_wallet_service(uuid, text, bigint, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.debit_wallet_service(uuid, text, bigint, text, text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.debit_wallet_service(uuid, text, bigint, text, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.get_credit_balance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_credit_balance() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_credit_balance_service(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_credit_balance_service(uuid) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.get_credit_balance_service(uuid) TO service_role;
