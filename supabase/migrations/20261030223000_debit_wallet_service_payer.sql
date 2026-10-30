-- Workspace pays, service debits: the Slack assistant's model calls (service
-- caller, source 'cloud') can be billed to a workspace payer for a member, like
-- cloud runs. Also admits source 'cloud' and billing 'cloud', which the
-- assistant path already sends and the check refused.
BEGIN;
DROP FUNCTION IF EXISTS public.debit_wallet_service(uuid, text, bigint, text, text, text);
CREATE OR REPLACE FUNCTION public.debit_wallet_service(
  p_user_id uuid, p_generation_id text, p_cents bigint, p_source text DEFAULT 'reviewer', p_repo text DEFAULT NULL, p_billing text DEFAULT NULL,
  p_billed_for uuid DEFAULT NULL, p_slack_team_id text DEFAULT NULL, p_slack_channel text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  bal bigint;
  DEBIT_MAX_CENTS CONSTANT bigint := 5000;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  IF p_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'missing_user'); END IF;
  IF public.account_is_banned(p_user_id) THEN RETURN jsonb_build_object('ok', false, 'error', 'account_banned'); END IF;
  IF p_billed_for IS NOT NULL AND public.account_is_banned(p_billed_for) THEN RETURN jsonb_build_object('ok', false, 'error', 'account_banned'); END IF;
  IF p_cents IS NULL OR p_cents <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount'); END IF;
  IF p_cents > DEBIT_MAX_CENTS THEN RETURN jsonb_build_object('ok', false, 'error', 'amount_too_large', 'max_cents', DEBIT_MAX_CENTS); END IF;
  IF p_generation_id IS NULL OR length(trim(p_generation_id)) = 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'missing_generation_id'); END IF;
  IF p_source NOT IN ('app', 'reviewer', 'cli', 'extension', 'cloud') THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_source'); END IF;
  IF p_billing IS NOT NULL AND p_billing NOT IN ('auto_paid', 'core', 'tool', 'reviewer', 'cloud') THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_billing'); END IF;
  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref, source, repo, billing, billed_for, slack_team_id, slack_channel)
  VALUES (p_user_id, -p_cents, 'debit', p_generation_id, p_source, p_repo,
          COALESCE(p_billing, CASE WHEN p_source = 'reviewer' THEN 'reviewer' WHEN p_source = 'cloud' THEN 'cloud' END),
          CASE WHEN p_billed_for IS DISTINCT FROM p_user_id THEN p_billed_for END, left(p_slack_team_id, 32), left(p_slack_channel, 32))
  ON CONFLICT (kind, ref) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'balance_cents', wallet_spendable(p_user_id), 'duplicate', true);
  END IF;
  bal := spend_from_wallet(p_user_id, p_cents, CASE WHEN p_source = 'reviewer' THEN 'reviewer' ELSE 'pro' END);
  RETURN jsonb_build_object('ok', true, 'balance_cents', bal);
END;
$$;
REVOKE ALL ON FUNCTION public.debit_wallet_service(uuid, text, bigint, text, text, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_wallet_service(uuid, text, bigint, text, text, text, uuid, text, text) TO service_role;
COMMIT;
