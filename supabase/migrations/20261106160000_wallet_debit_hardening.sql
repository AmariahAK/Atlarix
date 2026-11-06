-- Wallet debits, audit 2026-11-06 (guarded by src/__tests__/wallet-hardening-migrations.test.ts).
--
-- 1. debit_wallet_service gets debit_wallet's -$50 floor: the proxy now charges
--    signed-in users through it (the user id comes from the JWT the proxy verified),
--    so it is the floor every user charge meets. A duplicate is checked before the
--    floor, as in debit_wallet, so a retried charge still answers duplicate.
--    debit_wallet itself is revoked from authenticated in a LATER file
--    (20261106170000), applied only once the proxy no longer calls it.
-- 2. All three debits lock the payer's credit_wallet row FOR UPDATE (after making
--    sure it exists) before the duplicate and floor checks, so two concurrent
--    debits cannot both pass a floor only one fits under. Lock order is
--    credit_wallet -> credit_grants (spend_from_wallet), the same for every debit.
-- 3. No ban refusal in the debits: a ban stops NEW turns at the balance read
--    (get_credit_balance / get_credit_balance_service, the proxy's ban check); a
--    turn already served is still charged (docs/DESIGN_NOTES.md, "Account bans").
--
-- Every other check is unchanged. CREATE OR REPLACE keeps the ACLs; the REVOKE/GRANT
-- lines are repeated anyway so this file says what each function's callers are.
BEGIN;

CREATE OR REPLACE FUNCTION public.debit_wallet(
  p_generation_id text, p_cents bigint, p_source text DEFAULT 'app', p_billing text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  uid uuid := auth.uid();
  bal bigint;
  DEBIT_MAX_CENTS CONSTANT bigint := 5000;
  DEBIT_FLOOR_CENTS CONSTANT bigint := -5000;
BEGIN
  IF uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated'); END IF;
  IF p_cents IS NULL OR p_cents <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount'); END IF;
  IF p_cents > DEBIT_MAX_CENTS THEN RETURN jsonb_build_object('ok', false, 'error', 'amount_too_large', 'max_cents', DEBIT_MAX_CENTS); END IF;
  IF p_generation_id IS NULL OR length(trim(p_generation_id)) = 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'missing_generation_id'); END IF;
  IF p_source IS NULL OR p_source NOT IN ('app', 'cli', 'extension') THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_source'); END IF;
  IF p_billing IS NOT NULL AND p_billing NOT IN ('auto_paid', 'core', 'tool') THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_billing'); END IF;
  INSERT INTO credit_wallet (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM credit_wallet WHERE user_id = uid FOR UPDATE;
  IF EXISTS (SELECT 1 FROM credit_transactions WHERE kind = 'debit' AND ref = p_generation_id) THEN
    RETURN jsonb_build_object('ok', true, 'balance_cents', wallet_spendable(uid), 'duplicate', true);
  END IF;
  IF wallet_spendable(uid) - p_cents < DEBIT_FLOOR_CENTS THEN
    RETURN jsonb_build_object('ok', false, 'error', 'insufficient_funds', 'balance_cents', wallet_spendable(uid));
  END IF;
  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref, source, billing)
  VALUES (uid, -p_cents, 'debit', p_generation_id, p_source, p_billing)
  ON CONFLICT (kind, ref) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'balance_cents', wallet_spendable(uid), 'duplicate', true);
  END IF;
  bal := spend_from_wallet(uid, p_cents, 'pro');
  RETURN jsonb_build_object('ok', true, 'balance_cents', bal);
