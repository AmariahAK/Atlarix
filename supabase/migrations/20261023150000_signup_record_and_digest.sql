-- ---------------------------------------------------------------------------
-- Where, on what and on which version each account started, and the owner's
-- morning list of new accounts.
-- ---------------------------------------------------------------------------
--
-- users.first_surface/first_seen_at were written by the first model turn only
-- (record_usage_batch, record_client_usage). Most sign-ups never ran a turn,
-- so we could not tell where they came from (10 of the last 15, 2026-10-23).
-- record_client_seen is called at sign-in by the app, the CLI, the editors and
-- the website, as the account itself: which part of Atlarix, its version and
-- the OS. first_* are kept once; last_app_version/last_os follow the latest
-- sign-in. last_surface/last_seen_at stay with usage, so "active" keeps its
-- meaning.
--
-- Like the usage records it is kept with the account and is not covered by the
-- analytics choice (the privacy page says so).
--
-- digest_new_users feeds the 08:00 MYT email (atlarix-daily-digest): every
-- account created since p_since, what it set up and whether its turns worked.
-- Service role only. REPORTING ONLY: nothing reads either to decide what a
-- user may do.

BEGIN;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS first_app_version text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS first_os text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_app_version text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_os text;

-- ---------------------------------------------------------------------------
-- record_client_seen: one call per sign-in (per process), for the caller.
-- ---------------------------------------------------------------------------
-- p_os is the client's platform word (darwin, win32, linux; the website sends
-- the same words). A value that fails a check is dropped, never stored.
CREATE OR REPLACE FUNCTION public.record_client_seen(p_surface text, p_app_version text, p_os text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := auth.uid();
  v text := CASE WHEN p_app_version ~ '^[0-9A-Za-z.+-]{1,32}$' THEN p_app_version END;
  o text := CASE WHEN p_os ~ '^[a-z0-9_]{1,16}$' THEN p_os END;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF p_surface IS NULL OR p_surface NOT IN ('app', 'cli', 'acp', 'vscode', 'website') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_arguments');
  END IF;

  UPDATE public.users SET
    first_surface     = COALESCE(first_surface, p_surface),
    first_seen_at     = COALESCE(first_seen_at, now()),
    -- The first version and OS belong to the first surface: set together.
    first_app_version = CASE WHEN first_surface IS NULL THEN v ELSE first_app_version END,
    first_os          = CASE WHEN first_surface IS NULL THEN o ELSE first_os END,
    last_app_version  = COALESCE(v, last_app_version),
    last_os           = COALESCE(o, last_os)
  WHERE id = uid;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- CREATE OR REPLACE resets grants: these come after it, every time.
REVOKE EXECUTE ON FUNCTION public.record_client_seen(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_client_seen(text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_client_seen(text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- digest_new_users: accounts created since p_since, for the morning email.
-- ---------------------------------------------------------------------------
-- One row per account, internal accounts excluded. Turns come from the
-- client's daily counts (every model, own keys included); Auto's from the
-- proxy's. "Set up" is what the account keeps with us: MCP servers, cloud
-- jobs, GitHub installs, Slack links, session ratings.
CREATE OR REPLACE FUNCTION public.digest_new_users(p_since timestamptz)
RETURNS TABLE (
  email             text,
  signed_up         timestamptz,
  sign_in           text,
  first_surface     text,
  first_app_version text,
  first_os          text,
  last_surface      text,
  last_app_version  text,
  last_seen_at      timestamptz,
  turns             bigint,
  failed_turns      bigint,
  last_error_kind   text,
  models            text[],
  auto_requests     bigint,
  auto_errors       bigint,
  mcp_servers       bigint,
  cloud_jobs        bigint,
  github_installs   bigint,
  slack_links       bigint,
  ratings           bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT au.email::text,
         au.created_at,
         au.raw_app_meta_data->>'provider',
         u.first_surface,
         u.first_app_version,
         u.first_os,
         u.last_surface,
         u.last_app_version,
         u.last_seen_at,
         COALESCE(c.turns, 0),
         COALESCE(c.failed, 0),
         c.last_error_kind,
         COALESCE(c.models, '{}'),
         COALESCE(d.requests, 0),
         COALESCE(d.errors, 0),
         (SELECT count(*) FROM public.account_mcp_servers x WHERE x.user_id = au.id),
         (SELECT count(*) FROM public.cloud_jobs x WHERE x.user_id = au.id),
         (SELECT count(*) FROM public.github_installs x WHERE x.user_id = au.id),
         (SELECT count(*) FROM public.slack_links x WHERE x.user_id = au.id),
         (SELECT count(*) FROM public.session_feedback x WHERE x.user_id = au.id AND x.kind = 'rating')
    FROM auth.users au
    LEFT JOIN public.users u ON u.id = au.id
    LEFT JOIN LATERAL (
      SELECT sum(cu.turns)::bigint AS turns,
             sum(cu.failed_turns)::bigint AS failed,
             (array_agg(cu.last_error_kind ORDER BY cu.last_seen DESC)
                FILTER (WHERE cu.last_error_kind IS NOT NULL))[1] AS last_error_kind,
             array_agg(DISTINCT cu.billing || ' ' || cu.provider_type || ' ' || cu.model) AS models
        FROM public.client_usage_daily cu
       WHERE cu.user_id = au.id
    ) c ON true
    LEFT JOIN LATERAL (
      SELECT sum(ud.requests)::bigint AS requests, sum(ud.errors)::bigint AS errors
        FROM public.usage_daily ud
       WHERE ud.user_id = au.id
    ) d ON true
   WHERE au.created_at >= p_since
     AND au.email NOT IN ('amariah.abish@gmail.com', 'amani.kamau06@gmail.com',
                          'agent@atlarix.dev', 'mojo.alexander3@gmail.com', 'amariah@atlarix.dev')
   ORDER BY au.created_at;
$$;

REVOKE EXECUTE ON FUNCTION public.digest_new_users(timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.digest_new_users(timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION public.digest_new_users(timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.digest_new_users(timestamptz) TO service_role;

COMMIT;
