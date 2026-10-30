-- The Slack channel's NAME at the time the job was asked ("eng", or "dm"), so the
-- run token and the ledger carry a label people recognise, not a channel id.
BEGIN;
ALTER TABLE public.cloud_jobs ADD COLUMN IF NOT EXISTS slack_channel_label text CHECK (length(slack_channel_label) <= 32);
COMMIT;
