-- ---------------------------------------------------------------------------
-- Slack: one live status card per job, progress, the people involved, files,
-- relics, a task channel and a List (2026-10-06)
-- ---------------------------------------------------------------------------
--
-- The reviewer used to post a NEW thread message per event, so a job's story
-- was scattered and its Approve/Close buttons stayed live after use. It now
-- posts one status card and edits it (chat.update), which needs the card's ts
-- and channel. The rest is what the card shows and what the run needs:
--
--   slack_status_ts     the card's message ts
--   slack_task_channel  a channel made for this task (when people were tagged)
--   slack_requester     the Slack user who asked (invited to the task channel)
--   slack_people        the Slack user ids tagged in the request
--   slack_files         files attached to the request: [{id,name,mimetype,size}]
--   progress            the runner's latest steps: [{text,status}] + current
--   relics              pages the run made: [{title,url}]
--   slack_list          the task's Slack List: {list_id, columns, items}
--
-- slack_installs.scopes: what each workspace actually granted, so a feature
-- whose scope a workspace has not granted says "reinstall" instead of failing.
--
-- All nullable and service-role only (cloud_jobs and slack_installs already
-- are): the reviewer writes them, nobody else reads them.

BEGIN;

ALTER TABLE public.cloud_jobs
  ADD COLUMN IF NOT EXISTS slack_status_ts text,
  ADD COLUMN IF NOT EXISTS slack_task_channel text,
  ADD COLUMN IF NOT EXISTS slack_requester text,
  ADD COLUMN IF NOT EXISTS slack_people text[],
  ADD COLUMN IF NOT EXISTS slack_files jsonb,
  ADD COLUMN IF NOT EXISTS progress jsonb,
  ADD COLUMN IF NOT EXISTS relics jsonb,
  ADD COLUMN IF NOT EXISTS slack_list jsonb;

ALTER TABLE public.slack_installs
  ADD COLUMN IF NOT EXISTS scopes text;

COMMIT;
