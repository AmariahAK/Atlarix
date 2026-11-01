-- Who first added Atlarix to a Slack workspace, as Slack knows them (the OAuth
-- callback has no Atlarix session). Set on the FIRST install only; a re-install
-- never changes it. Shown as "added by @name" when someone adds it again.
BEGIN;
ALTER TABLE public.slack_installs ADD COLUMN IF NOT EXISTS installer_slack_user_id text CHECK (length(installer_slack_user_id) <= 32);
COMMIT;
