-- ---------------------------------------------------------------------------
-- Security advisor cleanup (2026-10-06)
-- ---------------------------------------------------------------------------
--
-- 1. Teams were removed (tables dropped), but two of their functions stayed:
--    `_teams_is_owner` reads a table that no longer exists, and
--    `guard_teams_sensitive_columns` guards it. Both were callable by `anon`
--    through /rest/v1/rpc. Dropped.
--
-- 2. Trigger functions are never meant to be called through the API. A trigger
--    fires without an EXECUTE check on the caller, so taking EXECUTE away from
--    the API roles changes nothing for the triggers themselves.
--
-- 3. TRUNCATE is NOT filtered by row-level security (proved on this database
--    2026-09-14, inside a rollback). PostgREST has no TRUNCATE verb, so it is
--    not reachable today, but it is one bug away from total data loss.
--    REFERENCES, TRIGGER and MAINTAIN are privileges nothing here intends the
--    API roles to have either. Revoked from every public table, and from the
--    defaults so tables created later do not get them back.
--
-- 4. New functions stop being executable by anon/PUBLIC by default. Every
--    function this project exposes already GRANTs explicitly to the role that
--    calls it, so this only removes the accidental case.

BEGIN;

DROP FUNCTION IF EXISTS public._teams_is_owner(uuid, uuid);
DROP FUNCTION IF EXISTS public.guard_teams_sensitive_columns();

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_users_sensitive_columns() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO supabase_auth_admin, service_role;
GRANT EXECUTE ON FUNCTION public.guard_users_sensitive_columns() TO service_role;

REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon;

COMMIT;
