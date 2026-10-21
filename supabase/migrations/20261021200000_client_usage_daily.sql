-- ---------------------------------------------------------------------------
-- Turns per signed-in user, per day, per surface and model: from the client.
-- ---------------------------------------------------------------------------
--
-- usage_daily is written by the proxy, so it only knows Core and Auto. A turn
-- on the user's own key, a provider they added or a local model never reaches
-- us, and PostHog only hears from people who opted in. The owner's question is
-- "who is active and when" (2026-10-21), for every signed-in account whatever
-- the analytics answer, like the proxy's usage records (the privacy page says
-- both are kept with the account and not covered by the analytics choice).
--
-- WHAT A ROW IS: counts, never content. Which Atlarix (surface, editor), who
-- paid (billing), the provider TYPE (a built-in id, or custom:<api format>,
-- never a provider the user named or its address) and the model id, with
-- turns, failed turns, the last failure's fixed word, tokens, and when the
-- day's first and last turn were.
--
-- WRITTEN IN BATCHES by the client: in memory per process, one call 15 minutes
-- after the first turn since the last call, and one at quit. Never per
-- message; an idle client sends nothing. Additive, so two processes on one
-- profile (the app and a CLI) each send their own turns.
--
-- REPORTING ONLY: nothing reads this to decide what a user may do.
--
-- `editor` is '' rather than NULL so it can sit in the primary key.

BEGIN;

CREATE TABLE IF NOT EXISTS public.client_usage_daily (
  user_id         uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  day             date        NOT NULL,
  surface         text        NOT NULL CHECK (surface IN ('app', 'cli', 'acp', 'vscode')),
  editor          text        NOT NULL DEFAULT '' CHECK (length(editor) <= 40),
  billing         text        NOT NULL
    CHECK (billing IN ('auto_free', 'auto_paid', 'auto', 'core', 'byok', 'local')),
  provider_type   text        NOT NULL CHECK (provider_type ~ '^[a-z0-9][a-z0-9._:-]{0,63}$'),
  model           text        NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
  turns           bigint      NOT NULL DEFAULT 0 CHECK (turns >= 0),
  failed_turns    bigint      NOT NULL DEFAULT 0 CHECK (failed_turns >= 0),
  last_error_kind text        CHECK (last_error_kind ~ '^[a-z_0-9]{1,32}$'),
  tokens_in       bigint      NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out      bigint      NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  first_seen      timestamptz NOT NULL,
  last_seen       timestamptz NOT NULL,
  PRIMARY KEY (user_id, day, surface, editor, billing, provider_type, model)
);

CREATE INDEX IF NOT EXISTS client_usage_daily_day_idx ON public.client_usage_daily (day);
CREATE INDEX IF NOT EXISTS client_usage_daily_user_seen_idx ON public.client_usage_daily (user_id, last_seen DESC);

COMMENT ON TABLE public.client_usage_daily IS
  'Agent turns per signed-in user, UTC day, surface, editor, billing, provider type and model. Written by the client through record_client_usage; counts only; reporting only.';

ALTER TABLE public.client_usage_daily ENABLE ROW LEVEL SECURITY;
-- No policies: no client role reads or writes the table itself. The only way in
-- is record_client_usage, as the caller's own account.
REVOKE ALL ON public.client_usage_daily FROM PUBLIC, anon, authenticated;
-- House rule (20261021090000): no server key may TRUNCATE or MAINTAIN.
REVOKE TRUNCATE, MAINTAIN ON public.client_usage_daily FROM service_role;

