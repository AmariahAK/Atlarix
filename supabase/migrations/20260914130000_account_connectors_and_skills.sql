-- ---------------------------------------------------------------------------
-- Account-side MCP connectors and skills.
-- ---------------------------------------------------------------------------
--
-- THE SHAPE. A connector is configured ONCE per account on the launchpad and
-- every surface inherits it -- which is what Claude in Chrome does ("your
-- skills, plugins and connectors work here; they behave the same way they do on
-- desktop"), and it is only possible because the credentials live server-side.
-- The PROXY is the sole holder: it performs the OAuth exchange, holds the
-- encryption key, refreshes the token and makes every call to a remote MCP
-- server. NO TOKEN EVER REACHES A CLIENT, and that is directly observable in
-- the extension's own network panel.
--
-- THE DESKTOP IS UNCHANGED. It keeps its local loopback-OAuth path in
-- `src/lib/mcp/`, because a desktop app CAN run a loopback listener and because
-- local stdio servers need one. An extension can reach only remote HTTP MCP
-- servers, never stdio -- which is why `transport` below is a one-value CHECK
-- rather than a comment.
--
-- NO PER-SURFACE RESTRICTION, and this is a recorded owner decision rather than
-- an oversight. A remote MCP server can expose file or command execution, so
-- account-side connectors give the extension reach that `docs/TODO.md`'s old
-- rule 2 ("never a filesystem or a shell") forbade. The decision: adding a
-- connector is already an explicit act of trust, exactly as it is in Claude and
-- ChatGPT. The consequence, stated plainly so nobody has to rediscover it: the
-- `<untrusted-data>` envelope is now the ONLY remaining structural boundary
-- between a web page the agent reads and a connector's tools. It is a
-- prompt-injection mitigation, not a capability boundary.
--
-- ONE `jsonb` ARGUMENT ON EVERY RPC. This neutralises the overload trap
-- outright: adding a field never changes a signature, so there is never a
-- second overload and never a forgotten DROP FUNCTION.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. A private schema, which is stronger than RLS-with-no-policies.
-- ---------------------------------------------------------------------------
-- `supabase/config.toml` exposes only `public` and `graphql_public` to
-- PostgREST, so a table in `private` is not reachable by the Data API AT ALL --
-- not with a leaked anon key, not with a stolen user JWT, and not if someone
-- later adds a policy by mistake. Both controls are used here, belt and braces.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
REVOKE ALL ON SCHEMA private FROM anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Connectors -- client-readable, never client-writable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  url text NOT NULL,
  transport text NOT NULL DEFAULT 'http',
  auth_type text NOT NULL DEFAULT 'none',
  enabled boolean NOT NULL DEFAULT false,
  first_enabled_at timestamptz,
  -- [{name, description}] ONLY. Never JSON schemas: the catalog stays cheap and
  -- the model stays unforced, which is the whole discovery design.
  tools_cache jsonb NOT NULL DEFAULT '[]'::jsonb,
  tools_cached_at timestamptz,
  last_error text,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- LOAD-BEARING. The connector NAME is the only piece of connector metadata
  -- that goes into the system prompt, which is the one region the untrusted-data
  -- envelope cannot reach. This regex is what makes that safe by construction:
  -- no newlines, no angle brackets, no quotes, bounded length.
  CONSTRAINT account_mcp_servers_name_prompt_safe
    CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$'),
  CONSTRAINT account_mcp_servers_slug_shape
    CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  CONSTRAINT account_mcp_servers_description_length
    CHECK (char_length(description) <= 500),
  -- A cheap belt. The real SSRF control is in the proxy and runs at CALL time
  -- as well as write time, because DNS can be rebound in between.
  CONSTRAINT account_mcp_servers_url_https
    CHECK (url ~ '^https://'),
  CONSTRAINT account_mcp_servers_url_not_private
    CHECK (
      url !~* '^https://(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)'
      AND url !~* '\.local(/|:|$)'
    ),
  -- One value, deliberately: an account-side server can never be stdio, and a
  -- constraint is where that belongs rather than a client-side comment.
  CONSTRAINT account_mcp_servers_transport
    CHECK (transport IN ('http')),
  CONSTRAINT account_mcp_servers_auth_type
    CHECK (auth_type IN ('none', 'oauth', 'api_key', 'header')),
  -- A remote server must not be able to grow an unbounded blob in our database
  -- by advertising fifty thousand tools.
  CONSTRAINT account_mcp_servers_tools_cache_shape
    CHECK (
      jsonb_typeof(tools_cache) = 'array'
      AND jsonb_array_length(tools_cache) <= 200
      AND octet_length(tools_cache::text) <= 65536
    ),
  -- Sanitised at the write site too. An upstream error body can echo back the
  -- Authorization header we sent, and this column renders on the launchpad.
  CONSTRAINT account_mcp_servers_last_error_length
    CHECK (last_error IS NULL OR char_length(last_error) <= 300)
);

