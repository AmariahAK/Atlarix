-- ---------------------------------------------------------------------------
-- Slack v1: follow-up turns, read-only "ask" runs, reviews from Slack (2026-10-22)
-- ---------------------------------------------------------------------------
--
-- A turn, not a question: the agent never waits mid-run. A reply in a job's
-- Slack thread is the NEXT turn of the same task, as a new cloud_jobs row
-- chained to the one before it.
--
--   parent_job_id  the turn this one continues
--   root_job_id    the first turn of the chain (NULL on the first turn itself),
--                  so "the newest turn of this thread" is one indexed read
--   turn           1 for a new task, parent's + 1 for a follow-up
--   mode           'build' changes code and opens a PR; 'ask' only reads and
--                  answers (the runner is never given a push token for it)
--   queued_at      when the job was last put in the queue. A follow-up sent
--                  while the previous turn still runs waits ('waiting') and is
--                  queued when that turn ends, so the stale sweep must time the
--                  queue from here, not from created_at
--
-- New states:
--   waiting    a follow-up held until the previous turn of its thread ends
--   answered   an ask run's answer is in (terminal)
--   continued  a PR that a later turn of the same thread took over (terminal
--              for THIS row: only the newest turn can approve or close)
--
-- review_jobs gains where a review asked for from Slack reports back.
--
-- inbox (ai-c4): GitHub + Slack deliveries stored by the atlarix-inbox Lambda
-- after it checked their signatures, drained by the reviewer, so a reviewer
-- outage loses nothing. The Lambda writes as a dedicated INSERT-only role,
-- made outside this migration (no secrets in git).
--
-- All service-role only, as cloud_jobs and review_jobs already are.

BEGIN;

ALTER TABLE public.cloud_jobs
  ADD COLUMN IF NOT EXISTS parent_job_id uuid REFERENCES public.cloud_jobs (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS root_job_id uuid REFERENCES public.cloud_jobs (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS turn integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'build',
  ADD COLUMN IF NOT EXISTS queued_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.cloud_jobs DROP CONSTRAINT IF EXISTS cloud_jobs_mode_check;
ALTER TABLE public.cloud_jobs
  ADD CONSTRAINT cloud_jobs_mode_check CHECK (mode IN ('build', 'ask'));

ALTER TABLE public.cloud_jobs DROP CONSTRAINT IF EXISTS cloud_jobs_turn_check;
ALTER TABLE public.cloud_jobs
  ADD CONSTRAINT cloud_jobs_turn_check CHECK (turn BETWEEN 1 AND 1000);

ALTER TABLE public.cloud_jobs DROP CONSTRAINT IF EXISTS cloud_jobs_state_check;
ALTER TABLE public.cloud_jobs
  ADD CONSTRAINT cloud_jobs_state_check CHECK (state IN (
    'waiting', 'queued', 'running',
    'pr_opened', 'no_changes', 'answered', 'continued', 'merged', 'closed', 'failed'
  ));

-- Existing rows were queued when they were created.
UPDATE public.cloud_jobs SET queued_at = created_at WHERE queued_at > created_at;

-- Which job a Slack reply belongs to: the request's thread, or the thread
-- under the job's card (a DM or a task channel).
CREATE INDEX IF NOT EXISTS idx_cloud_jobs_slack_thread
  ON public.cloud_jobs (slack_team_id, slack_channel, slack_thread_ts)
  WHERE slack_thread_ts IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cloud_jobs_slack_card
  ON public.cloud_jobs (slack_team_id, slack_channel, slack_status_ts)
  WHERE slack_status_ts IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cloud_jobs_slack_task_channel
  ON public.cloud_jobs (slack_team_id, slack_task_channel)
  WHERE slack_task_channel IS NOT NULL;
-- The turns of one thread, oldest first; and the follow-up waiting on a turn.
CREATE INDEX IF NOT EXISTS idx_cloud_jobs_root
  ON public.cloud_jobs (root_job_id, created_at)
  WHERE root_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cloud_jobs_waiting
  ON public.cloud_jobs (parent_job_id)
  WHERE state = 'waiting';

ALTER TABLE public.review_jobs
  ADD COLUMN IF NOT EXISTS slack_team_id text,
  ADD COLUMN IF NOT EXISTS slack_channel text,
  ADD COLUMN IF NOT EXISTS slack_thread_ts text;

CREATE TABLE IF NOT EXISTS public.inbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('slack_event', 'slack_interaction', 'github_reviewer', 'github_agent')),
  -- GitHub: X-GitHub-Delivery. Slack: event_id, or <team>:<action_ts>:<user> for
  -- an interaction. Unique per source, so a redelivery is dropped on insert.
  delivery_key text NOT NULL,
  event text NOT NULL,
  body jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'claimed', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  error text,
  CONSTRAINT inbox_source_delivery_key UNIQUE (source, delivery_key)
);
CREATE INDEX IF NOT EXISTS inbox_open_idx ON public.inbox (received_at) WHERE state IN ('queued', 'claimed');
ALTER TABLE public.inbox ENABLE ROW LEVEL SECURITY;
-- No policies: service_role bypasses RLS; anon and authenticated get nothing.
REVOKE ALL ON public.inbox FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbox TO service_role;
REVOKE TRUNCATE, MAINTAIN ON public.inbox FROM service_role;
COMMENT ON TABLE public.inbox IS
  'GitHub + Slack deliveries stored by the atlarix-inbox Lambda (inbox_writer role, INSERT only); drained by the reviewer.';

COMMIT;

-- ROLLBACK (for the dry run; not executed):
-- BEGIN;
-- DROP TABLE IF EXISTS public.inbox;
-- ALTER TABLE public.review_jobs DROP COLUMN IF EXISTS slack_team_id, DROP COLUMN IF EXISTS slack_channel, DROP COLUMN IF EXISTS slack_thread_ts;
-- DROP INDEX IF EXISTS public.idx_cloud_jobs_slack_thread, public.idx_cloud_jobs_slack_card,
--   public.idx_cloud_jobs_slack_task_channel, public.idx_cloud_jobs_root, public.idx_cloud_jobs_waiting;
-- ALTER TABLE public.cloud_jobs DROP CONSTRAINT IF EXISTS cloud_jobs_state_check;
-- ALTER TABLE public.cloud_jobs ADD CONSTRAINT cloud_jobs_state_check CHECK (state IN
--   ('queued', 'running', 'pr_opened', 'no_changes', 'merged', 'closed', 'failed'));  -- fails while new-state rows exist
-- ALTER TABLE public.cloud_jobs DROP CONSTRAINT IF EXISTS cloud_jobs_mode_check, DROP CONSTRAINT IF EXISTS cloud_jobs_turn_check;
-- ALTER TABLE public.cloud_jobs DROP COLUMN IF EXISTS queued_at, DROP COLUMN IF EXISTS mode, DROP COLUMN IF EXISTS turn,
--   DROP COLUMN IF EXISTS root_job_id, DROP COLUMN IF EXISTS parent_job_id;
-- COMMIT;
