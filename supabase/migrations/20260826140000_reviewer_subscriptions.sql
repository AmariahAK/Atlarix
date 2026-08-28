-- Atlarix Reviewer entitlement — its own table, NOT a value in the tier enum.
--
-- WHY NOT `plan`/`effective_tier`. Two reasons, and the second is the real one:
--
-- 1. The enum is closed and widely pinned. `users_plan_check` and
--    `users_effective_tier_check` (20260714130000_pricing_reframe_teardown.sql)
--    constrain both columns to ('free','pro'), and the same two values are typed
--    in at least five places — SubscriptionManager.ts's `UserPlan`, the renderer
--    stub, `UserPlanDb` in supabase-client.ts, the zod enum in schemas.ts, and a
--    test that asserts the selected column set. Adding a value means touching all
--    of them plus a DB constraint.
--
-- 2. It is not a rung on that ladder. Reviewer is a SEPARATE PRODUCT: someone can
--    hold it without Pro, hold Pro without it, or hold both. A tier column can
--    only express one position on one axis, so encoding a second product in it
--    would force a fake ordering and make "Pro" ambiguous. The spec's own rule
--    (§10, "Do NOT force app + bot together") is the same point from the product
--    side — the bot must work standalone.
--
-- So the tier enum is untouched, and nothing in the desktop app needs to change.