-- `mcp_call` resolves a server BY NAME, so this is not cosmetic: without it the
-- resolution is ambiguous and the failure mode is a call landing on the wrong
-- server.
CREATE UNIQUE INDEX IF NOT EXISTS account_mcp_servers_user_slug_idx
  ON public.account_mcp_servers (user_id, slug);
CREATE INDEX IF NOT EXISTS account_mcp_servers_user_enabled_idx
  ON public.account_mcp_servers (user_id) WHERE enabled;

ALTER TABLE public.account_mcp_servers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "account_mcp_servers_select_own" ON public.account_mcp_servers
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- NO INSERT/UPDATE/DELETE POLICY, deliberately, and no grant for one to narrow.
-- The USING/WITH-CHECK asymmetry that lets a user reassign `user_id` is avoided
-- by not having an UPDATE policy at all, rather than by writing one correctly.
GRANT SELECT ON public.account_mcp_servers TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.account_mcp_servers FROM authenticated;
REVOKE ALL ON public.account_mcp_servers FROM anon;

-- ---------------------------------------------------------------------------
-- 3. Credentials -- unreadable by anyone, including their owner.
-- ---------------------------------------------------------------------------
-- AES-256-GCM, sealed and opened IN THE PROXY, key in `ATLARIX_MCP_CRED_KEY`
-- (a Railway variable, never in this database). AAD is `server_id:user_id`, so
-- lifting a ciphertext onto another row yields a decryption failure rather than
-- a working credential.
--
-- DELIBERATELY NOT SUPABASE VAULT: Vault keeps key material in the database's
-- own keyring, which merges the two blast radii this design exists to separate.
--
-- BLAST RADIUS, stated rather than implied:
--   * anon key or any user JWT  -> nothing; the schema is not exposed to
--     PostgREST, there are no grants, and the owner cannot read their own token
--   * service key alone, or a full dump -> ciphertext and nonces, no key
--   * ATLARIX_MCP_CRED_KEY alone -> nothing without the rows
--   * BOTH (a full proxy compromise) -> every connector token for every user
--
-- That last row is the real answer, and it means THIS CHANGE MAKES THE PROXY A
-- CREDENTIAL VAULT. The rationale in `atlarix-proxy/src/jwt.ts` -- "this service
-- reads structured chat requests and nothing else" -- stops being true and is
-- updated in the same release.
CREATE TABLE IF NOT EXISTS private.mcp_credentials (
  server_id uuid PRIMARY KEY
    REFERENCES public.account_mcp_servers(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  key_version smallint NOT NULL DEFAULT 1,
  -- CLEARTEXT ON PURPOSE: an expiry is not a secret, and the proxy must decide
  -- whether to refresh WITHOUT decrypting anything.
  expires_at timestamptz,
  has_refresh boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_credentials_nonce_length CHECK (octet_length(nonce) = 12)
);

ALTER TABLE private.mcp_credentials ENABLE ROW LEVEL SECURITY;
-- ZERO POLICIES, intentionally. Every non-bypassing role therefore sees nothing;
-- `service_role` bypasses RLS, which is exactly and only what the proxy needs.
-- DO NOT add a "just so the owner can see when it expires" SELECT policy --
-- expiry belongs on `account_mcp_servers` as a derived column if it is wanted.
REVOKE ALL ON private.mcp_credentials FROM PUBLIC;
REVOKE ALL ON private.mcp_credentials FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON private.mcp_credentials TO service_role;

-- Pending OAuth flows. Single-use, short-lived, and the user id comes from HERE
-- rather than from any query parameter -- which is what makes the callback safe
-- to serve unauthenticated.
CREATE TABLE IF NOT EXISTS private.mcp_oauth_sessions (
  state_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  server_id uuid NOT NULL
    REFERENCES public.account_mcp_servers(id) ON DELETE CASCADE,
  code_verifier text NOT NULL,
  token_endpoint text NOT NULL,
  client_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE INDEX IF NOT EXISTS mcp_oauth_sessions_expiry_idx
  ON private.mcp_oauth_sessions (expires_at);
ALTER TABLE private.mcp_oauth_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.mcp_oauth_sessions FROM PUBLIC;
REVOKE ALL ON private.mcp_oauth_sessions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON private.mcp_oauth_sessions TO service_role;

-- ---------------------------------------------------------------------------
-- 4. The audit trail -- the compensating control for having no gate.
-- ---------------------------------------------------------------------------
-- NO ARGUMENTS AND NO RESULTS, EVER, and enforced the same way the egress rule
-- is: there is no column to put them in.
CREATE TABLE IF NOT EXISTS public.account_mcp_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  server_id uuid REFERENCES public.account_mcp_servers(id) ON DELETE SET NULL,
  server_slug text NOT NULL,
  tool_name text NOT NULL,
  surface text NOT NULL,
  ok boolean NOT NULL,
  error_code text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_mcp_calls_surface
    CHECK (surface IN ('app', 'cli', 'extension')),
  CONSTRAINT account_mcp_calls_tool_name_length
    CHECK (char_length(tool_name) <= 100)
);
CREATE INDEX IF NOT EXISTS account_mcp_calls_user_time_idx
  ON public.account_mcp_calls (user_id, created_at DESC);

ALTER TABLE public.account_mcp_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY "account_mcp_calls_select_own" ON public.account_mcp_calls
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
GRANT SELECT ON public.account_mcp_calls TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.account_mcp_calls FROM authenticated;
REVOKE ALL ON public.account_mcp_calls FROM anon;

-- ---------------------------------------------------------------------------
-- 5. Skills -- the sibling. Identical spine, no secrets.
-- ---------------------------------------------------------------------------
-- A single polymorphic `account_resources(kind, ...)` table was considered and
-- rejected: a connector needs url/auth_type/tools_cache and a skill needs body,
-- so unifying them makes every column nullable plus CHECK-by-kind gymnastics
-- that the next resource type breaks again.
CREATE TABLE IF NOT EXISTS public.account_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT account_skills_name_prompt_safe
    CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$'),
  CONSTRAINT account_skills_slug_shape
    CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  CONSTRAINT account_skills_description_length
    CHECK (char_length(description) BETWEEN 0 AND 500),
  CONSTRAINT account_skills_body_length
    CHECK (char_length(body) <= 65536)
);

