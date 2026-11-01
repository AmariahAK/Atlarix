-- Workspace pays (Slack), 15.12. Owner, 2026-10-30: "build on credits".
--
-- One linked member of a Slack workspace makes their own Atlarix account the
-- workspace's payer. From then on every task asked in that workspace is billed
-- to the payer's wallet (Pro allowance first, then credits, as for their own
-- use); the asker keeps ownership of the job and its approvals. The ledger row
-- says who it was for (`billed_for`) and where (`slack_team_id`, `slack_channel`),
-- so the payer gets a Team view and the member sees "paid by <workspace>".
-- No caps in v1. Every function is grant-scoped; nothing new is exposed to anon.
BEGIN;

ALTER TABLE public.slack_installs
  ADD COLUMN IF NOT EXISTS payer_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payer_mode text NOT NULL DEFAULT 'members' CHECK (payer_mode IN ('members', 'account')),
  ADD COLUMN IF NOT EXISTS payer_set_at timestamptz,
  -- The once-a-day "your workspace's pot is empty" DM to the payer (the reviewer dedupes here).
  ADD COLUMN IF NOT EXISTS payer_empty_notified_at timestamptz;

ALTER TABLE public.credit_transactions
  ADD COLUMN IF NOT EXISTS billed_for uuid,
  ADD COLUMN IF NOT EXISTS slack_team_id text CHECK (length(slack_team_id) <= 32),
  ADD COLUMN IF NOT EXISTS slack_channel text CHECK (length(slack_channel) <= 32);
CREATE INDEX IF NOT EXISTS credit_transactions_billed_for_idx ON public.credit_transactions (billed_for, created_at) WHERE billed_for IS NOT NULL;

-- The payer is fixed when the job is created, so a toggle flipped mid-run never
-- moves a running job's bill.
ALTER TABLE public.cloud_jobs ADD COLUMN IF NOT EXISTS payer_user_id uuid;

/** The cloud debit, now with "whose wallet" (p_user_id) apart from "whose job" (p_billed_for). */
DROP FUNCTION IF EXISTS public.debit_wallet_cloud(uuid, uuid, text, bigint, text);
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
  IF public.account_is_banned(p_user_id) THEN RETURN jsonb_build_object('ok', false, 'error', 'account_banned'); END IF;
  IF p_billed_for IS NOT NULL AND public.account_is_banned(p_billed_for) THEN RETURN jsonb_build_object('ok', false, 'error', 'account_banned'); END IF;
  IF p_cents IS NULL OR p_cents <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount'); END IF;
  IF p_cents > DEBIT_MAX_CENTS THEN RETURN jsonb_build_object('ok', false, 'error', 'amount_too_large', 'max_cents', DEBIT_MAX_CENTS); END IF;
  IF p_generation_id IS NULL OR length(trim(p_generation_id)) = 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'missing_generation_id'); END IF;
  SELECT repo, user_id, payer_user_id INTO job_repo, job_owner, job_payer
    FROM cloud_jobs WHERE id = p_job_id AND state = 'running' FOR UPDATE;
  IF job_repo IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'job_not_running'); END IF;
  -- The job must belong to the person it is billed for, and the wallet must be
  -- the job's recorded payer (or the owner's own, when nobody else pays).
  IF job_owner <> COALESCE(p_billed_for, p_user_id) THEN RETURN jsonb_build_object('ok', false, 'error', 'job_not_running'); END IF;
  IF COALESCE(job_payer, job_owner) <> p_user_id THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_payer'); END IF;
  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
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

/** A linked member makes their own account the payer ('account'), or the payer/installer hands it back ('members'). */
CREATE OR REPLACE FUNCTION public.set_slack_payer(p_team_id text, p_mode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  uid uuid := auth.uid();
  inst slack_installs%ROWTYPE;
BEGIN
  IF uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated'); END IF;
  IF public.account_is_banned(uid) THEN RETURN jsonb_build_object('ok', false, 'error', 'account_banned'); END IF;
  IF p_mode NOT IN ('members', 'account') THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_mode'); END IF;
  SELECT * INTO inst FROM slack_installs WHERE team_id = p_team_id FOR UPDATE;
  IF inst.team_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_installed'); END IF;
  IF NOT EXISTS (SELECT 1 FROM slack_links WHERE team_id = p_team_id AND user_id = uid) AND inst.installed_by IS DISTINCT FROM uid THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_member');
  END IF;
  IF p_mode = 'account' THEN
    -- Only your own account can be made to pay; a member cannot point the pot at someone else.
    UPDATE slack_installs SET payer_user_id = uid, payer_mode = 'account', payer_set_at = now(), updated_at = now() WHERE team_id = p_team_id;
  ELSE
    IF inst.payer_user_id IS DISTINCT FROM uid AND inst.installed_by IS DISTINCT FROM uid THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_the_payer');
    END IF;
    UPDATE slack_installs SET payer_user_id = NULL, payer_mode = 'members', payer_set_at = now(), updated_at = now() WHERE team_id = p_team_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'team_id', p_team_id, 'mode', p_mode, 'payer_is_me', p_mode = 'account');
