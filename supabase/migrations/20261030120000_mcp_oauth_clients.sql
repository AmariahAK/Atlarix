-- ---------------------------------------------------------------------------
-- Pre-registered OAuth clients for account connectors.
-- ---------------------------------------------------------------------------
--
-- WHY. Some MCP servers (Slack's, at mcp.slack.com) refuse dynamic client
-- registration and require a confidential client: a client id and secret the
-- user's own app was registered with. The proxy creates that app for the
-- user (one internal Slack app per workspace, from a manifest) and must keep
-- its secret to exchange and refresh tokens. The secret is sealed by the proxy
-- (AES-256-GCM under ATLARIX_MCP_CRED_KEY, AAD bound to the connector and the
-- account) before it reaches this table, like the tokens in mcp_credentials.
--
-- WHY A TABLE OF ITS OWN, not a field of mcp_credentials: the client outlives
-- the token. A token is cleared on disconnect and rewritten on every refresh;
-- the client must survive both, or "reconnect" would need a new Slack app.
--
-- Service role only. No policy, no PostgREST exposure; the proxy reads it
-- through the *_service RPCs below, the same shape as mcp_credential_*.

BEGIN;

CREATE TABLE IF NOT EXISTS private.mcp_oauth_clients (
  server_id uuid PRIMARY KEY REFERENCES public.account_mcp_servers (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  client_id text NOT NULL,
  client_secret_ct bytea NOT NULL,
  nonce bytea NOT NULL,
  key_version smallint NOT NULL DEFAULT 1,
  -- The scopes the client was registered for; what the authorize request asks.
  scope text,
  -- The provider's own id for the app (Slack's app_id), shown once so the
  -- person can find and delete the app themselves.
  provider_app_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_oauth_clients_nonce_length CHECK (octet_length(nonce) = 12)
);

ALTER TABLE private.mcp_oauth_clients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.mcp_oauth_clients FROM PUBLIC;
REVOKE ALL ON private.mcp_oauth_clients FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON private.mcp_oauth_clients TO service_role;

CREATE OR REPLACE FUNCTION public.mcp_oauth_client_get_service(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  row private.mcp_oauth_clients%ROWTYPE;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  SELECT * INTO row FROM private.mcp_oauth_clients
   WHERE server_id = (p_input->>'server_id')::uuid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'client_id', row.client_id,
    'client_secret_ct', encode(row.client_secret_ct, 'base64'),
    'nonce', encode(row.nonce, 'base64'),
    'key_version', row.key_version,
    'scope', row.scope,
    'provider_app_id', row.provider_app_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_oauth_client_put_service(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  INSERT INTO private.mcp_oauth_clients
    (server_id, user_id, client_id, client_secret_ct, nonce, key_version, scope, provider_app_id)
  VALUES (
    (p_input->>'server_id')::uuid,
    (p_input->>'user_id')::uuid,
    p_input->>'client_id',
    decode(p_input->>'client_secret_ct', 'base64'),
    decode(p_input->>'nonce', 'base64'),
    COALESCE((p_input->>'key_version')::smallint, 1),
    NULLIF(p_input->>'scope', ''),
    NULLIF(p_input->>'provider_app_id', '')
  )
  ON CONFLICT (server_id) DO UPDATE SET
    client_id = EXCLUDED.client_id,
    client_secret_ct = EXCLUDED.client_secret_ct,
    nonce = EXCLUDED.nonce,
    key_version = EXCLUDED.key_version,
    scope = EXCLUDED.scope,
    provider_app_id = EXCLUDED.provider_app_id,
    updated_at = now();
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_oauth_client_clear_service(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  DELETE FROM private.mcp_oauth_clients
   WHERE server_id = (p_input->>'server_id')::uuid;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- The pending sign-in remembers how the token endpoint authenticates the client.
ALTER TABLE private.mcp_oauth_sessions
  ADD COLUMN IF NOT EXISTS token_auth_method text;
ALTER TABLE private.mcp_oauth_sessions
  DROP CONSTRAINT IF EXISTS mcp_oauth_sessions_token_auth_method;
ALTER TABLE private.mcp_oauth_sessions
  ADD CONSTRAINT mcp_oauth_sessions_token_auth_method
    CHECK (token_auth_method IS NULL OR token_auth_method IN ('none', 'client_secret_post', 'client_secret_basic'));

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
    (state_hash, user_id, server_id, code_verifier, token_endpoint, client_id, return_to, token_auth_method)
  VALUES (
    decode(p_input->>'state_hash', 'hex'),
    (p_input->>'user_id')::uuid,
    (p_input->>'server_id')::uuid,
    p_input->>'code_verifier',
    p_input->>'token_endpoint',
    NULLIF(p_input->>'client_id', ''),
    NULLIF(p_input->>'return_to', ''),
    NULLIF(p_input->>'token_auth_method', '')
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
    'return_to', row.return_to,
    'token_auth_method', row.token_auth_method
  );
END;
$$;

-- A connector whose URL or auth type changes loses its client with its token:
-- a client registered for one server is no good at another.
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
      DELETE FROM private.mcp_oauth_clients WHERE server_id = existing.id;
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

-- Grants, re-issued for every function CREATE OR REPLACE touched. Read back:
--   SELECT p.proname, p.proacl FROM pg_proc p
--    WHERE p.proname IN ('mcp_oauth_client_get_service', 'mcp_oauth_client_put_service',
--      'mcp_oauth_client_clear_service', 'mcp_oauth_session_put_service',
--      'mcp_oauth_session_take_service', 'upsert_account_mcp_server');
REVOKE EXECUTE ON FUNCTION public.mcp_oauth_client_get_service(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_client_get_service(jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.mcp_oauth_client_put_service(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_client_put_service(jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.mcp_oauth_client_clear_service(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_client_clear_service(jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.mcp_oauth_session_put_service(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_session_put_service(jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.mcp_oauth_session_take_service(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_session_take_service(jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.upsert_account_mcp_server(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_account_mcp_server(jsonb) TO authenticated;

COMMIT;
