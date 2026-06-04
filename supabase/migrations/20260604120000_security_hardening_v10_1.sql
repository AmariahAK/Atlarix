-- =============================================================================
-- v10.1 security hardening
-- =============================================================================
-- 1. team_members: self-service DELETE — members can leave a team, invitees can
--    decline their own pending invite. (Owner CRUD already covered by the
--    FOR ALL "team_members_owner_all" policy.)
-- 2. team_members: invite policies read the email from the JWT claim instead of
--    a per-row subquery against public.users (perf + no users-table coupling).
-- 3. users: defense-in-depth WITH CHECK on team_id — the guard trigger already
--    validates membership; the policy now also rejects setting a team_id the
--    user is neither an active member nor the owner of.
-- 4. record_compass_usage: per-call token sanity cap + per-minute call rate
--    limit (malicious clients could previously spam the RPC).
-- =============================================================================

-- ── 1 + 2. team_members self-service + JWT-claim email ──────────────────────

DROP POLICY IF EXISTS "team_members_self_delete" ON public.team_members;
CREATE POLICY "team_members_self_delete"
  ON public.team_members
  FOR DELETE
  TO authenticated
  USING (
    user_id = auth.uid()
    OR (
      status = 'pending'
      AND lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      AND coalesce(auth.jwt() ->> 'email', '') <> ''
    )
  );

DROP POLICY IF EXISTS "team_members_pending_select" ON public.team_members;
CREATE POLICY "team_members_pending_select"
  ON public.team_members
  FOR SELECT
  USING (
    status = 'pending'
    AND lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    AND coalesce(auth.jwt() ->> 'email', '') <> ''
  );

DROP POLICY IF EXISTS "team_members_self_update" ON public.team_members;
CREATE POLICY "team_members_self_update"
  ON public.team_members
  FOR UPDATE
  USING (
    user_id = auth.uid()
    OR (
      status = 'pending'
      AND lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      AND coalesce(auth.jwt() ->> 'email', '') <> ''
    )
  )
  WITH CHECK (
    user_id = auth.uid()
    OR (
      status = 'pending'
      AND lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      AND coalesce(auth.jwt() ->> 'email', '') <> ''
    )
  );

-- ── 3. users.team_id WITH CHECK (belt-and-braces over the guard trigger) ────

DROP POLICY IF EXISTS "Users can update own row" ON public.users;
CREATE POLICY "Users can update own row"
ON public.users
FOR UPDATE
TO authenticated
USING ((SELECT auth.uid()) = id)
WITH CHECK (
  (SELECT auth.uid()) = id
  AND (
    team_id IS NULL
    OR public._teams_is_active_member(auth.uid(), team_id)
    OR public._teams_is_owner(auth.uid(), team_id)
  )
);

-- ── 4. record_compass_usage: sanity cap + per-minute rate limit ─────────────

ALTER TABLE public.compass_tokens
  ADD COLUMN IF NOT EXISTS calls_this_minute integer NOT NULL DEFAULT 0;
ALTER TABLE public.compass_tokens
  ADD COLUMN IF NOT EXISTS minute_window_start timestamptz NOT NULL DEFAULT now();

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
  -- Sanity cap: no single legitimate turn records anywhere near this.
  IF p_tokens > 5000000 THEN
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

  SELECT * INTO r FROM compass_tokens WHERE user_id = uid FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO compass_tokens (user_id, tier, tokens_used_this_month, monthly_limit, last_reset_at)
    VALUES (uid, t, 0, lim, now());
    SELECT * INTO r FROM compass_tokens WHERE user_id = uid FOR UPDATE;
  END IF;

  -- Rate limit: at most 60 recording calls per user per minute. Generous for
  -- real streams (one per turn + a few aux calls); blocks RPC spam.
  IF now() - r.minute_window_start > interval '1 minute' THEN
    UPDATE compass_tokens
    SET calls_this_minute = 1, minute_window_start = now()
    WHERE user_id = uid;
  ELSIF r.calls_this_minute >= 60 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited');
  ELSE
    UPDATE compass_tokens
    SET calls_this_minute = calls_this_minute + 1
    WHERE user_id = uid;
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
