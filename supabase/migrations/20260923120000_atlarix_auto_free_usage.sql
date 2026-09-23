-- ---------------------------------------------------------------------------
-- Atlarix Auto: free usage counters.
-- ---------------------------------------------------------------------------
--
-- Atlarix Auto is a free Core option served from OpenAI's complimentary daily
-- tokens (a data-shared project) with a $0 floor model behind it. It never
-- touches the credit wallet. What it needs is two running totals per UTC day:
--
--   * how much of each shared POOL is gone (the complimentary allowance is
--     org-wide, and OpenAI bills anything above it — so the proxy stops a rung
--     at a cutoff below the allowance), and
--   * how much each USER has had today (their fair share of what is left).
--
-- Both are written ONLY by the proxy, through SECURITY DEFINER RPCs guarded to
-- service_role — the user id comes from a JWT the proxy has already verified.
-- A user may read their own row; nobody may write one directly.
--
-- THE BAN CHECK IS REPEATED HERE ON PURPOSE. Until now it lived only in
-- get_credit_balance, which the free path deliberately skips (no wallet). A
-- banned account must not get free inference by picking the free option.

BEGIN;

CREATE TABLE IF NOT EXISTS public.free_usage_daily (
  day date NOT NULL,
  pool text NOT NULL CHECK (pool IN ('mini', 'large', 'floor')),
  tokens bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  PRIMARY KEY (day, pool)
);

CREATE TABLE IF NOT EXISTS public.free_usage_user_daily (
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  day date NOT NULL,
  tokens bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  turns integer NOT NULL DEFAULT 0 CHECK (turns >= 0),
  PRIMARY KEY (user_id, day)
);

-- "Distinct free users on a day" is the denominator of the fair share.
CREATE INDEX IF NOT EXISTS idx_free_usage_user_daily_day
  ON public.free_usage_user_daily (day);

ALTER TABLE public.free_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.free_usage_user_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "free_usage_user_daily_select_own" ON public.free_usage_user_daily;
CREATE POLICY "free_usage_user_daily_select_own" ON public.free_usage_user_daily
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
-- No policy on free_usage_daily: pool totals are the proxy's business only.

REVOKE INSERT, UPDATE, DELETE ON public.free_usage_daily FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.free_usage_user_daily FROM authenticated, anon;

COMMENT ON TABLE public.free_usage_daily IS
  'Atlarix Auto: tokens used per shared pool per UTC day. Written by the proxy only.';
COMMENT ON TABLE public.free_usage_user_daily IS
  'Atlarix Auto: tokens and turns per user per UTC day. Written by the proxy only.';

-- ---------------------------------------------------------------------------
-- State for one decision: pools, this user, and the activity the share is
-- divided by. One round trip per Auto turn.
-- ---------------------------------------------------------------------------
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
  user_tokens bigint;
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

  SELECT COALESCE(jsonb_object_agg(pool, tokens), '{}'::jsonb) INTO pools
    FROM free_usage_daily WHERE day = p_day;
  SELECT tokens INTO user_tokens
    FROM free_usage_user_daily WHERE user_id = p_user_id AND day = p_day;
  SELECT created_at INTO created FROM auth.users WHERE id = p_user_id;
  SELECT count(*) INTO active_today
    FROM free_usage_user_daily WHERE day = p_day;
  SELECT count(*) INTO active_week_ago
    FROM free_usage_user_daily WHERE day = p_day - 7;

  RETURN jsonb_build_object(
    'ok', true,
    'pools', pools,
    'user_tokens', COALESCE(user_tokens, 0),
    'user_created_at', created,
    'active_today', COALESCE(active_today, 0),
    'active_week_ago', COALESCE(active_week_ago, 0)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Add one finished turn to both totals. Additive upserts, so concurrent turns
-- never lose each other's tokens.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_free_usage(
  p_user_id uuid,
  p_day date,
  p_pool text,
  p_tokens bigint
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
  IF p_pool IS NULL OR p_pool NOT IN ('mini', 'large', 'floor') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_pool');
  END IF;
  IF p_tokens IS NULL OR p_tokens < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;

  INSERT INTO free_usage_daily (day, pool, tokens)
  VALUES (p_day, p_pool, p_tokens)
  ON CONFLICT (day, pool)
  DO UPDATE SET tokens = free_usage_daily.tokens + EXCLUDED.tokens;

  INSERT INTO free_usage_user_daily (user_id, day, tokens, turns)
  VALUES (p_user_id, p_day, p_tokens, 1)
  ON CONFLICT (user_id, day)
  DO UPDATE SET
    tokens = free_usage_user_daily.tokens + EXCLUDED.tokens,
    turns = free_usage_user_daily.turns + 1;

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

REVOKE EXECUTE ON FUNCTION public.record_free_usage(uuid, date, text, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_free_usage(uuid, date, text, bigint) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.record_free_usage(uuid, date, text, bigint) TO service_role;

COMMIT;
