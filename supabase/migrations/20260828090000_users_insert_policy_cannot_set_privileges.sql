-- The users INSERT policy constrained identity but not privilege.
--
-- Found auditing the desktop app + Supabase project, 2026-08-28.
--
-- The policy was:
--     WITH CHECK ((select auth.uid()) = id)
--
-- which says "the row must be yours" and says nothing about what is IN it. The
-- trigger that exists to stop a client setting `plan` —
-- `users_guard_sensitive_columns` — is `tgtype = 19`, i.e. BEFORE UPDATE ROW.
-- It does not fire on INSERT, and it could not usefully: every check in it is
-- `NEW.x IS DISTINCT FROM OLD.x`, and on an INSERT there is no OLD.
--
-- So an authenticated client could
--     insert into public.users (id, plan) values (auth.uid(), 'pro')
-- and grant itself Pro — bounded only by the primary key, i.e. only reachable
-- for an account whose row is missing. Normally `handle_new_user` creates it at
-- signup, so the window is a signup where that trigger failed, or a row removed
-- by hand. Narrow, but it is a privilege escalation reachable with nothing but a
-- normal session and the public anon key.
--
-- WHY TIGHTEN RATHER THAN DROP. Dropping is defensible — `handle_new_user` is
-- SECURITY DEFINER and therefore bypasses RLS entirely, and no client anywhere
-- in the app or the launchpad inserts into this table, so the policy grants a
-- capability nothing uses. But signup is the one path that must never break, and
-- a WITH CHECK that still permits the insert while refusing the privilege costs
-- nothing and cannot strand a code path we did not find.
--
-- The columns listed mirror `users_guard_sensitive_columns`, so the INSERT and
-- UPDATE stories now say the same thing. `email` is deliberately NOT constrained
-- here: it is checked on UPDATE because changing it is identity theft, while on
-- INSERT it is simply the new row's own value.

ALTER POLICY "Enable insert for auth" ON public.users
  WITH CHECK (
    (SELECT auth.uid()) = id
    AND COALESCE(plan, 'free') = 'free'
    AND COALESCE(effective_tier, 'free') = 'free'
    AND subscription_status IS NULL
    AND subscription_ends_at IS NULL
    AND lemon_subscription_id IS NULL
    AND banned_at IS NULL
  );

-- Revert, if a client insert path turns out to exist after all:
--
--   ALTER POLICY "Enable insert for auth" ON public.users
--     WITH CHECK ((SELECT auth.uid()) = id);
