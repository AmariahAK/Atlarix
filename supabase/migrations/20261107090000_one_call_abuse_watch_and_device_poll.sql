-- Fewer Supabase requests from our own timers (2026-11-07).
--
-- Measured over 24 h of edge_logs: the abuse-watch Lambda (every 5 min) was half
-- of ALL API traffic, ~864 requests a day: two `signup_attempts` reads, one
-- `abuse_events` read, plus one `users` read per no-website domain. A CLI device
-- sign-in made three requests per 5 s poll (985 in one evening of QA).
--
--  1. abuse_watch_signals_service(): everything the watcher reads, in one call.
--     Same windows and limits as the Lambda's old selects.
--  2. cli_device_poll_service(hash, min_gap_s): one poll, in one call. Same
--     answers as the edge function's old three statements.
--
-- Only adds functions: the Lambda and edge function live now keep working, so
-- this is applied BEFORE either is redeployed. Both are service_role only and
-- check it in the body, like every *_service function.
BEGIN;

CREATE OR REPLACE FUNCTION public.abuse_watch_signals_service()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  out_signups jsonb;
  out_webhooks integer;
  out_no_web jsonb;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;

  -- Sign-ups of the last day (the Lambda takes the last hour of these for per-address bursts).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('ip_hash', s.ip_hash, 'domain', s.domain, 'allowed', s.allowed, 'at', s.at)), '[]'::jsonb)
    INTO out_signups
    FROM (SELECT ip_hash, domain, allowed, at FROM signup_attempts
           WHERE at >= now() - interval '24 hours' ORDER BY at DESC LIMIT 5000) s;

  SELECT count(*) INTO out_webhooks
    FROM (SELECT 1 FROM abuse_events
           WHERE kind = 'webhook_failed' AND at >= now() - interval '1 hour' LIMIT 1000) w;

  -- Allowed sign-ups this week on no-website domains, each with the unbanned
  -- accounts made on that domain this week (the burner pattern).
  WITH no_web AS (
    SELECT ip_hash, domain, mx_host, at FROM signup_attempts
     WHERE at >= now() - interval '7 days' AND allowed AND has_web IS FALSE
     ORDER BY at DESC LIMIT 5000
  ), domains AS (
    SELECT DISTINCT domain FROM no_web WHERE domain <> '' LIMIT 200
  ), accounts AS (
    SELECT d.domain,
           (SELECT COALESCE(jsonb_agg(u.id), '[]'::jsonb)
              FROM (SELECT id FROM users
                     WHERE split_part(lower(email), '@', 2) = lower(d.domain)
                       AND created_at >= now() - interval '7 days'
                       AND banned_at IS NULL
                     LIMIT 50) u) AS uids
      FROM domains d
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'ip_hash', n.ip_hash, 'domain', n.domain, 'mx_host', n.mx_host, 'at', n.at,
           'uids', COALESCE(a.uids, '[]'::jsonb))), '[]'::jsonb)
    INTO out_no_web
    FROM no_web n LEFT JOIN accounts a ON a.domain = n.domain;

  RETURN jsonb_build_object('ok', true, 'signups', out_signups, 'webhook_failures_1h', out_webhooks, 'no_web_7d', out_no_web);
END;
$$;
REVOKE ALL ON FUNCTION public.abuse_watch_signals_service() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abuse_watch_signals_service() TO service_role;

CREATE OR REPLACE FUNCTION public.cli_device_poll_service(p_device_code_hash text, p_min_gap_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  r cli_device_codes%ROWTYPE;
  sealed text;
  too_soon boolean;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;

  -- Approved: collect and delete in ONE statement, so a session is handed out once.
  DELETE FROM cli_device_codes
   WHERE device_code_hash = p_device_code_hash AND status = 'approved' AND expires_at > now()
  RETURNING sealed_session INTO sealed;
  IF sealed IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'state', 'approved', 'sealed_session', sealed);
  END IF;

  SELECT * INTO r FROM cli_device_codes WHERE device_code_hash = p_device_code_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'state', 'expired'); END IF;
  IF r.expires_at <= now() THEN
    DELETE FROM cli_device_codes WHERE id = r.id;
    RETURN jsonb_build_object('ok', true, 'state', 'expired');
  END IF;
  IF r.status = 'denied' THEN
    DELETE FROM cli_device_codes WHERE id = r.id;
    RETURN jsonb_build_object('ok', true, 'state', 'denied');
  END IF;

  -- Faster than the interval earns slow_down (RFC 8628 §3.5).
  too_soon := r.last_polled_at IS NOT NULL
              AND now() - r.last_polled_at < make_interval(secs => GREATEST(COALESCE(p_min_gap_seconds, 0), 0));
  UPDATE cli_device_codes SET last_polled_at = now() WHERE id = r.id;
  RETURN jsonb_build_object('ok', true, 'state', CASE WHEN too_soon THEN 'slow_down' ELSE 'pending' END);
END;
$$;
REVOKE ALL ON FUNCTION public.cli_device_poll_service(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cli_device_poll_service(text, integer) TO service_role;

COMMIT;
