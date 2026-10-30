-- 2026-10-29, after the overnight attack: the connector and service gaps.
--
-- 1. One account registered ~230 connectors in a night (an SSRF test-suite).
--    `upsert_account_mcp_server` now refuses a banned account and caps an
--    account at 25 connectors (advisory lock + count, so two concurrent inserts
--    cannot both pass at 24).
-- 2. The url CHECK was weaker than the proxy's own guard (src/ssrf.ts): it let
--    through 172.16/12, `.internal`, every IPv6 literal, userinfo tricks and the
--    benchmark/TEST-NET ranges. The proxy still judges every URL at call time
--    (DNS included); this is the write-time copy of the same policy. IPv6
--    literals are refused outright here: a CHECK cannot parse `::` forms, and no
--    real MCP server is published as a bare IPv6 address.
-- 3. The service RPCs (`get_credit_balance_service`, `get_free_usage_state`,
--    `debit_wallet_service`, `debit_wallet_cloud`) and `get_credit_breakdown`
--    still looked only at `users.banned_at`; `account_is_banned()` also sees the
--    auth-level `banned_until`, which is what an automatic temp ban sets.
BEGIN;

-- ── 1 + 2: connectors ────────────────────────────────────────────────────────

ALTER TABLE public.account_mcp_servers DROP CONSTRAINT IF EXISTS account_mcp_servers_url_not_private;
ALTER TABLE public.account_mcp_servers ADD CONSTRAINT account_mcp_servers_url_safe CHECK (
  url ~ '^https://' AND length(url) <= 2048
  -- no userinfo before the first slash: https://a@169.254.169.254/
  AND url !~ '^https://[^/?#]*@'
  -- no IPv6 literal, no loopback or internal names
  AND url !~* '^https://(\[|localhost([:/?#]|$)|[^/?#]*\.(localhost|local|internal)([:/?#]|$))'
  -- private, loopback, link-local, CGNAT, protocol-assignment, benchmark, TEST-NET, multicast/reserved
  AND url !~ '^https://(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|192\.0\.|198\.1[89]\.|198\.51\.100\.|203\.0\.113\.|(22[4-9]|2[3-5][0-9])\.)'
);

CREATE OR REPLACE FUNCTION public.upsert_account_mcp_server(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  v_id uuid := NULLIF(p_input->>'id', '')::uuid;
  v_slug text := p_input->>'slug';
  existing public.account_mcp_servers%ROWTYPE;
  saved public.account_mcp_servers%ROWTYPE;
  MAX_CONNECTORS CONSTANT integer := 25;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF public.account_is_banned(uid) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;

  IF v_id IS NOT NULL THEN
    SELECT * INTO existing FROM public.account_mcp_servers
     WHERE id = v_id AND user_id = uid FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;

    UPDATE public.account_mcp_servers SET
      name = COALESCE(p_input->>'name', name),
      description = COALESCE(p_input->>'description', description),
      url = COALESCE(p_input->>'url', url),
      auth_type = COALESCE(p_input->>'auth_type', auth_type),
      auth_header = CASE WHEN p_input ? 'auth_header'
        THEN NULLIF(p_input->>'auth_header', '') ELSE auth_header END,
      registry_name = CASE WHEN p_input ? 'registry_name'
        THEN NULLIF(p_input->>'registry_name', '') ELSE registry_name END,
      enabled = CASE
        WHEN COALESCE(p_input->>'url', url) IS DISTINCT FROM url
          OR COALESCE(p_input->>'auth_type', auth_type) IS DISTINCT FROM auth_type
          OR (p_input ? 'auth_header'
              AND NULLIF(p_input->>'auth_header', '') IS DISTINCT FROM auth_header)
        THEN false ELSE enabled END,
      tools_cache = CASE
        WHEN COALESCE(p_input->>'url', url) IS DISTINCT FROM url
        THEN '[]'::jsonb ELSE tools_cache END,
      updated_at = now()
    WHERE id = existing.id
    RETURNING * INTO saved;

    IF saved.url IS DISTINCT FROM existing.url
       OR saved.auth_type IS DISTINCT FROM existing.auth_type
       OR saved.auth_header IS DISTINCT FROM existing.auth_header THEN
      DELETE FROM private.mcp_credentials WHERE server_id = existing.id;
    END IF;
  ELSE
    IF v_slug IS NULL OR v_slug = '' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'missing_slug');
    END IF;
    -- The cap. The lock serialises this account's inserts so the count is exact.
    PERFORM pg_advisory_xact_lock(hashtext('account_mcp_servers:' || uid::text));
    IF (SELECT count(*) FROM public.account_mcp_servers WHERE user_id = uid) >= MAX_CONNECTORS THEN
      RETURN jsonb_build_object('ok', false, 'error', 'too_many_connectors', 'max', MAX_CONNECTORS);
    END IF;
    INSERT INTO public.account_mcp_servers
      (user_id, name, slug, description, url, auth_type, auth_header, registry_name)
    VALUES (
      uid,
      COALESCE(p_input->>'name', v_slug),
      v_slug,
      COALESCE(p_input->>'description', ''),
      p_input->>'url',
      COALESCE(p_input->>'auth_type', 'none'),
      NULLIF(p_input->>'auth_header', ''),
      NULLIF(p_input->>'registry_name', '')
    )
    RETURNING * INTO saved;
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', saved.id, 'slug', saved.slug);
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'duplicate_slug');
  WHEN check_violation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rejected', 'detail', SQLERRM);