END;
$$;
-- Still callable by signed-in users until 20261106170000 (after the proxy deploy).
REVOKE ALL ON FUNCTION public.debit_wallet(text, bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.debit_wallet(text, bigint, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.debit_wallet_service(
  p_user_id uuid, p_generation_id text, p_cents bigint, p_source text DEFAULT 'reviewer', p_repo text DEFAULT NULL, p_billing text DEFAULT NULL,
  p_billed_for uuid DEFAULT NULL, p_slack_team_id text DEFAULT NULL, p_slack_channel text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  bal bigint;
  DEBIT_MAX_CENTS CONSTANT bigint := 5000;
  DEBIT_FLOOR_CENTS CONSTANT bigint := -5000;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  IF p_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'missing_user'); END IF;
  IF p_cents IS NULL OR p_cents <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount'); END IF;
  IF p_cents > DEBIT_MAX_CENTS THEN RETURN jsonb_build_object('ok', false, 'error', 'amount_too_large', 'max_cents', DEBIT_MAX_CENTS); END IF;
  IF p_generation_id IS NULL OR length(trim(p_generation_id)) = 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'missing_generation_id'); END IF;
  IF p_source NOT IN ('app', 'reviewer', 'cli', 'extension', 'cloud') THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_source'); END IF;
  IF p_billing IS NOT NULL AND p_billing NOT IN ('auto_paid', 'core', 'tool', 'reviewer', 'cloud') THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_billing'); END IF;
  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM credit_wallet WHERE user_id = p_user_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM credit_transactions WHERE kind = 'debit' AND ref = p_generation_id) THEN
    RETURN jsonb_build_object('ok', true, 'balance_cents', wallet_spendable(p_user_id), 'duplicate', true);
  END IF;
  IF wallet_spendable(p_user_id) - p_cents < DEBIT_FLOOR_CENTS THEN
    RETURN jsonb_build_object('ok', false, 'error', 'insufficient_funds', 'balance_cents', wallet_spendable(p_user_id));
  END IF;
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

CREATE OR REPLACE FUNCTION public.debit_wallet_cloud(
  p_user_id uuid, p_job_id uuid, p_generation_id text, p_cents bigint, p_billing text DEFAULT 'cloud',
  p_billed_for uuid DEFAULT NULL, p_slack_team_id text DEFAULT NULL, p_slack_channel text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  bal bigint;
  job_repo text;
  job_owner uuid;
  job_payer uuid;
  DEBIT_MAX_CENTS CONSTANT bigint := 5000;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  IF p_cents IS NULL OR p_cents <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount'); END IF;
  IF p_cents > DEBIT_MAX_CENTS THEN RETURN jsonb_build_object('ok', false, 'error', 'amount_too_large', 'max_cents', DEBIT_MAX_CENTS); END IF;
  IF p_generation_id IS NULL OR length(trim(p_generation_id)) = 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'missing_generation_id'); END IF;
  SELECT repo, user_id, payer_user_id INTO job_repo, job_owner, job_payer
    FROM cloud_jobs WHERE id = p_job_id AND state = 'running' FOR UPDATE;
  IF job_repo IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'job_not_running'); END IF;
  IF job_owner <> COALESCE(p_billed_for, p_user_id) THEN RETURN jsonb_build_object('ok', false, 'error', 'job_not_running'); END IF;
  IF COALESCE(job_payer, job_owner) <> p_user_id THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_payer'); END IF;
  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM credit_wallet WHERE user_id = p_user_id FOR UPDATE;
  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref, source, repo, billing, billed_for, slack_team_id, slack_channel)
  VALUES (p_user_id, -p_cents, 'debit', p_generation_id, 'cloud', job_repo, COALESCE(p_billing, 'cloud'),
          CASE WHEN p_billed_for IS DISTINCT FROM p_user_id THEN p_billed_for END, left(p_slack_team_id, 32), left(p_slack_channel, 32))
  ON CONFLICT (kind, ref) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'balance_cents', wallet_spendable(p_user_id), 'duplicate', true);
  END IF;
  bal := spend_from_wallet(p_user_id, p_cents, 'pro');
  UPDATE cloud_jobs SET spent_cents = spent_cents + p_cents, updated_at = now() WHERE id = p_job_id;
  RETURN jsonb_build_object('ok', true, 'balance_cents', bal);
END;
$$;
REVOKE ALL ON FUNCTION public.debit_wallet_cloud(uuid, uuid, text, bigint, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_wallet_cloud(uuid, uuid, text, bigint, text, uuid, text, text) TO service_role;

COMMIT;
