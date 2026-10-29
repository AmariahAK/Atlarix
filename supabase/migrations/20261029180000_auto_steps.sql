-- ---------------------------------------------------------------------------
-- auto_steps: one record per paid Atlarix Auto / Zenith step (selector phase 1).
-- ---------------------------------------------------------------------------
--
-- What a step WAS and how it ended: which lane, where it started, which level
-- and provider ran it, whether the session climbed (and why), tokens, cents,
-- latency and the outcome. NEVER what it said: no prompts, paths, repo names
-- or tool arguments. The learner reads this later ("Luna failed, Terra
-- finished it" on this kind of session); account age, plan and bans are joined
-- at read time from user_id, which is also how per-account caps are applied.
--
-- WRITTEN BY THE PROXY in batches (auto-steps.ts): one insert a minute and on
-- SIGTERM, with the service role. Reporting only: nothing reads it to decide
-- what a user may do.
--
-- KEPT 180 DAYS: older rows are deleted every night.

BEGIN;

CREATE TABLE IF NOT EXISTS public.auto_steps (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at               timestamptz NOT NULL DEFAULT now(),
  user_id          uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  surface          text NOT NULL CHECK (length(surface) <= 20),
  editor           text NOT NULL DEFAULT '' CHECK (length(editor) <= 40),
  tier             text NOT NULL CHECK (tier IN ('auto', 'zenith')),
  -- sha256 of the session key, 16 hex: groups a session's steps, joins nothing else.
  session_hash     text NOT NULL CHECK (session_hash ~ '^[0-9a-f]{16}$'),
  lane             text NOT NULL CHECK (length(lane) <= 20),
  start_level      text NOT NULL CHECK (length(start_level) <= 20),
  level            text NOT NULL CHECK (length(level) <= 20),
  session_provider text CHECK (length(session_provider) <= 40),
  signal           text CHECK (signal IN ('retry', 'loop', 'tool_error')),
  elevated_from    text CHECK (length(elevated_from) <= 80),
  elevated_to      text CHECK (length(elevated_to) <= 80),
  elevated_reason  text CHECK (elevated_reason IN ('retry', 'loop', 'tool_error', 'escalate')),
  top_failed       boolean NOT NULL DEFAULT false,
  effort           text NOT NULL CHECK (length(effort) <= 10),
  media            text[] NOT NULL DEFAULT '{}',
  provider         text CHECK (length(provider) <= 40),
  model            text CHECK (length(model) <= 80),
  failovers        integer NOT NULL DEFAULT 0 CHECK (failovers >= 0),
  prompt_tokens    bigint CHECK (prompt_tokens >= 0),
  cached_tokens    bigint CHECK (cached_tokens >= 0),
  output_tokens    bigint CHECK (output_tokens >= 0),
  cents            integer CHECK (cents >= 0),
  latency_ms       integer CHECK (latency_ms >= 0),
  outcome          text NOT NULL
    CHECK (outcome IN ('ok', 'aborted', 'upstream_error', 'rate_limited', 'unavailable'))
);

CREATE INDEX IF NOT EXISTS auto_steps_at_idx ON public.auto_steps (at);
CREATE INDEX IF NOT EXISTS auto_steps_user_at_idx ON public.auto_steps (user_id, at);
CREATE INDEX IF NOT EXISTS auto_steps_session_idx ON public.auto_steps (session_hash, at);

COMMENT ON TABLE public.auto_steps IS
  'One content-free record per paid Atlarix Auto / Zenith step. Written by the proxy in batches; reporting only; kept 180 days.';

ALTER TABLE public.auto_steps ENABLE ROW LEVEL SECURITY;
-- No policies: no client role reads or writes it. The service role bypasses RLS.
REVOKE ALL ON public.auto_steps FROM PUBLIC, anon, authenticated;

select cron.schedule(
  'auto-steps-retention',
  '17 3 * * *',
  $job$ delete from public.auto_steps where at < now() - interval '180 days' $job$
);

COMMIT;
