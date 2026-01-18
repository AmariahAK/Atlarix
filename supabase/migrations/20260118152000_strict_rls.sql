-- Security Hardening Migration: Strict RLS Policies for public.users
-- Addresses "Permissive policies" warnings by restricting policies to specific roles (authenticated, service_role).

-- 1. Security Fix: mutable search_path in handle_new_user
-- (Ported from 20260118_security_hardening.sql which had invalid timestamp)
ALTER FUNCTION public.handle_new_user() SET search_path = public;

-- 2. Drop existing permissive policies
DROP POLICY IF EXISTS "Users can read own data" ON public.users;
DROP POLICY IF EXISTS "Users can update own subscription" ON public.users;
DROP POLICY IF EXISTS "Service role has full access" ON public.users;
DROP POLICY IF EXISTS "Enable insert for auth" ON public.users;

-- 2. Create strict policies with TO clause

-- Policy: Users can read own data (Strictly for authenticated users)
CREATE POLICY "Users can read own data" 
ON public.users 
FOR SELECT 
TO authenticated 
USING ((select auth.uid()) = id);

-- Policy: Users can update own subscription (Strictly for authenticated users)
-- Note: 'Users can update own subscription' is the existing name, keeping it for consistency though it applies to the row.
CREATE POLICY "Users can update own subscription" 
ON public.users 
FOR UPDATE 
TO authenticated 
USING ((select auth.uid()) = id);

-- Policy: Service role has full access
CREATE POLICY "Service role has full access" 
ON public.users 
FOR ALL 
TO service_role 
USING (true);

-- Policy: Enable insert for auth (Strictly for authenticated users)
-- This assumes the user is already authenticated when their profile is created (e.g. via trigger or client-side after login).
-- If 'anon' needs to insert (e.g. during sign-up before auth confirmed), this might need adjustment, 
-- but normally auth.users trigger handles creation or the user is authenticated via OAuth/MagicLink.
CREATE POLICY "Enable insert for auth" 
ON public.users 
FOR INSERT 
TO authenticated 
WITH CHECK ((select auth.uid()) = id);