-- ---------------------------------------------------------------------------
-- record_client_usage: one call per flush, for the caller's own account.
-- ---------------------------------------------------------------------------
-- p_rows: [{day, surface, editor, billing, provider_type, model, turns,
--           failed_turns, last_error_kind, tokens_in, tokens_out, first_seen,
--           last_seen}]. The account is auth.uid(), never a field. A row that
-- fails a check is skipped and counted, never allowed to sink the batch.
CREATE OR REPLACE FUNCTION public.record_client_usage(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := auth.uid();
  r jsonb;
  d date;
  t_first timestamptz;
  t_last timestamptz;
  n_turns bigint;
  n_failed bigint;
  written integer := 0;
  skipped integer := 0;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 50 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_arguments');
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    BEGIN
      d := (r->>'day')::date;
      n_turns := COALESCE((r->>'turns')::bigint, 0);
      n_failed := COALESCE((r->>'failed_turns')::bigint, 0);
      -- Today or yesterday/tomorrow (a flush just past midnight, a clock off by
      -- hours), counts a client could really have, failures within the turns.
      IF d IS NULL OR d < (now() AT TIME ZONE 'UTC')::date - 1 OR d > (now() AT TIME ZONE 'UTC')::date + 1
         OR n_turns < 1 OR n_turns > 10000 OR n_failed < 0 OR n_failed > n_turns
         OR COALESCE((r->>'tokens_in')::bigint, 0) NOT BETWEEN 0 AND 1000000000
         OR COALESCE((r->>'tokens_out')::bigint, 0) NOT BETWEEN 0 AND 1000000000 THEN
        skipped := skipped + 1;
        CONTINUE;
      END IF;
      -- Never later than now, never earlier than the row's own window.
      t_last := LEAST(COALESCE((r->>'last_seen')::timestamptz, now()), now());
      t_first := GREATEST(LEAST(COALESCE((r->>'first_seen')::timestamptz, t_last), t_last), now() - interval '3 days');

      INSERT INTO public.client_usage_daily AS u
        (user_id, day, surface, editor, billing, provider_type, model, turns, failed_turns,
         last_error_kind, tokens_in, tokens_out, first_seen, last_seen)
      VALUES (
        uid, d,
        r->>'surface',
        COALESCE(r->>'editor', ''),
        r->>'billing',
        r->>'provider_type',
        r->>'model',
        n_turns, n_failed,
        NULLIF(r->>'last_error_kind', ''),
        COALESCE((r->>'tokens_in')::bigint, 0),
        COALESCE((r->>'tokens_out')::bigint, 0),
        t_first, t_last
      )
      ON CONFLICT (user_id, day, surface, editor, billing, provider_type, model) DO UPDATE SET
        turns           = u.turns + EXCLUDED.turns,
        failed_turns    = u.failed_turns + EXCLUDED.failed_turns,
        last_error_kind = CASE WHEN EXCLUDED.last_error_kind IS NOT NULL AND EXCLUDED.last_seen >= u.last_seen
                               THEN EXCLUDED.last_error_kind ELSE u.last_error_kind END,
        tokens_in       = u.tokens_in + EXCLUDED.tokens_in,
        tokens_out      = u.tokens_out + EXCLUDED.tokens_out,
        first_seen      = LEAST(u.first_seen, EXCLUDED.first_seen),
        last_seen       = GREATEST(u.last_seen, EXCLUDED.last_seen);

      -- The same first/last seen the proxy keeps on the user row, so an own-key
      -- user is "seen" too.
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

REVOKE EXECUTE ON FUNCTION public.record_client_usage(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_client_usage(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_client_usage(jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- The latest provider and model each person used, per surface.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_latest_model_by_surface
WITH (security_invoker = true) AS
SELECT DISTINCT ON (c.user_id, c.surface)
       c.user_id,
       au.email,
       c.surface,
       c.editor,
       c.billing,
       c.provider_type,
       c.model,
       c.last_seen
  FROM public.client_usage_daily c
  JOIN auth.users au ON au.id = c.user_id
 WHERE au.email NOT IN ('amariah.abish@gmail.com', 'amani.kamau06@gmail.com',
                        'agent@atlarix.dev', 'mojo.alexander3@gmail.com', 'amariah@atlarix.dev')
 ORDER BY c.user_id, c.surface, c.last_seen DESC;

COMMENT ON VIEW public.v_latest_model_by_surface IS
  'Per account and surface: the provider type and model of the latest turn, and when. Internal accounts excluded. Service role only.';

REVOKE ALL ON public.v_latest_model_by_surface FROM PUBLIC, anon, authenticated;
REVOKE TRUNCATE, MAINTAIN ON public.v_latest_model_by_surface FROM service_role;

COMMIT;
