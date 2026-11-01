-- Workspace pays, review notes (ai-3e, 2026-10-31):
--  1. A linked member may volunteer as payer when nobody pays; taking over from a
--     CURRENT payer needs the installer (installed_by, or the Slack installer's
--     linked account) — never a plain member.
--  2. An unknown time zone falls back to UTC instead of failing the view.
--  3. get_usage_paid_for_me refuses a banned caller like its siblings.
BEGIN;

CREATE OR REPLACE FUNCTION public.slack_installer_user(p_team_id text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(i.installed_by, (SELECT l.user_id FROM slack_links l WHERE l.team_id = i.team_id AND l.slack_user_id = i.installer_slack_user_id LIMIT 1))
  FROM slack_installs i WHERE i.team_id = p_team_id;
$$;
REVOKE ALL ON FUNCTION public.slack_installer_user(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_slack_payer(p_team_id text, p_mode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  uid uuid := auth.uid();
  inst slack_installs%ROWTYPE;
  installer uuid;
BEGIN
  IF uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated'); END IF;
  IF public.account_is_banned(uid) THEN RETURN jsonb_build_object('ok', false, 'error', 'account_banned'); END IF;
  IF p_mode NOT IN ('members', 'account') THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_mode'); END IF;
  SELECT * INTO inst FROM slack_installs WHERE team_id = p_team_id FOR UPDATE;
  IF inst.team_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_installed'); END IF;
  installer := public.slack_installer_user(p_team_id);
  IF NOT EXISTS (SELECT 1 FROM slack_links WHERE team_id = p_team_id AND user_id = uid) AND installer IS DISTINCT FROM uid THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_member');
  END IF;
  IF p_mode = 'account' THEN
    -- Volunteering is open to any member; replacing someone who already pays is the installer's call.
    IF inst.payer_user_id IS NOT NULL AND inst.payer_user_id <> uid AND installer IS DISTINCT FROM uid THEN
      RETURN jsonb_build_object('ok', false, 'error', 'has_payer');
    END IF;
    UPDATE slack_installs SET payer_user_id = uid, payer_mode = 'account', payer_set_at = now(), updated_at = now() WHERE team_id = p_team_id;
  ELSE
    IF inst.payer_user_id IS DISTINCT FROM uid AND installer IS DISTINCT FROM uid THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_the_payer');
    END IF;
    UPDATE slack_installs SET payer_user_id = NULL, payer_mode = 'members', payer_set_at = now(), updated_at = now() WHERE team_id = p_team_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'team_id', p_team_id, 'mode', p_mode, 'payer_is_me', p_mode = 'account');
END;
$$;

CREATE OR REPLACE FUNCTION public.get_slack_pay_settings()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'team_id', i.team_id,
    'team_name', i.team_name,
    'mode', i.payer_mode,
    'payer_is_me', i.payer_user_id = auth.uid(),
    'payer_label', CASE WHEN i.payer_user_id IS NULL THEN NULL ELSE split_part((SELECT email FROM users WHERE id = i.payer_user_id), '@', 1) END,
    'can_hand_back', i.payer_user_id = auth.uid() OR public.slack_installer_user(i.team_id) = auth.uid(),
    'can_become_payer', i.payer_user_id IS NULL OR i.payer_user_id = auth.uid() OR public.slack_installer_user(i.team_id) = auth.uid()
  ) ORDER BY i.team_name), '[]'::jsonb)
  FROM slack_installs i
  WHERE auth.uid() IS NOT NULL
    AND (public.slack_installer_user(i.team_id) = auth.uid() OR EXISTS (SELECT 1 FROM slack_links l WHERE l.team_id = i.team_id AND l.user_id = auth.uid()));
$$;

CREATE OR REPLACE FUNCTION public.safe_tz(p_tz text)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_tz IS NULL OR p_tz = '' THEN 'UTC'
              WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz) THEN p_tz
              ELSE 'UTC' END;
$$;

CREATE OR REPLACE FUNCTION public.get_usage_team(p_days integer DEFAULT 30, p_tz text DEFAULT 'UTC')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  uid uuid := auth.uid();
  days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  tz text := public.safe_tz(p_tz);
  rows jsonb;
  members jsonb;
BEGIN
  IF uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated'); END IF;
  IF public.account_is_banned(uid) THEN RETURN jsonb_build_object('ok', false, 'error', 'account_banned'); END IF;
  SELECT COALESCE(jsonb_agg(r ORDER BY r->>'day', r->>'member'), '[]'::jsonb) INTO rows FROM (
    SELECT jsonb_build_object(
      'day', to_char(t.created_at AT TIME ZONE tz, 'YYYY-MM-DD'),
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

CREATE OR REPLACE FUNCTION public.get_usage_paid_for_me(p_days integer DEFAULT 30, p_tz text DEFAULT 'UTC')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  uid uuid := auth.uid();
  days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  tz text := public.safe_tz(p_tz);
  rows jsonb;
BEGIN
  IF uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated'); END IF;
  IF public.account_is_banned(uid) THEN RETURN jsonb_build_object('ok', false, 'error', 'account_banned'); END IF;
  SELECT COALESCE(jsonb_agg(r ORDER BY r->>'day'), '[]'::jsonb) INTO rows FROM (
    SELECT jsonb_build_object(
      'day', to_char(t.created_at AT TIME ZONE tz, 'YYYY-MM-DD'),
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
COMMIT;
