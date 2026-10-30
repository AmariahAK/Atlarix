-- ever_funded: any money that reached the wallet, however it got there.
-- QA 2026-10-30 (ai-47): an account whose credit came only as adjustments (comps,
-- restores) read as "never funded" and saw the newcomer line instead of
-- "balance is used up". A comp is money the person could spend.
CREATE OR REPLACE FUNCTION public.wallet_plan_facts(p_user_id uuid)
 RETURNS TABLE(plan text, renews_at timestamp with time zone, ever_funded boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    CASE WHEN COALESCE(u.effective_tier, u.plan, 'free') = 'pro' THEN 'pro' ELSE 'free' END,
    CASE WHEN COALESCE(u.effective_tier, u.plan, 'free') = 'pro' THEN u.subscription_ends_at END,
    EXISTS (SELECT 1 FROM credit_transactions t WHERE t.user_id = p_user_id AND t.delta_cents > 0)
  FROM users u WHERE u.id = p_user_id;
$function$;
REVOKE ALL ON FUNCTION public.wallet_plan_facts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_plan_facts(uuid) TO service_role;
