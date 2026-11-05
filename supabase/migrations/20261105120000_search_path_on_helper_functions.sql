-- Supabase advisor (2026-11-05 audit): four helpers had a mutable search_path,
-- so an object named like one they call, created earlier on the path, could be
-- picked up instead. Pinned with ALTER, not re-created: CREATE OR REPLACE would
-- re-grant EXECUTE to PUBLIC (see the 2026-07 remediation note), ALTER keeps the
-- grants and the bodies exactly as they are.
ALTER FUNCTION public.safe_tz(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.slack_installs_payer_consistency() SET search_path = public, pg_temp;
ALTER FUNCTION public.is_major_mail_domain(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.is_shared_mail_host(text) SET search_path = public, pg_temp;