END;
$function$;

-- ── 3: every ban check reads both levels ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_credit_balance_service(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  granted bigint;
  granted_total bigint;
  purchased bigint;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;
  IF public.account_is_banned(p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;
  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT COALESCE(SUM(cents), 0), COALESCE(SUM(total_cents), 0)
    INTO granted, granted_total FROM credit_grants WHERE user_id = p_user_id;
  SELECT balance_cents INTO purchased FROM credit_wallet WHERE user_id = p_user_id;
  RETURN jsonb_build_object(
    'ok', true,
    'balance_cents', COALESCE(granted, 0) + COALESCE(purchased, 0),
    'granted_cents', COALESCE(granted, 0),
    'granted_total_cents', COALESCE(granted_total, 0),
    'purchased_cents', COALESCE(purchased, 0)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_free_usage_state(p_user_id uuid, p_day date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  pools jsonb;
  pool_requests jsonb;
  user_tokens bigint;
  user_requests jsonb;
  created timestamptz;
  active_today integer;
  active_week_ago integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_user_id IS NULL OR p_day IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_arguments');
  END IF;
  IF public.account_is_banned(p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;

  SELECT COALESCE(jsonb_object_agg(pool, tokens), '{}'::jsonb),
         COALESCE(jsonb_object_agg(pool, requests) FILTER (WHERE requests > 0), '{}'::jsonb)
    INTO pools, pool_requests
    FROM free_usage_daily WHERE day = p_day;
  SELECT tokens, requests INTO user_tokens, user_requests
    FROM free_usage_user_daily WHERE user_id = p_user_id AND day = p_day;
  SELECT created_at INTO created FROM auth.users WHERE id = p_user_id;
  SELECT count(*) INTO active_today
    FROM free_usage_user_daily WHERE day = p_day;
  SELECT count(*) INTO active_week_ago
    FROM free_usage_user_daily WHERE day = p_day - 7;

  RETURN jsonb_build_object(
    'ok', true,
    'pools', pools,
    'pool_requests', pool_requests,
    'user_tokens', COALESCE(user_tokens, 0),
    'user_requests', COALESCE(user_requests, '{}'::jsonb),
    'user_created_at', created,
    'active_today', COALESCE(active_today, 0),
    'active_week_ago', COALESCE(active_week_ago, 0)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_credit_breakdown(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  allowances jsonb;
  spend jsonb;
  purchased bigint;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF public.account_is_banned(uid) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'product', product,
             'cents', cents,
             'total_cents', total_cents
           ) ORDER BY product
         ), '[]'::jsonb)
    INTO allowances
    FROM credit_grants
   WHERE user_id = uid AND total_cents > 0;

  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.cents_spent DESC), '[]'::jsonb)
    INTO spend
    FROM (
      SELECT COALESCE(source, 'app') AS source,
             SUM(-delta_cents)::bigint AS cents_spent,
             COUNT(*)::bigint AS entries
        FROM credit_transactions
       WHERE user_id = uid
         AND kind = 'debit'
         AND created_at >= now() - make_interval(days => days)
       GROUP BY COALESCE(source, 'app')
    ) t;

  SELECT balance_cents INTO purchased FROM credit_wallet WHERE user_id = uid;

  RETURN jsonb_build_object(
    'ok', true,
    'window_days', days,
    'purchased_cents', COALESCE(purchased, 0),
    'allowances', allowances,
    'spend_by_source', spend
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.debit_wallet_service(p_user_id uuid, p_generation_id text, p_cents bigint, p_source text DEFAULT 'reviewer'::text, p_repo text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  bal bigint;
  DEBIT_MAX_CENTS CONSTANT bigint := 5000;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;
  IF public.account_is_banned(p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;
  IF p_cents IS NULL OR p_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;
  IF p_cents > DEBIT_MAX_CENTS THEN
    RETURN jsonb_build_object('ok', false, 'error', 'amount_too_large', 'max_cents', DEBIT_MAX_CENTS);
  END IF;
  IF p_generation_id IS NULL OR length(trim(p_generation_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_generation_id');
  END IF;
  IF p_source NOT IN ('app', 'reviewer', 'cli', 'extension') THEN
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

  bal := spend_from_wallet(
    p_user_id, p_cents, CASE WHEN p_source = 'reviewer' THEN 'reviewer' ELSE 'pro' END
  );
  RETURN jsonb_build_object('ok', true, 'balance_cents', bal);
END;
$function$;

CREATE OR REPLACE FUNCTION public.debit_wallet_cloud(p_user_id uuid, p_job_id uuid, p_generation_id text, p_cents bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  bal bigint;
  job_repo text;
  DEBIT_MAX_CENTS CONSTANT bigint := 5000;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF public.account_is_banned(p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;
  IF p_cents IS NULL OR p_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;
  IF p_cents > DEBIT_MAX_CENTS THEN
    RETURN jsonb_build_object('ok', false, 'error', 'amount_too_large', 'max_cents', DEBIT_MAX_CENTS);
  END IF;
  IF p_generation_id IS NULL OR length(trim(p_generation_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_generation_id');
  END IF;

  SELECT repo INTO job_repo
    FROM cloud_jobs
   WHERE id = p_job_id AND user_id = p_user_id AND state = 'running'
   FOR UPDATE;
  IF job_repo IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'job_not_running');
  END IF;

  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref, source, repo)
  VALUES (p_user_id, -p_cents, 'debit', p_generation_id, 'cloud', job_repo)
  ON CONFLICT (kind, ref) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'balance_cents', wallet_spendable(p_user_id), 'duplicate', true
    );
  END IF;

  bal := spend_from_wallet(p_user_id, p_cents, 'pro');
  UPDATE cloud_jobs
     SET spent_cents = spent_cents + p_cents, updated_at = now()
   WHERE id = p_job_id;
  RETURN jsonb_build_object('ok', true, 'balance_cents', bal);
END;
$function$;

COMMIT;

-- VERIFY after applying:
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.account_mcp_servers'::regclass AND conname LIKE '%url%';
--   -- account_mcp_servers_url_https + account_mcp_servers_url_safe, no url_not_private
--   SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosrc ILIKE '%banned_at IS NOT NULL%'
--      AND p.proname <> 'account_is_banned';
--   -- expect 0
