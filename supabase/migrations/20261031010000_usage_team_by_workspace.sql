-- One pot can pay for several Slack workspaces (owner, 2026-10-31): get_usage_team
-- adds per-workspace totals (`teams`) and the workspace name on every row.
BEGIN;
CREATE OR REPLACE FUNCTION public.get_usage_team(p_days integer DEFAULT 30, p_tz text DEFAULT 'UTC')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  uid uuid := auth.uid();
  days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  tz text := public.safe_tz(p_tz);
  rows jsonb;
  members jsonb;
  teams jsonb;
BEGIN
  IF uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated'); END IF;
  IF public.account_is_banned(uid) THEN RETURN jsonb_build_object('ok', false, 'error', 'account_banned'); END IF;
  SELECT COALESCE(jsonb_agg(r ORDER BY r->>'day', r->>'member'), '[]'::jsonb) INTO rows FROM (
    SELECT jsonb_build_object(
      'day', to_char(t.created_at AT TIME ZONE tz, 'YYYY-MM-DD'),
      'member', split_part(u.email, '@', 1),
      'member_id', t.billed_for,
      'team_id', t.slack_team_id,
      'team_name', (SELECT team_name FROM slack_installs i WHERE i.team_id = t.slack_team_id),
      'channel', t.slack_channel,
      'cents', -sum(t.delta_cents)
    ) AS r
    FROM credit_transactions t LEFT JOIN users u ON u.id = t.billed_for
    WHERE t.user_id = uid AND t.kind = 'debit' AND t.billed_for IS NOT NULL
      AND t.created_at > now() - make_interval(days => days)
    GROUP BY 1, 2, 3, 4, 5, 6
  ) s;
  SELECT COALESCE(jsonb_agg(m ORDER BY (m->>'cents')::bigint DESC), '[]'::jsonb) INTO members FROM (
    SELECT jsonb_build_object('member', split_part(u.email, '@', 1), 'member_id', t.billed_for, 'cents', -sum(t.delta_cents), 'tasks', count(DISTINCT t.ref)) AS m
    FROM credit_transactions t LEFT JOIN users u ON u.id = t.billed_for
    WHERE t.user_id = uid AND t.kind = 'debit' AND t.billed_for IS NOT NULL AND t.created_at > now() - make_interval(days => days)
    GROUP BY u.email, t.billed_for
  ) s;
  SELECT COALESCE(jsonb_agg(w ORDER BY (w->>'cents')::bigint DESC), '[]'::jsonb) INTO teams FROM (
    SELECT jsonb_build_object('team_id', t.slack_team_id, 'team_name', (SELECT team_name FROM slack_installs i WHERE i.team_id = t.slack_team_id),
                              'cents', -sum(t.delta_cents), 'members', count(DISTINCT t.billed_for), 'tasks', count(DISTINCT t.ref)) AS w
    FROM credit_transactions t
    WHERE t.user_id = uid AND t.kind = 'debit' AND t.billed_for IS NOT NULL AND t.created_at > now() - make_interval(days => days)
    GROUP BY t.slack_team_id
  ) s;
  RETURN jsonb_build_object('ok', true, 'days', days, 'rows', rows, 'members', members, 'teams', teams);
END;
$$;
REVOKE ALL ON FUNCTION public.get_usage_team(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_usage_team(integer, text) TO authenticated;
COMMIT;
