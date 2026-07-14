-- CRITICAL SECURITY FIX.
-- credit_wallet_service credits ANY user's wallet by `p_user_id` (not auth.uid()),
-- so it must be callable ONLY by the service role (the LemonSqueezy webhook).
-- The prior migration REVOKEd it from authenticated/anon but NOT from PUBLIC —
-- and CREATE FUNCTION grants EXECUTE to PUBLIC by default, so anon (part of PUBLIC)
-- could still call it and self-credit arbitrary amounts using the app's public key.
--
-- Fix: REVOKE FROM PUBLIC (the actual hole) + add an in-function service-role guard
-- (defense in depth — auth.role() reflects the CALLER's role even in SECURITY DEFINER).

REVOKE EXECUTE ON FUNCTION public.credit_wallet_service(uuid, bigint, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credit_wallet_service(uuid, bigint, text, text) FROM authenticated, anon;

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
  -- Only the service role (webhook) may credit an arbitrary user's wallet.
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

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

-- Re-assert grants (CREATE OR REPLACE re-adds the default PUBLIC grant, so revoke again).
REVOKE EXECUTE ON FUNCTION public.credit_wallet_service(uuid, bigint, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credit_wallet_service(uuid, bigint, text, text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.credit_wallet_service(uuid, bigint, text, text) TO service_role;

-- Hygiene: the caller-scoped RPCs (auth.uid()-based) are safe for anon (they return
-- not_authenticated), but revoke the default PUBLIC grant and grant only authenticated.
REVOKE EXECUTE ON FUNCTION public.get_credit_balance() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.debit_wallet(text, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_signup_credit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_credit_balance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.debit_wallet(text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_signup_credit() TO authenticated;
