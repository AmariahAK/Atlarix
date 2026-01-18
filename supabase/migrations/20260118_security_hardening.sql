-- Security Hardening Migration

-- 1. Fix handle_new_user search_path
-- Vulnerability: mutable search_path allows privilege escalation
-- We explicitly set the search_path to 'public' so it doesn't search usage-defined schemas
ALTER FUNCTION public.handle_new_user() SET search_path = public;

-- 2. Optimize RLS Policies
-- Use (select auth.uid()) instead of auth.uid() to leverage stable function caching per query

-- Policy: Users can read own data
DROP POLICY IF EXISTS "Users can read own data" ON public.users;
CREATE POLICY "Users can read own data" ON public.users FOR SELECT
USING ((select auth.uid()) = id);

-- Policy: Users can update own subscription
DROP POLICY IF EXISTS "Users can update own subscription" ON public.users;
CREATE POLICY "Users can update own subscription" ON public.users FOR UPDATE
USING ((select auth.uid()) = id);

-- Policy: Service role has full access
DROP POLICY IF EXISTS "Service role has full access" ON public.users;
CREATE POLICY "Service role has full access" ON public.users FOR ALL
USING ((select auth.role()) = 'service_role');

-- Policy: Enable insert for auth (Optimized)
DROP POLICY IF EXISTS "Enable insert for auth" ON public.users;
CREATE POLICY "Enable insert for auth" ON public.users FOR INSERT
WITH CHECK ((select auth.uid()) = id);
