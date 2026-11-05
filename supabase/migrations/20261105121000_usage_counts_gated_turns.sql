-- 2026-11-05 audit: a turn refused at a gate (no credit, the free limit, consent,
-- a rule) was counted as a SUCCESS in client_usage_daily (turns +1, failed 0, no
-- kind), so a no-credit account looked like a working one. A gate is not an
-- error (the owner's rule: gates never page us), so it gets its own count and
-- kind beside failed_turns. Older clients send no gated_turns: counted as 0.
BEGIN;

ALTER TABLE public.client_usage_daily
  ADD COLUMN IF NOT EXISTS gated_turns bigint NOT NULL DEFAULT 0 CHECK (gated_turns >= 0),
  ADD COLUMN IF NOT EXISTS last_gate_kind text CHECK (last_gate_kind ~ '^[a-z_0-9]{1,32}$');

CREATE OR REPLACE FUNCTION public.record_client_usage(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  uid uuid := auth.uid();
  r jsonb;
  d date;
  t_first timestamptz;
  t_last timestamptz;
  n_turns bigint;
  n_failed bigint;
  n_gated bigint;
  written integer := 0;
  skipped integer := 0;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF public.account_is_banned(uid) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_banned');
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 50 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_arguments');
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    BEGIN
      d := (r->>'day')::date;
      n_turns := COALESCE((r->>'turns')::bigint, 0);
      n_failed := COALESCE((r->>'failed_turns')::bigint, 0);
      n_gated := COALESCE((r->>'gated_turns')::bigint, 0);
      IF d IS NULL OR d < (now() AT TIME ZONE 'UTC')::date - 1 OR d > (now() AT TIME ZONE 'UTC')::date + 1
         OR n_turns < 1 OR n_turns > 10000 OR n_failed < 0 OR n_failed > n_turns
         OR n_gated < 0 OR n_gated + n_failed > n_turns
         OR COALESCE((r->>'tokens_in')::bigint, 0) NOT BETWEEN 0 AND 1000000000
         OR COALESCE((r->>'tokens_out')::bigint, 0) NOT BETWEEN 0 AND 1000000000 THEN
        skipped := skipped + 1;
        CONTINUE;
      END IF;
      t_last := LEAST(COALESCE((r->>'last_seen')::timestamptz, now()), now());
      t_first := GREATEST(LEAST(COALESCE((r->>'first_seen')::timestamptz, t_last), t_last), now() - interval '3 days');

      INSERT INTO public.client_usage_daily AS u
        (user_id, day, surface, editor, billing, provider_type, model, turns, failed_turns,
         last_error_kind, gated_turns, last_gate_kind, tokens_in, tokens_out, first_seen, last_seen)
      VALUES (
        uid, d,
        r->>'surface',
        COALESCE(r->>'editor', ''),
        r->>'billing',
        r->>'provider_type',
        r->>'model',
        n_turns, n_failed,
        NULLIF(r->>'last_error_kind', ''),
        n_gated,
        NULLIF(r->>'last_gate_kind', ''),
        COALESCE((r->>'tokens_in')::bigint, 0),
        COALESCE((r->>'tokens_out')::bigint, 0),
        t_first, t_last
      )
      ON CONFLICT (user_id, day, surface, editor, billing, provider_type, model) DO UPDATE SET
        turns           = u.turns + EXCLUDED.turns,
        failed_turns    = u.failed_turns + EXCLUDED.failed_turns,
        last_error_kind = CASE WHEN EXCLUDED.last_error_kind IS NOT NULL AND EXCLUDED.last_seen >= u.last_seen
                               THEN EXCLUDED.last_error_kind ELSE u.last_error_kind END,
        gated_turns     = u.gated_turns + EXCLUDED.gated_turns,
        last_gate_kind  = CASE WHEN EXCLUDED.last_gate_kind IS NOT NULL AND EXCLUDED.last_seen >= u.last_seen
                               THEN EXCLUDED.last_gate_kind ELSE u.last_gate_kind END,
        tokens_in       = u.tokens_in + EXCLUDED.tokens_in,
        tokens_out      = u.tokens_out + EXCLUDED.tokens_out,
        first_seen      = LEAST(u.first_seen, EXCLUDED.first_seen),
        last_seen       = GREATEST(u.last_seen, EXCLUDED.last_seen);

      UPDATE public.users SET
        first_surface = COALESCE(first_surface, r->>'surface'),
        first_seen_at = COALESCE(first_seen_at, t_first),
        last_surface  = CASE WHEN last_seen_at IS NULL OR t_last >= last_seen_at
                             THEN r->>'surface' ELSE last_surface END,
        last_seen_at  = GREATEST(COALESCE(last_seen_at, '-infinity'), t_last)
      WHERE id = uid;

      written := written + 1;
    EXCEPTION WHEN check_violation OR invalid_text_representation OR not_null_violation
                   OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN
      skipped := skipped + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'written', written, 'skipped', skipped);
END;
$$;

-- CREATE OR REPLACE resets nothing on an existing function's ACL, but say it
-- outright (the 2026-07 remediation): authenticated only.
REVOKE EXECUTE ON FUNCTION public.record_client_usage(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_client_usage(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_client_usage(jsonb) TO authenticated;

COMMIT;

-- VERIFY after applying:
--   SELECT p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'record_client_usage';   -- authenticated only
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'client_usage_daily' AND column_name IN ('gated_turns', 'last_gate_kind');
