-- A co-founder's comp Pro allowance renews monthly (owner, 2026-10-17).
--
-- A paying Pro user's allowance is reset by handle-lemon-webhook when each month's
-- payment lands. A comp account has no subscription, so nothing would ever reset
-- it. This job does: on the 1st of each month it sets every allowance whose ref
-- starts with `comp:cofounder:` back to the normal Pro amount ($19), through the
-- same service RPC the webhook uses. The ref carries the month, so a re-run is a
-- duplicate and changes nothing. The owner's own `comp:owner:permanent` grant is
-- not touched.
--
-- To give someone else this: grant_monthly_credit_service(<user>, 'pro', 1900,
-- 'comp:cofounder:<YYYY-MM>') once; the job keeps it renewed. To stop: change
-- their grant's ref (or cron.unschedule('comp-pro-allowance-monthly')).

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;

select cron.schedule(
  'comp-pro-allowance-monthly',
  '5 0 1 * *',
  $job$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select set_config('request.jwt.claim.role', 'service_role', true);
  set local role service_role;
  select public.grant_monthly_credit_service(
    g.user_id, 'pro', 1900,
    'comp:cofounder:' || to_char(now() at time zone 'utc', 'YYYY-MM'))
  from public.credit_grants g
  where g.ref like 'comp:cofounder:%';
  $job$
);
