-- v11 hardening: compass_tokens writes must only flow through the
-- SECURITY DEFINER RPCs (record_compass_usage / get_compass_usage_state).
-- RLS already restricts SELECT to the owning user and defines no
-- INSERT/UPDATE/DELETE policies; this REVOKE adds defense-in-depth so a
-- future permissive policy or grant cannot silently re-open direct writes.

REVOKE INSERT, UPDATE, DELETE ON public.compass_tokens FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.compass_tokens FROM anon;
