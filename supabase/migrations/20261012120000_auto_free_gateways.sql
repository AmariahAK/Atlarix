-- ---------------------------------------------------------------------------
-- Atlarix Auto: the free gateways (OpenRouter, Requesty).
-- ---------------------------------------------------------------------------
--
-- Free Auto now spreads each message across OpenAI's complimentary tokens AND
-- two free gateways. The gateways do not count tokens: they allow so many
-- REQUESTS a day (one per model call, whatever its size) for the whole org, so
-- their pools are counted in requests, next to the tokens of the OpenAI pools:
--
--   * free_usage_daily.requests      — calls sent to a gateway pool today;
--   * free_usage_user_daily.requests — one user's calls today, per pool
--                                      ({"openrouter": 12, "requesty": 3}).
--
-- record_free_usage gains `p_requests`. Its argument list changes, so the old
-- function is DROPPED first: a second overload beside it would make every call
-- the running proxy makes (four named arguments) ambiguous. The new parameter
-- defaults to 0, so that proxy keeps working unchanged until it is redeployed.

BEGIN;

ALTER TABLE public.free_usage_daily
  DROP CONSTRAINT IF EXISTS free_usage_daily_pool_check;
ALTER TABLE public.free_usage_daily
  ADD CONSTRAINT free_usage_daily_pool_check
  CHECK (pool IN ('mini', 'large', 'floor', 'openrouter', 'requesty'));
ALTER TABLE public.free_usage_daily
  ADD COLUMN IF NOT EXISTS requests bigint NOT NULL DEFAULT 0 CHECK (requests >= 0);

ALTER TABLE public.free_usage_user_daily
  ADD COLUMN IF NOT EXISTS requests jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON TABLE public.free_usage_daily IS
  'Atlarix Auto: tokens (OpenAI pools) and requests (gateway pools) per shared pool per UTC day. Written by the proxy only.';
COMMENT ON TABLE public.free_usage_user_daily IS
  'Atlarix Auto: tokens, turns and per-pool gateway requests per user per UTC day. Written by the proxy only.';

CREATE OR REPLACE FUNCTION public.get_free_usage_state(
  p_user_id uuid,
  p_day date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  IF EXISTS (SELECT 1 FROM users WHERE id = p_user_id AND banned_at IS NOT NULL) THEN
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
$$;

DROP FUNCTION IF EXISTS public.record_free_usage(uuid, date, text, bigint);

CREATE FUNCTION public.record_free_usage(
  p_user_id uuid,
  p_day date,
  p_pool text,
  p_tokens bigint,
  p_requests bigint DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_user_id IS NULL OR p_day IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_arguments');
  END IF;
  IF p_pool IS NULL OR p_pool NOT IN ('mini', 'large', 'floor', 'openrouter', 'requesty') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_pool');
  END IF;
  IF p_tokens IS NULL OR p_tokens < 0 OR p_requests IS NULL OR p_requests < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;

  INSERT INTO free_usage_daily (day, pool, tokens, requests)
  VALUES (p_day, p_pool, p_tokens, p_requests)
  ON CONFLICT (day, pool)
  DO UPDATE SET
    tokens = free_usage_daily.tokens + EXCLUDED.tokens,
    requests = free_usage_daily.requests + EXCLUDED.requests;

  INSERT INTO free_usage_user_daily (user_id, day, tokens, turns, requests)
  VALUES (
    p_user_id, p_day, p_tokens, 1,
    CASE WHEN p_requests > 0 THEN jsonb_build_object(p_pool, p_requests) ELSE '{}'::jsonb END
  )
  ON CONFLICT (user_id, day)
  DO UPDATE SET
    tokens = free_usage_user_daily.tokens + EXCLUDED.tokens,
    turns = free_usage_user_daily.turns + 1,
    requests = CASE WHEN p_requests > 0
      THEN jsonb_set(
        free_usage_user_daily.requests,
        ARRAY[p_pool],
        to_jsonb(COALESCE((free_usage_user_daily.requests ->> p_pool)::bigint, 0) + p_requests)
      )
      ELSE free_usage_user_daily.requests
    END;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- CREATE FUNCTION grants EXECUTE to PUBLIC, and CREATE OR REPLACE re-grants it
-- (2026-07 Supabase remediation). Re-revoke, then VERIFY by reading proacl:
--
--   SELECT p.proname, p.proacl FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('get_free_usage_state', 'record_free_usage');
--
-- Neither may list `=X/` (PUBLIC), anon or authenticated.
REVOKE EXECUTE ON FUNCTION public.get_free_usage_state(uuid, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_free_usage_state(uuid, date) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.get_free_usage_state(uuid, date) TO service_role;

REVOKE EXECUTE ON FUNCTION public.record_free_usage(uuid, date, text, bigint, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_free_usage(uuid, date, text, bigint, bigint) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.record_free_usage(uuid, date, text, bigint, bigint) TO service_role;

COMMIT;
