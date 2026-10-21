-- ---------------------------------------------------------------------------
-- No server key may TRUNCATE (or MAINTAIN) a public table.
-- ---------------------------------------------------------------------------
--
-- TRUNCATE is not filtered by row security, and service_role skips row
-- security anyway, so one bad statement in any server (proxy, reviewer,
-- Lambdas, edge functions) could empty users, credit_wallet, credit_grants or
-- conversations in one go. Nothing we run truncates or maintains these tables
-- (checked 2026-10-21: no code, no pg_cron job), so the grant only adds risk.
-- The newer tables already drop it (cloud_jobs, slack_*, cli_device_codes);
-- this brings the rest in line. anon and authenticated already hold neither.
--
-- Undo for one table: GRANT TRUNCATE, MAINTAIN ON public.<table> TO service_role;

REVOKE TRUNCATE, MAINTAIN ON
  public.users,
  public.credit_wallet,
  public.credit_grants,
  public.credit_transactions,
  public.conversations,
  public.conversation_messages,
  public.account_capabilities,
  public.account_mcp_calls,
  public.account_mcp_servers,
  public.account_skills,
  public.extension_notes,
  public.extension_site_grants,
  public.free_usage_daily,
  public.free_usage_user_daily,
  public.github_installs,
  public.review_history,
  public.review_jobs,
  public.usage_daily,
  public.user_bans,
  public.workforce_connected_services,
  public.v_activation,
  public.v_active_by_surface
FROM service_role;
