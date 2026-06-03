-- Security Hardening Migration (legacy)
-- Superseded by 20260118152000_strict_rls.sql for RLS policy names matching production.
-- Kept for migration history; drops old policy names only.

ALTER FUNCTION public.handle_new_user() SET search_path = public;

DROP POLICY IF EXISTS "Users can read own data" ON public.users;
DROP POLICY IF EXISTS "Users can update own subscription" ON public.users;
DROP POLICY IF EXISTS "Users can update own row" ON public.users;
DROP POLICY IF EXISTS "Service role has full access" ON public.users;
DROP POLICY IF EXISTS "Enable insert for auth" ON public.users;
