-- 2026-10-29: nothing is reachable through the REST / GraphQL API unless a
-- client needs it (owner rule after the attack: "if it isn't needed on the REST
-- API, it never appears in the first place, except for us").
--
-- What the audit found (information_schema.role_table_grants, pg_default_acl):
--  - `anon` had SELECT on credit_grants, credit_transactions, credit_wallet,
--    free_usage_daily, free_usage_user_daily, github_installs, review_history,
--    and FULL privileges on users, user_bans and workforce_connected_services.
--    RLS kept the rows private, but every one of those tables was listed in the
--    anonymous OpenAPI document and one wrong policy away from a leak.
--  - `authenticated` had grants on tables no client reads directly
--    (conversations, conversation_messages, review_history, free_usage_*,
--    credit_*, extension_*, account_mcp_calls, workforce_*): the clients use the
--    RPCs for all of them.
--  - Default privileges for `postgres` still handed anon and authenticated
--    SELECT/INSERT/UPDATE/DELETE on every NEW table and EXECUTE on every new
--    function, which is how the tables above got exposed one migration at a time.
--
-- The rule now: anon gets nothing in `public`. authenticated keeps only the
-- tables the app, the website and the extension read or write directly
-- (checked against the code 2026-10-29): users (select + insert),
-- account_mcp_servers, account_skills, github_installs, cloud_jobs (select),
-- slack_links (select + delete), account_capabilities (select). Everything else
-- goes through SECURITY DEFINER RPCs, which keep their grants. Reporting views
-- move to a schema PostgREST does not expose. New objects default to private.
BEGIN;

-- ── anon: nothing ────────────────────────────────────────────────────────────
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

-- ── authenticated: only what the clients touch directly ──────────────────────
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
GRANT SELECT, INSERT ON public.users TO authenticated;
GRANT SELECT ON public.account_mcp_servers TO authenticated;
GRANT SELECT ON public.account_skills TO authenticated;
GRANT SELECT ON public.github_installs TO authenticated;
GRANT SELECT ON public.cloud_jobs TO authenticated;
GRANT SELECT, DELETE ON public.slack_links TO authenticated;
GRANT SELECT ON public.account_capabilities TO authenticated;

-- ── reporting views out of the exposed schema ────────────────────────────────
CREATE SCHEMA IF NOT EXISTS reporting;
REVOKE ALL ON SCHEMA reporting FROM PUBLIC;
GRANT USAGE ON SCHEMA reporting TO service_role;
ALTER VIEW IF EXISTS public.v_activation SET SCHEMA reporting;
ALTER VIEW IF EXISTS public.v_active_by_surface SET SCHEMA reporting;
ALTER VIEW IF EXISTS public.v_latest_model_by_surface SET SCHEMA reporting;
ALTER VIEW IF EXISTS public.v_session_feedback SET SCHEMA reporting;
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO service_role;

-- ── new objects are private by default ───────────────────────────────────────
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, PUBLIC;

COMMIT;

-- VERIFY after applying:
--   SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND grantee IN ('anon','authenticated') ORDER BY 1,2;
--   -- anon: no rows. authenticated: the seven tables above only.
--   SELECT table_schema FROM information_schema.views WHERE table_name LIKE 'v\_%';  -- reporting