CREATE UNIQUE INDEX IF NOT EXISTS account_skills_user_slug_idx
  ON public.account_skills (user_id, slug);

ALTER TABLE public.account_skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY "account_skills_select_own" ON public.account_skills
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
GRANT SELECT ON public.account_skills TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.account_skills FROM authenticated;
REVOKE ALL ON public.account_skills FROM anon;

-- ---------------------------------------------------------------------------
-- 6. One view over both, so "siblings" is structural rather than a claim.
-- ---------------------------------------------------------------------------
-- `security_invoker = true` IS NOT OPTIONAL. A view owned by `postgres` without
-- it bypasses the base tables' RLS entirely and hands every user everyone
-- else's connectors -- a silent failure in the same family as the missing-GRANT
-- trap.
CREATE OR REPLACE VIEW public.account_capabilities
  WITH (security_invoker = true) AS
  SELECT 'mcp'::text AS kind, id, user_id, name, slug, description, enabled, updated_at
    FROM public.account_mcp_servers
  UNION ALL
  SELECT 'skill'::text, id, user_id, name, slug, description, enabled, updated_at
    FROM public.account_skills;

GRANT SELECT ON public.account_capabilities TO authenticated;
REVOKE ALL ON public.account_capabilities FROM anon;

-- ---------------------------------------------------------------------------
-- 7. Write RPCs. One jsonb in, one jsonb out.
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
    -- A row that is not the caller's returns the SAME error as one that does
    -- not exist, so this is not an existence oracle.
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;

    UPDATE public.account_mcp_servers SET
      name = COALESCE(p_input->>'name', name),
      description = COALESCE(p_input->>'description', description),
      url = COALESCE(p_input->>'url', url),
      auth_type = COALESCE(p_input->>'auth_type', auth_type),
      -- CHANGING THE ENDPOINT OR THE AUTH KIND CLEARS THE CREDENTIAL and turns
      -- the connector off. A token issued for one endpoint must not silently
      -- follow the row to another -- that is a credential-forwarding bug with a
      -- UI that looks like an edit form.
      enabled = CASE
        WHEN COALESCE(p_input->>'url', url) IS DISTINCT FROM url
          OR COALESCE(p_input->>'auth_type', auth_type) IS DISTINCT FROM auth_type
        THEN false ELSE enabled END,
      tools_cache = CASE
        WHEN COALESCE(p_input->>'url', url) IS DISTINCT FROM url
        THEN '[]'::jsonb ELSE tools_cache END,
      updated_at = now()
    WHERE id = existing.id
    RETURNING * INTO saved;

    IF saved.url IS DISTINCT FROM existing.url
       OR saved.auth_type IS DISTINCT FROM existing.auth_type THEN
      DELETE FROM private.mcp_credentials WHERE server_id = existing.id;
    END IF;
  ELSE
    IF v_slug IS NULL OR v_slug = '' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'missing_slug');
    END IF;
    INSERT INTO public.account_mcp_servers
      (user_id, name, slug, description, url, auth_type)
    VALUES (
      uid,
      COALESCE(p_input->>'name', v_slug),
      v_slug,
      COALESCE(p_input->>'description', ''),
      p_input->>'url',
      COALESCE(p_input->>'auth_type', 'none')
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

CREATE OR REPLACE FUNCTION public.set_account_mcp_server_enabled(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  v_enabled boolean := COALESCE((p_input->>'enabled')::boolean, false);
  saved public.account_mcp_servers%ROWTYPE;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  UPDATE public.account_mcp_servers
     SET enabled = v_enabled,
         -- Stamped on the first HUMAN enable, ever. The proxy's first-use
         -- activation requires it, so injected page text cannot switch on a
         -- connector the user has never turned on themselves.
         first_enabled_at = COALESCE(first_enabled_at,
           CASE WHEN v_enabled THEN now() ELSE NULL END),
         updated_at = now()
   WHERE id = NULLIF(p_input->>'id', '')::uuid AND user_id = uid
  RETURNING * INTO saved;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  RETURN jsonb_build_object('ok', true, 'enabled', saved.enabled);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_account_mcp_server(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  -- The FK cascade takes the credential with it.
  DELETE FROM public.account_mcp_servers
   WHERE id = NULLIF(p_input->>'id', '')::uuid AND user_id = uid;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_account_skill(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  v_id uuid := NULLIF(p_input->>'id', '')::uuid;
  v_slug text := p_input->>'slug';
  saved public.account_skills%ROWTYPE;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  IF v_id IS NOT NULL THEN
    UPDATE public.account_skills SET
      name = COALESCE(p_input->>'name', name),
      description = COALESCE(p_input->>'description', description),
      body = COALESCE(p_input->>'body', body),
      updated_at = now()
    WHERE id = v_id AND user_id = uid
    RETURNING * INTO saved;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;
  ELSE
    IF v_slug IS NULL OR v_slug = '' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'missing_slug');
    END IF;
    INSERT INTO public.account_skills (user_id, name, slug, description, body)
    VALUES (
      uid, COALESCE(p_input->>'name', v_slug), v_slug,
      COALESCE(p_input->>'description', ''), COALESCE(p_input->>'body', '')
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

CREATE OR REPLACE FUNCTION public.set_account_skill_enabled(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  UPDATE public.account_skills
     SET enabled = COALESCE((p_input->>'enabled')::boolean, false),
         updated_at = now()
   WHERE id = NULLIF(p_input->>'id', '')::uuid AND user_id = uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_account_skill(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  DELETE FROM public.account_skills
   WHERE id = NULLIF(p_input->>'id', '')::uuid AND user_id = uid;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Service-role functions -- the proxy's only door to the credential store.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mcp_credential_get_service(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  row private.mcp_credentials%ROWTYPE;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  SELECT * INTO row FROM private.mcp_credentials
   WHERE server_id = (p_input->>'server_id')::uuid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'ciphertext', encode(row.ciphertext, 'base64'),
    'nonce', encode(row.nonce, 'base64'),
    'key_version', row.key_version,
    'expires_at', row.expires_at,
    'has_refresh', row.has_refresh
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_credential_put_service(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  INSERT INTO private.mcp_credentials
    (server_id, user_id, ciphertext, nonce, key_version, expires_at, has_refresh)
  VALUES (
    (p_input->>'server_id')::uuid,
    (p_input->>'user_id')::uuid,
    decode(p_input->>'ciphertext', 'base64'),
    decode(p_input->>'nonce', 'base64'),
    COALESCE((p_input->>'key_version')::smallint, 1),
    NULLIF(p_input->>'expires_at', '')::timestamptz,
    COALESCE((p_input->>'has_refresh')::boolean, false)
  )
  ON CONFLICT (server_id) DO UPDATE SET
    ciphertext = EXCLUDED.ciphertext,
    nonce = EXCLUDED.nonce,
    key_version = EXCLUDED.key_version,
    expires_at = EXCLUDED.expires_at,
    has_refresh = EXCLUDED.has_refresh,
    updated_at = now();
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_credential_clear_service(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  DELETE FROM private.mcp_credentials
   WHERE server_id = (p_input->>'server_id')::uuid;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_tools_cache_service(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  UPDATE public.account_mcp_servers SET
    tools_cache = COALESCE(p_input->'tools', tools_cache),
    tools_cached_at = now(),
    -- Truncated here as well as at the write site: this column renders on the
    -- launchpad and an upstream body can echo our own Authorization header.
    last_error = left(NULLIF(p_input->>'last_error', ''), 300),
    updated_at = now()
  WHERE id = (p_input->>'server_id')::uuid;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_server_activate_service(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  row public.account_mcp_servers%ROWTYPE;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  SELECT * INTO row FROM public.account_mcp_servers
   WHERE id = (p_input->>'server_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  -- FIRST-USE ACTIVATION, BUT ONLY FOR A CONNECTOR A HUMAN HAS EVER ENABLED.
  -- This is not a per-surface gate and not a consent prompt -- both were
  -- declined. It closes exactly one path: injected page text switching on a
  -- connector that has never been used and calling it in the same turn.
  IF row.first_enabled_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'never_enabled');
  END IF;
  UPDATE public.account_mcp_servers
     SET enabled = true, updated_at = now() WHERE id = row.id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_call_log_service(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  INSERT INTO public.account_mcp_calls
    (user_id, server_id, server_slug, tool_name, surface, ok, error_code, duration_ms)
  VALUES (
    (p_input->>'user_id')::uuid,
    NULLIF(p_input->>'server_id', '')::uuid,
    p_input->>'server_slug',
    left(COALESCE(p_input->>'tool_name', ''), 100),
    COALESCE(p_input->>'surface', 'app'),
    COALESCE((p_input->>'ok')::boolean, false),
    p_input->>'error_code',
    NULLIF(p_input->>'duration_ms', '')::integer
  );
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants, re-issued because CREATE OR REPLACE re-grants EXECUTE to PUBLIC.
-- ---------------------------------------------------------------------------
-- VERIFY BY READING `proacl` BACK. No row may show an empty grantee (PUBLIC):
--
--   SELECT n.nspname, p.proname, p.proacl FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE p.proname ~ '(account_mcp|account_skill|mcp_credential|mcp_tools_cache|mcp_call_log|mcp_server_activate)';
REVOKE EXECUTE ON FUNCTION public.upsert_account_mcp_server(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_account_mcp_server(jsonb) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.set_account_mcp_server_enabled(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_account_mcp_server_enabled(jsonb) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_account_mcp_server(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_account_mcp_server(jsonb) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.upsert_account_skill(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_account_skill(jsonb) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.set_account_skill_enabled(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_account_skill_enabled(jsonb) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_account_skill(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_account_skill(jsonb) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.mcp_credential_get_service(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_credential_get_service(jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.mcp_credential_put_service(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_credential_put_service(jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.mcp_credential_clear_service(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_credential_clear_service(jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.mcp_tools_cache_service(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_tools_cache_service(jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.mcp_server_activate_service(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_server_activate_service(jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.mcp_call_log_service(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_call_log_service(jsonb) TO service_role;

COMMIT;