CREATE TABLE IF NOT EXISTS public.reviewer_subscriptions (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  -- LemonSqueezy's subscription id. Also how a webhook that carries no
  -- custom_data (renewals, cancellations) finds the row.
  lemon_subscription_id text,
  lemon_variant_id text,
  -- LemonSqueezy's own vocabulary, kept verbatim rather than mapped: 'active',
  -- 'on_trial', 'past_due', 'cancelled', 'expired', 'paused', 'unpaid'.
  -- Mapping it here would mean guessing at states LS may add.
  status text,
  -- Access runs to the end of the paid period even after cancellation, which is
  -- why cancellation does not delete the row.
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reviewer_subscriptions_lemon_sub
  ON public.reviewer_subscriptions (lemon_subscription_id);

COMMENT ON TABLE public.reviewer_subscriptions IS
  'Atlarix Reviewer entitlement, independent of users.plan. A row with an active status and an unexpired period is what authorises a review.';

ALTER TABLE public.reviewer_subscriptions ENABLE ROW LEVEL SECURITY;

-- Read your own; the /account page needs it. Writes are service-role only —
-- an entitlement a client can write is not an entitlement.
DROP POLICY IF EXISTS "reviewer_subscriptions_select_own" ON public.reviewer_subscriptions;
CREATE POLICY "reviewer_subscriptions_select_own" ON public.reviewer_subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- EXPLICIT GRANTS. A fresh table lands with service_role=Dxtm — TRUNCATE,
-- REFERENCES, TRIGGER, MAINTAIN and no SELECT/INSERT/UPDATE/DELETE for anyone,
-- which makes the policy above UNREACHABLE rather than merely wrong: a policy
-- narrows rows a role may ALREADY read. Measured on this project's own reviewer
-- tables in 20260825120000; do not assume defaults.
REVOKE INSERT, UPDATE, DELETE ON public.reviewer_subscriptions FROM authenticated, anon;
GRANT SELECT ON public.reviewer_subscriptions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.reviewer_subscriptions TO service_role;

-- ---------------------------------------------------------------------------
-- review_history gains a 'not_subscribed' outcome.
-- ---------------------------------------------------------------------------
-- Without this the worker's new entitlement refusal cannot be recorded at all:
-- the CHECK from 20260825120000 allows only ('review','out_of_credits','failed'),
-- so writing the row would raise 23514 on a path whose whole job is to decline
-- quietly. It is also the outcome most worth SEEING — somebody installed the App
-- and pushed code without ever subscribing, which is a conversion signal, not an
-- error.
ALTER TABLE public.review_history
  DROP CONSTRAINT IF EXISTS review_history_kind_check;
ALTER TABLE public.review_history
  ADD CONSTRAINT review_history_kind_check
  CHECK (kind IN ('review', 'out_of_credits', 'failed', 'not_subscribed'));

-- ---------------------------------------------------------------------------
-- upsert_reviewer_subscription_service — the webhook's writer.
-- ---------------------------------------------------------------------------
-- Keyed on user_id when the webhook carries trusted custom_data, and on
-- lemon_subscription_id when it does not (renewals and cancellations arrive with
-- neither a session nor custom_data). Refusing to resolve by email is deliberate
-- and matches handle-lemon-webhook: `user_email` is attacker-controlled and is
-- never the mutation key.
CREATE OR REPLACE FUNCTION public.upsert_reviewer_subscription_service(
  p_user_id uuid,
  p_lemon_subscription_id text,
  p_lemon_variant_id text,
  p_status text,
  p_current_period_end timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_lemon_subscription_id IS NULL OR length(trim(p_lemon_subscription_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_subscription_id');
  END IF;

  target := p_user_id;
  IF target IS NULL THEN
    SELECT user_id INTO target FROM reviewer_subscriptions
    WHERE lemon_subscription_id = p_lemon_subscription_id;
  END IF;

  -- A renewal for a subscription we never recorded cannot be provisioned: there
  -- is no trustworthy way to say whose it is. Report it rather than guessing —
  -- silently succeeding here would leave a paying customer unentitled with
  -- nothing in the logs.
  IF target IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unresolved_account');
  END IF;

  INSERT INTO reviewer_subscriptions (
    user_id, lemon_subscription_id, lemon_variant_id, status, current_period_end
  )
  VALUES (target, p_lemon_subscription_id, p_lemon_variant_id, p_status, p_current_period_end)
  ON CONFLICT (user_id) DO UPDATE
  SET lemon_subscription_id = EXCLUDED.lemon_subscription_id,
      lemon_variant_id      = COALESCE(EXCLUDED.lemon_variant_id, reviewer_subscriptions.lemon_variant_id),
      status                = EXCLUDED.status,
      current_period_end    = COALESCE(EXCLUDED.current_period_end, reviewer_subscriptions.current_period_end),
      updated_at            = now();

  RETURN jsonb_build_object('ok', true, 'user_id', target, 'status', p_status);
END;
$$;

-- ---------------------------------------------------------------------------
-- reviewer_entitlement_service — the worker's pre-flight.
-- ---------------------------------------------------------------------------
-- One call answering "may this account have a review". It carries the BAN GATE
-- for the same reason get_credit_balance does: the stop has to ride a read the
-- caller already makes, or it is a second thing to forget. This is now the
-- reviewer's first check, and the wallet read stays its second.
CREATE OR REPLACE FUNCTION public.reviewer_entitlement_service(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  row_status text;
  row_end timestamptz;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE id = p_user_id AND banned_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;

  SELECT status, current_period_end INTO row_status, row_end
  FROM reviewer_subscriptions WHERE user_id = p_user_id;

  IF row_status IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'entitled', false, 'reason', 'no_subscription');
  END IF;

  -- 'cancelled' still entitles until the period ends — the customer paid for it.
  -- A null period end on an otherwise-active status is treated as entitled
  -- rather than expired: failing closed on a missing DATE would deny service to
  -- a paying account over a field LemonSqueezy simply did not send.
  IF row_status IN ('active', 'on_trial', 'cancelled')
     AND (row_end IS NULL OR row_end > now()) THEN
    RETURN jsonb_build_object('ok', true, 'entitled', true, 'status', row_status);
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'entitled', false, 'reason', 'inactive', 'status', row_status
  );
END;
$$;

-- CREATE OR REPLACE FUNCTION re-adds the default PUBLIC EXECUTE grant on every
-- run, and revoking from authenticated/anon does not remove it. After the final
-- definition, never before.
REVOKE EXECUTE ON FUNCTION public.upsert_reviewer_subscription_service(uuid, text, text, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_reviewer_subscription_service(uuid, text, text, text, timestamptz) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.upsert_reviewer_subscription_service(uuid, text, text, text, timestamptz) TO service_role;

REVOKE EXECUTE ON FUNCTION public.reviewer_entitlement_service(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reviewer_entitlement_service(uuid) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.reviewer_entitlement_service(uuid) TO service_role;
