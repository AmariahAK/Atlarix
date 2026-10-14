-- ===========================================================================
-- MCP marketplace on the official MCP Registry: what account connectors need.
-- ===========================================================================
--
-- Web MCP servers (a public https URL) now live on the account from EVERY
-- surface (app, CLI, VS Code, ACP and the Chrome extension), not only from the
-- website. Three things follow:
--
--   1. `auth_header`: a registry server can declare a named secret header
--      (`X-Api-Key`, `Sentry-Token`, …). The proxy sent every `header` secret
--      as `X-API-Key`, so any other name could not work.
--   2. `registry_name`: which registry server a connector was installed from,
--      so the marketplace can show it as added (and the Verified five as on).
--   3. `return_to` on a pending OAuth flow: a sign-in started from the app
--      lands on a page that says to go back to Atlarix, instead of the account
--      page as if it had been started there. One fixed value, never a URL.
--
-- Also fixes the refresh lock. `pg_try_advisory_xact_lock` is released when its
-- transaction ends, and each PostgREST RPC call IS its own transaction, so the
-- lock was gone before the proxy began refreshing: two concurrent calls on an
-- expired token both refreshed, and a rotating refresh token was spent twice.
-- A row with an expiry holds across calls and still frees itself if the proxy
-- dies mid-refresh.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1 + 2. Columns.
-- ---------------------------------------------------------------------------
ALTER TABLE public.account_mcp_servers
  ADD COLUMN IF NOT EXISTS auth_header text,
  ADD COLUMN IF NOT EXISTS registry_name text;

-- An HTTP header name (RFC 9110 token), bounded. `Authorization` is excluded:
-- an `api_key` connector already sends `Authorization: Bearer`.
ALTER TABLE public.account_mcp_servers
  DROP CONSTRAINT IF EXISTS account_mcp_servers_auth_header_shape;
ALTER TABLE public.account_mcp_servers
  ADD CONSTRAINT account_mcp_servers_auth_header_shape
    CHECK (
      auth_header IS NULL
      OR (auth_header ~ '^[A-Za-z0-9!#$%&''*+.^_`|~-]{1,64}$'
          AND lower(auth_header) <> 'authorization')
    );

ALTER TABLE public.account_mcp_servers
  DROP CONSTRAINT IF EXISTS account_mcp_servers_registry_name_shape;
ALTER TABLE public.account_mcp_servers
  ADD CONSTRAINT account_mcp_servers_registry_name_shape
    CHECK (registry_name IS NULL OR registry_name ~ '^[A-Za-z0-9._/-]{3,200}$');

-- ---------------------------------------------------------------------------
-- The upsert, now with both columns. Changing the header name clears the
-- credential, exactly like changing the URL or the auth kind: a secret made
-- for one header must not silently be sent under another.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_account_mcp_server(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  v_id uuid := NULLIF(p_input->>'id', '')::uuid;
  v_slug text := p_input->>'slug';
  existing public.account_mcp_servers%ROWTYPE;
  saved public.account_mcp_servers%ROWTYPE;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
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
$$;

-- ---------------------------------------------------------------------------
-- 3. Where a finished sign-in returns to.
-- ---------------------------------------------------------------------------
ALTER TABLE private.mcp_oauth_sessions
  ADD COLUMN IF NOT EXISTS return_to text;
ALTER TABLE private.mcp_oauth_sessions
  DROP CONSTRAINT IF EXISTS mcp_oauth_sessions_return_to;
ALTER TABLE private.mcp_oauth_sessions
  ADD CONSTRAINT mcp_oauth_sessions_return_to
    CHECK (return_to IS NULL OR return_to IN ('app'));

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

  DELETE FROM private.mcp_oauth_sessions WHERE expires_at < now();

  INSERT INTO private.mcp_oauth_sessions
    (state_hash, user_id, server_id, code_verifier, token_endpoint, client_id, return_to)
  VALUES (
    decode(p_input->>'state_hash', 'hex'),
    (p_input->>'user_id')::uuid,
    (p_input->>'server_id')::uuid,
    p_input->>'code_verifier',
    p_input->>'token_endpoint',
    NULLIF(p_input->>'client_id', ''),
    NULLIF(p_input->>'return_to', '')
  )
  ON CONFLICT (state_hash) DO NOTHING;

  RETURN jsonb_build_object('ok', true);
END;
$$;

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

  DELETE FROM private.mcp_oauth_sessions
   WHERE state_hash = decode(p_input->>'state_hash', 'hex')
     AND expires_at >= now()
  RETURNING * INTO row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expired_or_unknown');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', row.user_id,
    'server_id', row.server_id,
    'code_verifier', row.code_verifier,
    'token_endpoint', row.token_endpoint,
    'client_id', row.client_id,
    'return_to', row.return_to
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. The refresh lock, as a row that outlives the RPC's transaction.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS private.mcp_refresh_locks (
  server_id uuid PRIMARY KEY
    REFERENCES public.account_mcp_servers(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
ALTER TABLE private.mcp_refresh_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.mcp_refresh_locks FROM PUBLIC;
REVOKE ALL ON private.mcp_refresh_locks FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON private.mcp_refresh_locks TO service_role;

-- Acquire: one holder per connector until it releases or 60 s pass. The
-- expiry is what keeps a proxy that died mid-refresh from wedging a connector.
CREATE OR REPLACE FUNCTION public.mcp_refresh_lock_service(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_server uuid := (p_input->>'server_id')::uuid;
  n integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  DELETE FROM private.mcp_refresh_locks
   WHERE server_id = v_server AND expires_at < now();
  INSERT INTO private.mcp_refresh_locks (server_id, expires_at)
  VALUES (v_server, now() + interval '60 seconds')
  ON CONFLICT (server_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'acquired', n > 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_refresh_unlock_service(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  DELETE FROM private.mcp_refresh_locks
   WHERE server_id = (p_input->>'server_id')::uuid;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants. CREATE OR REPLACE re-grants EXECUTE to PUBLIC, so every function
-- touched here is re-locked. VERIFY BY READING `proacl` BACK:
--
--   SELECT p.proname, p.proacl FROM pg_proc p
--    WHERE p.proname IN ('upsert_account_mcp_server', 'mcp_oauth_session_put_service',
--      'mcp_oauth_session_take_service', 'mcp_refresh_lock_service',
--      'mcp_refresh_unlock_service');
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.upsert_account_mcp_server(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_account_mcp_server(jsonb) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.mcp_oauth_session_put_service(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_session_put_service(jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.mcp_oauth_session_take_service(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_session_take_service(jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.mcp_refresh_lock_service(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_refresh_lock_service(jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.mcp_refresh_unlock_service(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_refresh_unlock_service(jsonb) TO service_role;

COMMIT;