END;
$$;
REVOKE ALL ON FUNCTION public.set_slack_payer(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_slack_payer(text, text) TO authenticated;

/** The caller's Slack workspaces and who pays in each (for atlarix.dev/cloud). */
CREATE OR REPLACE FUNCTION public.get_slack_pay_settings()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'team_id', i.team_id,
    'team_name', i.team_name,
    'mode', i.payer_mode,
    'payer_is_me', i.payer_user_id = auth.uid(),
    'payer_label', CASE WHEN i.payer_user_id IS NULL THEN NULL ELSE split_part((SELECT email FROM users WHERE id = i.payer_user_id), '@', 1) END,
    'can_hand_back', i.payer_user_id = auth.uid() OR i.installed_by = auth.uid()
  ) ORDER BY i.team_name), '[]'::jsonb)
  FROM slack_installs i
  WHERE auth.uid() IS NOT NULL
    AND (i.installed_by = auth.uid() OR EXISTS (SELECT 1 FROM slack_links l WHERE l.team_id = i.team_id AND l.user_id = auth.uid()));
$$;
REVOKE ALL ON FUNCTION public.get_slack_pay_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_slack_pay_settings() TO authenticated;

/** For the bot and the job runner: who pays in this workspace, and how to mention them. */
CREATE OR REPLACE FUNCTION public.get_slack_payer_service(p_team_id text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE WHEN COALESCE(auth.role(), '') <> 'service_role' THEN jsonb_build_object('ok', false, 'error', 'forbidden')
  ELSE jsonb_build_object(
    'ok', true,
    'mode', COALESCE(i.payer_mode, 'members'),
    'payer_user_id', i.payer_user_id,
    'payer_slack_user_id', (SELECT l.slack_user_id FROM slack_links l WHERE l.team_id = p_team_id AND l.user_id = i.payer_user_id LIMIT 1),
    'payer_label', CASE WHEN i.payer_user_id IS NULL THEN NULL ELSE split_part((SELECT email FROM users WHERE id = i.payer_user_id), '@', 1) END,
    'team_name', i.team_name
  ) END
  FROM (SELECT * FROM slack_installs WHERE team_id = p_team_id UNION ALL SELECT NULL::slack_installs.* LIMIT 1) i;
$$;
REVOKE ALL ON FUNCTION public.get_slack_payer_service(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_slack_payer_service(text) TO service_role;

/** The payer's Team view: what each member spent, per day and channel, from this wallet. */
CREATE OR REPLACE FUNCTION public.get_usage_team(p_days integer DEFAULT 30, p_tz text DEFAULT 'UTC')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  uid uuid := auth.uid();
  days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  rows jsonb;
  members jsonb;
BEGIN
  IF uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated'); END IF;
  IF public.account_is_banned(uid) THEN RETURN jsonb_build_object('ok', false, 'error', 'account_banned'); END IF;
  SELECT COALESCE(jsonb_agg(r ORDER BY r->>'day', r->>'member'), '[]'::jsonb) INTO rows FROM (
    SELECT jsonb_build_object(
      'day', to_char(t.created_at AT TIME ZONE p_tz, 'YYYY-MM-DD'),
      'member', split_part(u.email, '@', 1),
      'member_id', t.billed_for,
      'team_id', t.slack_team_id,
      'channel', t.slack_channel,
      'cents', -sum(t.delta_cents)
    ) AS r
    FROM credit_transactions t LEFT JOIN users u ON u.id = t.billed_for
    WHERE t.user_id = uid AND t.kind = 'debit' AND t.billed_for IS NOT NULL
      AND t.created_at > now() - make_interval(days => days)
    GROUP BY 1, 2, 3, 4, 5
  ) s;
  SELECT COALESCE(jsonb_agg(m ORDER BY (m->>'cents')::bigint DESC), '[]'::jsonb) INTO members FROM (
    SELECT jsonb_build_object('member', split_part(u.email, '@', 1), 'member_id', t.billed_for, 'cents', -sum(t.delta_cents), 'tasks', count(DISTINCT t.ref)) AS m
    FROM credit_transactions t LEFT JOIN users u ON u.id = t.billed_for
    WHERE t.user_id = uid AND t.kind = 'debit' AND t.billed_for IS NOT NULL AND t.created_at > now() - make_interval(days => days)
    GROUP BY u.email, t.billed_for
  ) s;
  RETURN jsonb_build_object('ok', true, 'days', days, 'rows', rows, 'members', members);
END;
$$;
REVOKE ALL ON FUNCTION public.get_usage_team(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_usage_team(integer, text) TO authenticated;

/** A member's side: what a workspace paid for them, per day. */
CREATE OR REPLACE FUNCTION public.get_usage_paid_for_me(p_days integer DEFAULT 30, p_tz text DEFAULT 'UTC')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  uid uuid := auth.uid();
  days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  rows jsonb;
BEGIN
  IF uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated'); END IF;
  SELECT COALESCE(jsonb_agg(r ORDER BY r->>'day'), '[]'::jsonb) INTO rows FROM (
    SELECT jsonb_build_object(
      'day', to_char(t.created_at AT TIME ZONE p_tz, 'YYYY-MM-DD'),
      'team_id', t.slack_team_id,
      'team_name', (SELECT team_name FROM slack_installs i WHERE i.team_id = t.slack_team_id),
      'cents', -sum(t.delta_cents)
    ) AS r
    FROM credit_transactions t
    WHERE t.billed_for = uid AND t.kind = 'debit' AND t.created_at > now() - make_interval(days => days)
    GROUP BY 1, 2, 3
  ) s;
  RETURN jsonb_build_object('ok', true, 'days', days, 'rows', rows);
END;
$$;
REVOKE ALL ON FUNCTION public.get_usage_paid_for_me(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_usage_paid_for_me(integer, text) TO authenticated;

COMMIT;
