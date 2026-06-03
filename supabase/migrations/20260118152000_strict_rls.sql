-- Security Hardening Migration: Strict RLS Policies for public.users
-- Matches production policy names and expressions.

ALTER FUNCTION public.handle_new_user() SET search_path = public;

DROP POLICY IF EXISTS "Users can read own data" ON public.users;
DROP POLICY IF EXISTS "Users can update own subscription" ON public.users;
DROP POLICY IF EXISTS "Users can update own row" ON public.users;
DROP POLICY IF EXISTS "Service role has full access" ON public.users;
DROP POLICY IF EXISTS "Enable insert for auth" ON public.users;

CREATE POLICY "Users can read own data"
ON public.users
FOR SELECT
USING ((SELECT auth.uid()) = id);

CREATE POLICY "Users can update own row"
ON public.users
FOR UPDATE
TO authenticated
USING ((SELECT auth.uid()) = id)
WITH CHECK ((SELECT auth.uid()) = id);

CREATE POLICY "Service role has full access"
ON public.users
FOR ALL
USING ((SELECT auth.role()) = 'service_role');

CREATE POLICY "Enable insert for auth"
ON public.users
FOR INSERT
WITH CHECK ((SELECT auth.uid()) = id);
