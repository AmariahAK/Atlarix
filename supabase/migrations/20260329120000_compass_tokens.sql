-- =============================================================================
-- Logical migration id: 0032_compass_tokens (compass token tracking for Atlarix Compass)
-- =============================================================================
-- COMPASS TOKEN LIMITS — ADJUSTABLE VALUES
-- To change token limits per tier, update the DEFAULT values in this migration
-- and run a targeted UPDATE on existing users:
--   UPDATE compass_tokens SET monthly_limit = <new_value> WHERE tier = '<tier>';
-- These values were set conservatively for launch (Month 1-2).
-- Review after first billing cycle and adjust based on actual usage patterns.
-- Monthly reset logic: on each Compass API call (record_compass_usage), if
-- last_reset_at is more than 30 days ago, reset tokens_used_this_month to 0
-- and update last_reset_at.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.compass_tokens (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  tier text NOT NULL CHECK (tier IN ('free', 'pro', 'workforce')),
  tokens_used_this_month bigint NOT NULL DEFAULT 0,
  monthly_limit bigint NOT NULL,
  last_reset_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compass_tokens_tier ON public.compass_tokens (tier);

ALTER TABLE public.compass_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "compass_tokens_select_own"
  ON public.compass_tokens
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

COMMENT ON TABLE public.compass_tokens IS 'v5.1 Compass managed provider monthly token usage per user';

-- Read path: apply same 30-day reset as write path, then return used/limit/tier
CREATE OR REPLACE FUNCTION public.get_compass_usage_state()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  r compass_tokens%ROWTYPE;
  lim bigint;
  t text;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  SELECT COALESCE(NULLIF(trim(u.effective_tier::text), ''), NULLIF(trim(u.plan::text), ''), 'free') INTO t
  FROM public.users u
  WHERE u.id = uid;

  t := lower(coalesce(t, 'free'));
  IF t NOT IN ('free', 'pro', 'workforce') THEN
    t := 'free';
  END IF;

  lim := CASE t
    WHEN 'free' THEN 75000
    WHEN 'pro' THEN 1500000
    ELSE 3000000
  END;

  SELECT * INTO r FROM compass_tokens WHERE user_id = uid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'tokens_used_this_month', 0,
      'monthly_limit', lim,
      'tier', t,
      'last_reset_at', to_jsonb(now())
    );
  END IF;

  IF now() - r.last_reset_at > interval '30 days' THEN
    UPDATE compass_tokens
    SET
      tokens_used_this_month = 0,
      last_reset_at = now(),
      tier = t,
      monthly_limit = lim,
      updated_at = now()
    WHERE user_id = uid;
    r.tokens_used_this_month := 0;
    r.last_reset_at := now();
    r.tier := t;
    r.monthly_limit := lim;
  ELSE
    UPDATE compass_tokens
    SET tier = t, monthly_limit = lim, updated_at = now()
    WHERE user_id = uid AND (compass_tokens.tier IS DISTINCT FROM t OR compass_tokens.monthly_limit IS DISTINCT FROM lim);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'tokens_used_this_month', r.tokens_used_this_month,
    'monthly_limit', r.monthly_limit,
    'tier', r.tier,
    'last_reset_at', to_jsonb(r.last_reset_at)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_compass_usage_state () TO authenticated;

CREATE OR REPLACE FUNCTION public.record_compass_usage (p_tokens bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  r compass_tokens%ROWTYPE;
  lim bigint;
  t text;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF p_tokens IS NULL OR p_tokens < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_tokens');
  END IF;

  SELECT COALESCE(NULLIF(trim(u.effective_tier::text), ''), NULLIF(trim(u.plan::text), ''), 'free') INTO t
  FROM public.users u
  WHERE u.id = uid;

  t := lower(coalesce(t, 'free'));
  IF t NOT IN ('free', 'pro', 'workforce') THEN
    t := 'free';
  END IF;

  lim := CASE t
    WHEN 'free' THEN 75000
    WHEN 'pro' THEN 1500000
    ELSE 3000000
  END;

  SELECT * INTO r FROM compass_tokens WHERE user_id = uid;

  IF NOT FOUND THEN
    INSERT INTO compass_tokens (user_id, tier, tokens_used_this_month, monthly_limit, last_reset_at)
    VALUES (uid, t, 0, lim, now());
    SELECT * INTO r FROM compass_tokens WHERE user_id = uid;
  END IF;

  IF now() - r.last_reset_at > interval '30 days' THEN
    UPDATE compass_tokens
    SET
      tokens_used_this_month = 0,
      last_reset_at = now(),
      tier = t,
      monthly_limit = lim,
      updated_at = now()
    WHERE user_id = uid;
    SELECT * INTO r FROM compass_tokens WHERE user_id = uid;
  END IF;

  IF r.tokens_used_this_month + p_tokens > r.monthly_limit THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'limit_exceeded',
      'tokens_used_this_month', r.tokens_used_this_month,
      'monthly_limit', r.monthly_limit
    );
  END IF;

  UPDATE compass_tokens
  SET
    tokens_used_this_month = tokens_used_this_month + p_tokens,
    tier = t,
    monthly_limit = lim,
    updated_at = now()
  WHERE user_id = uid;

  RETURN jsonb_build_object(
    'ok', true,
    'tokens_used_this_month', r.tokens_used_this_month + p_tokens,
    'monthly_limit', r.monthly_limit
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_compass_usage (bigint) TO authenticated;
