-- ---------------------------------------------------------------------------
-- Service RPCs for the pending-OAuth-session store.
-- ---------------------------------------------------------------------------
--
-- WHY THIS IS A SEPARATE MIGRATION rather than part of 20260914130000: that one
-- created `private.mcp_oauth_sessions` and gave it the same lockdown as the
-- credentials table — not exposed to PostgREST, RLS on, no policies, grants to
-- service_role only. Which is correct, and which is exactly why the proxy
-- cannot reach it: supabase-js `.from()` goes through PostgREST, and PostgREST
-- is deliberately blind to the `private` schema.
--
-- The credentials table already had its three `*_service` functions for this
-- reason. The sessions table did not, and the omission only surfaced when the
-- OAuth flow was written against it. A table the proxy cannot read is a table
-- the proxy cannot use.
--
-- SINGLE USE IS ENFORCED HERE, NOT IN THE CLIENT. `take` deletes the row in the
-- same statement it returns it, so a replayed callback finds nothing — which is
-- what makes `verify_jwt = false` on the callback route safe. A client-side
-- "delete after reading" would leave a window, and the window is the attack.

BEGIN;

-- ---------------------------------------------------------------------------
-- Store a pending flow.
-- ---------------------------------------------------------------------------
-- The state is stored HASHED. A database read therefore does not yield a
-- usable state value, which matters because the state is the only thing
-- authenticating the callback.
CREATE OR REPLACE FUNCTION public.mcp_oauth_session_put_service(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  -- Sweep on write as well as on read, so an abandoned flow cannot accumulate
  -- without a cron job to remove it.
  DELETE FROM private.mcp_oauth_sessions WHERE expires_at < now();

  INSERT INTO private.mcp_oauth_sessions
    (state_hash, user_id, server_id, code_verifier, token_endpoint, client_id)
  VALUES (
    decode(p_input->>'state_hash', 'hex'),
    (p_input->>'user_id')::uuid,
    (p_input->>'server_id')::uuid,
    p_input->>'code_verifier',
    p_input->>'token_endpoint',
    NULLIF(p_input->>'client_id', '')
  )
  ON CONFLICT (state_hash) DO NOTHING;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- Consume a pending flow. Returns it ONCE, ever.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mcp_oauth_session_take_service(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  row private.mcp_oauth_sessions%ROWTYPE;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  DELETE FROM private.mcp_oauth_sessions WHERE expires_at < now();

  -- DELETE ... RETURNING is the whole point: the read and the invalidation are
  -- one statement, so two concurrent callbacks cannot both succeed.
  DELETE FROM private.mcp_oauth_sessions
   WHERE state_hash = decode(p_input->>'state_hash', 'hex')
     AND expires_at >= now()
  RETURNING * INTO row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expired_or_unknown');
  END IF;

  -- THE USER ID COMES FROM HERE, never from the callback's query string. That
  -- is what makes an unauthenticated callback route safe: 256 bits of CSPRNG,
  -- single use, ten-minute TTL, bound to a user at mint time.
  RETURN jsonb_build_object(
    'ok', true,
    'user_id', row.user_id,
    'server_id', row.server_id,
    'code_verifier', row.code_verifier,
    'token_endpoint', row.token_endpoint,
    'client_id', row.client_id
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Serialise a token refresh, so a rotating refresh token is not spent twice.
-- ---------------------------------------------------------------------------
-- THE BUG THIS EXISTS TO PREVENT: two simultaneous calls on an expired token
-- both refresh; the second one's refresh token has already been invalidated by
-- the first; the connector dies and the user is told to reconnect for no reason
-- they can see. Most providers now rotate refresh tokens, so this is the common
-- case rather than the rare one.
--
-- A transaction-scoped advisory lock: it releases when the transaction ends,
-- including on a crash, so a dead proxy cannot wedge a user's connector.
CREATE OR REPLACE FUNCTION public.mcp_refresh_lock_service(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  got boolean;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  SELECT pg_try_advisory_xact_lock(
    hashtextextended(p_input->>'server_id', 0)
  ) INTO got;
  RETURN jsonb_build_object('ok', true, 'acquired', got);
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants. CREATE OR REPLACE re-grants EXECUTE to PUBLIC — read `proacl` back.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.mcp_oauth_session_put_service(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_session_put_service(jsonb) TO service_role;

REVOKE EXECUTE ON FUNCTION public.mcp_oauth_session_take_service(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_session_take_service(jsonb) TO service_role;

REVOKE EXECUTE ON FUNCTION public.mcp_refresh_lock_service(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_refresh_lock_service(jsonb) TO service_role;

COMMIT;
