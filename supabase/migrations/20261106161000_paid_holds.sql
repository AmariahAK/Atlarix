-- Paid holds for the proxy's Lambda failover (audit 2026-11-06, item 2a).
--
-- Each Lambda container (up to 10) keeps its own in-memory balance cache, so
-- parallel paid streams spread over containers could each hold the full balance.
-- On Lambda a paid turn also takes its hold HERE: the wallet row is locked, the
-- account's expired holds are swept, and the hold is refused when what the
-- account can spend, less every live hold, does not cover it. The proxy releases
-- the hold when the turn settles or fails; expires_at bounds a hold whose release
-- never ran. Railway does not use this (one process, one cache).
--
-- No client reaches the table: RLS on with no policy, no grants to anon or
-- authenticated. The two RPCs are service_role only and check it in the body,
-- like every *_service function. Must be applied BEFORE the proxy code that calls
-- them is live: on Lambda a hold that errors refuses the paid turn.
BEGIN;

CREATE TABLE IF NOT EXISTS public.paid_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cents bigint NOT NULL CHECK (cents > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS paid_holds_user_expires_idx ON public.paid_holds (user_id, expires_at);
ALTER TABLE public.paid_holds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.paid_holds FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.take_paid_hold_service(
  p_user_id uuid, p_cents bigint, p_ttl_seconds integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  spendable bigint;
  held bigint;
  hid uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  IF p_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'missing_user'); END IF;
  IF p_cents IS NULL OR p_cents <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount'); END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 OR p_ttl_seconds > 3600 THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_ttl'); END IF;
  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM credit_wallet WHERE user_id = p_user_id FOR UPDATE;
  DELETE FROM paid_holds WHERE user_id = p_user_id AND expires_at <= now();
  SELECT COALESCE(SUM(cents), 0) INTO held FROM paid_holds WHERE user_id = p_user_id;
  spendable := wallet_spendable(p_user_id);
  IF spendable - held - p_cents < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'insufficient_funds', 'balance_cents', spendable, 'held_cents', held);
  END IF;
  INSERT INTO paid_holds (user_id, cents, expires_at)
  VALUES (p_user_id, p_cents, now() + make_interval(secs => p_ttl_seconds))
  RETURNING id INTO hid;
  RETURN jsonb_build_object('ok', true, 'hold_id', hid);
END;
$$;
REVOKE ALL ON FUNCTION public.take_paid_hold_service(uuid, bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.take_paid_hold_service(uuid, bigint, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.release_paid_hold_service(p_hold_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  IF p_hold_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'missing_hold'); END IF;
  DELETE FROM paid_holds WHERE id = p_hold_id;
  RETURN jsonb_build_object('ok', true, 'released', FOUND);
END;
$$;
REVOKE ALL ON FUNCTION public.release_paid_hold_service(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_paid_hold_service(uuid) TO service_role;

COMMIT;
