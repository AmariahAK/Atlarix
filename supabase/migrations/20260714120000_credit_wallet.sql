-- =============================================================================
-- credit_wallet — PAYG prepaid credit for Atlarix Core.
-- =============================================================================
-- The pricing reframe makes Atlarix Core pay-as-you-go on every tier (Free + Pro):
-- the harness is the subscription, tokens are a metered prepaid balance. This
-- replaces the monthly token *allowance* model (compass_tokens) with a dollar
-- *balance* in integer cents.
--
-- ADDITIVE ONLY — safe to apply while the old compass_tokens model still runs.
-- The proxy switches to these RPCs; the allowance RPCs are retired in the later
-- teardown migration, only AFTER the proxy is redeployed against this schema.
-- =============================================================================

-- Wallet: one row per user, balance in integer cents.
CREATE TABLE IF NOT EXISTS public.credit_wallet (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  balance_cents bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only ledger. `ref` is the idempotency key:
--   topup/refund -> LemonSqueezy order_id
--   debit        -> OpenRouter generation id
--   trial        -> the user's own id (one-time $1 signup credit)
CREATE TABLE IF NOT EXISTS public.credit_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  delta_cents bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('topup', 'debit', 'trial', 'refund', 'adjustment')),
  ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One transaction per (kind, ref) — makes every credit/debit idempotent under
-- webhook retries and streamed-usage reconnects.
CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_kind_ref_uniq
  ON public.credit_transactions (kind, ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user ON public.credit_transactions (user_id);

ALTER TABLE public.credit_wallet ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;

-- Owner may READ own wallet + ledger. All WRITES go through the SECURITY DEFINER
-- RPCs below (or the service role for webhooks) — no direct table writes.
CREATE POLICY "credit_wallet_select_own" ON public.credit_wallet
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "credit_transactions_select_own" ON public.credit_transactions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

COMMENT ON TABLE public.credit_wallet IS 'PAYG Atlarix Core balance per user (integer cents)';
COMMENT ON TABLE public.credit_transactions IS 'Append-only credit ledger; (kind, ref) is the idempotency key';

-- Defense-in-depth (mirrors compass_tokens_revoke_direct_write): all writes flow
-- ONLY through the SECURITY DEFINER RPCs below / the service role. Revoke direct
-- DML so a future permissive policy or grant can't silently re-open direct writes.
REVOKE INSERT, UPDATE, DELETE ON public.credit_wallet FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.credit_transactions FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- get_credit_balance() — owner reads own balance (creates a 0 row on first call)
-- ---------------------------------------------------------------------------
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
  INSERT INTO credit_wallet (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING;
  SELECT balance_cents INTO bal FROM credit_wallet WHERE user_id = uid;
  RETURN jsonb_build_object('ok', true, 'balance_cents', COALESCE(bal, 0));
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_credit_balance() TO authenticated;

-- ---------------------------------------------------------------------------
-- debit_wallet(generation_id, cents) — charge the CALLING user for one Core
-- generation. Idempotent on ('debit', generation_id): a retried/duplicated
-- reconcile never double-charges. Balance may dip slightly negative on the
-- reconciling debit; the proxy's pre-flight balance>0 gate stops runaway spend.
-- ---------------------------------------------------------------------------
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
    SELECT balance_cents INTO bal FROM credit_wallet WHERE user_id = uid;
    RETURN jsonb_build_object('ok', true, 'balance_cents', bal, 'duplicate', true);
  END IF;

  UPDATE credit_wallet
  SET balance_cents = balance_cents - p_cents, updated_at = now()
  WHERE user_id = uid
  RETURNING balance_cents INTO bal;

  RETURN jsonb_build_object('ok', true, 'balance_cents', bal);
END;
$$;
GRANT EXECUTE ON FUNCTION public.debit_wallet(text, bigint) TO authenticated;

-- ---------------------------------------------------------------------------
-- credit_wallet_service(user_id, cents, kind, ref) — service-role only (LS
-- webhook). Idempotent on (kind, ref). Positive cents for topups, negative for
-- refund clawbacks.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.credit_wallet_service(
  p_user_id uuid, p_cents bigint, p_kind text, p_ref text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bal bigint;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;
  IF p_kind NOT IN ('topup', 'refund', 'adjustment') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_kind');
  END IF;
  IF p_cents IS NULL OR p_cents = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;
  IF p_ref IS NULL OR length(trim(p_ref)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_ref');
  END IF;

  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref)
  VALUES (p_user_id, p_cents, p_kind, p_ref)
  ON CONFLICT (kind, ref) DO NOTHING;
  IF NOT FOUND THEN
    SELECT balance_cents INTO bal FROM credit_wallet WHERE user_id = p_user_id;
    RETURN jsonb_build_object('ok', true, 'balance_cents', bal, 'duplicate', true);
  END IF;

  UPDATE credit_wallet
  SET balance_cents = balance_cents + p_cents, updated_at = now()
  WHERE user_id = p_user_id
  RETURNING balance_cents INTO bal;

  RETURN jsonb_build_object('ok', true, 'balance_cents', bal);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.credit_wallet_service(uuid, bigint, text, text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.credit_wallet_service(uuid, bigint, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- claim_signup_credit() — one-time $1 (100c) trial credit per user. Idempotent
-- on ('trial', uid) so repeat calls (or re-logins) never re-grant.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_signup_credit()
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

  INSERT INTO credit_wallet (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref)
  VALUES (uid, 100, 'trial', uid::text)
  ON CONFLICT (kind, ref) DO NOTHING;
  IF NOT FOUND THEN
    SELECT balance_cents INTO bal FROM credit_wallet WHERE user_id = uid;
    RETURN jsonb_build_object('ok', true, 'balance_cents', bal, 'already_claimed', true);
  END IF;

  UPDATE credit_wallet
  SET balance_cents = balance_cents + 100, updated_at = now()
  WHERE user_id = uid
  RETURNING balance_cents INTO bal;

  RETURN jsonb_build_object('ok', true, 'balance_cents', bal, 'granted', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.claim_signup_credit() TO authenticated;
