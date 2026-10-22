-- ---------------------------------------------------------------------------
-- "How is Atlarix doing this session?" (1 bad, 2 fine, 3 good) and /feedback.
-- ---------------------------------------------------------------------------
--
-- Asked on every surface (app, CLI, VS Code panel; /feedback in any editor),
-- of every user, analytics on or off; something is sent only when they answer
-- (owner, 2026-10-22). Kept with the account so the owner can follow up with
-- the person. A signed-out answer never comes here (the client sends it to
-- PostHog without an id).
--
-- WHAT A ROW IS: the rating or the text the person typed, and the session's
-- shape: which Atlarix (surface, editor, version), the provider type and
-- model, mode, effort, turns, how long the session ran and the OS. Never a
-- prompt, code or a key. `provider` is a built-in id or `custom:<format>`,
-- never a name the user gave a provider (the client_usage_daily rule).
--
-- REPORTING ONLY: nothing reads this to decide what a user may do.

BEGIN;

CREATE TABLE IF NOT EXISTS public.session_feedback (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  kind            text        NOT NULL CHECK (kind IN ('rating', 'text')),
  rating          smallint    CHECK (rating BETWEEN 1 AND 3),
  body            text        CHECK (length(body) BETWEEN 1 AND 2000),
  surface         text        NOT NULL CHECK (surface IN ('app', 'cli', 'acp', 'vscode')),
  editor          text        NOT NULL DEFAULT '' CHECK (length(editor) <= 40),
  app_version     text        NOT NULL CHECK (app_version ~ '^[0-9A-Za-z.+-]{1,40}$'),
  provider_type   text        CHECK (provider_type IN ('core', 'auto', 'byok', 'local')),
  provider        text        CHECK (provider ~ '^[a-z0-9][a-z0-9._:-]{0,63}$'),
  model           text        CHECK (length(model) BETWEEN 1 AND 128),
  mode            text        CHECK (mode ~ '^[a-z_]{1,20}$'),
  effort          text        CHECK (effort ~ '^[a-z_]{1,20}$'),
  turns           integer     CHECK (turns BETWEEN 0 AND 100000),
  session_minutes integer     CHECK (session_minutes BETWEEN 0 AND 100000),
  os              text        CHECK (os ~ '^[a-z0-9_]{1,20}$'),
  CHECK ((kind = 'rating' AND rating IS NOT NULL AND body IS NULL)
      OR (kind = 'text' AND body IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS session_feedback_user_created_idx ON public.session_feedback (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS session_feedback_created_idx ON public.session_feedback (created_at DESC);

COMMENT ON TABLE public.session_feedback IS
  'Session ratings (1-3) and /feedback text per signed-in user, with the session''s surface, version, provider type, model, mode, effort, turns, length and OS. Written by the client through record_session_feedback; reporting only.';

ALTER TABLE public.session_feedback ENABLE ROW LEVEL SECURITY;
-- No policies: no client role reads or writes the table itself. The only way in
-- is record_session_feedback, as the caller's own account.
REVOKE ALL ON public.session_feedback FROM PUBLIC, anon, authenticated;
-- House rule (20261021090000): no server key may TRUNCATE or MAINTAIN.
REVOKE TRUNCATE, MAINTAIN ON public.session_feedback FROM service_role;

-- ---------------------------------------------------------------------------
-- record_session_feedback: one answer, for the caller's own account.
-- ---------------------------------------------------------------------------
-- p: {kind, rating?, body?, surface, editor?, app_version, provider_type?,
--     provider?, model?, mode?, effort?, turns?, session_minutes?, os?}.
-- The account is auth.uid(), never a field. At most 10 per account per hour.
CREATE OR REPLACE FUNCTION public.record_session_feedback(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := auth.uid();
  recent integer;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_arguments');
  END IF;

  SELECT count(*) INTO recent
    FROM public.session_feedback
   WHERE user_id = uid AND created_at > now() - interval '1 hour';
  IF recent >= 10 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited');
  END IF;

  BEGIN
    INSERT INTO public.session_feedback
      (user_id, kind, rating, body, surface, editor, app_version, provider_type, provider,
       model, mode, effort, turns, session_minutes, os)
    VALUES (
      uid,
      p->>'kind',
      (p->>'rating')::smallint,
      NULLIF(btrim(p->>'body'), ''),
      p->>'surface',
      COALESCE(p->>'editor', ''),
      p->>'app_version',
      NULLIF(p->>'provider_type', ''),
      NULLIF(p->>'provider', ''),
      NULLIF(p->>'model', ''),
      NULLIF(p->>'mode', ''),
      NULLIF(p->>'effort', ''),
      (p->>'turns')::integer,
      (p->>'session_minutes')::integer,
      NULLIF(p->>'os', '')
    );
  EXCEPTION WHEN check_violation OR invalid_text_representation OR not_null_violation
                 OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_arguments');
  END;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_session_feedback(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_session_feedback(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_session_feedback(jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- For the owner: every answer with the account's email, newest first.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_session_feedback
WITH (security_invoker = true) AS
SELECT f.created_at, au.email, f.kind, f.rating, f.body, f.surface, f.editor, f.app_version,
       f.provider_type, f.provider, f.model, f.mode, f.effort, f.turns, f.session_minutes, f.os
  FROM public.session_feedback f
  JOIN auth.users au ON au.id = f.user_id
 ORDER BY f.created_at DESC;

COMMENT ON VIEW public.v_session_feedback IS
  'Session ratings and /feedback text with the account email, newest first. Service role only.';

REVOKE ALL ON public.v_session_feedback FROM PUBLIC, anon, authenticated;
REVOKE TRUNCATE, MAINTAIN ON public.v_session_feedback FROM service_role;

COMMIT;
