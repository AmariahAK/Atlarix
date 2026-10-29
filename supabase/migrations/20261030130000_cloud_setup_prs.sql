-- ---------------------------------------------------------------------------
-- cloud_setup_prs: the "Add the Atlarix cloud agent" pull requests, one row per
-- installation and repository, so they can be capped.
-- ---------------------------------------------------------------------------
--
-- WHY. On 2026-10-08 one installation on "all repositories" got forty setup
-- pull requests in eight minutes, every one on a fork, through the website's
-- "Add workflow" button, which had no limit. Nothing is opened on install;
-- a setup PR is opened only when the person picks the repository on the site
-- or sends a first task to it from Slack, and the service refuses forks,
-- archived repositories, more than a few open per installation, and more than
-- a few per day. This table is what those counts read.
--
-- Written only by the atlarix-reviewer service (service role). Nobody else
-- reads it: the website learns about a setup PR from the service's answer.

BEGIN;

CREATE TABLE IF NOT EXISTS public.cloud_setup_prs (
  installation_id bigint NOT NULL,
  repo text NOT NULL,                          -- "owner/name"
  user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  pr_number integer NOT NULL,
  pr_url text NOT NULL,
  branch text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  PRIMARY KEY (installation_id, repo)
);
-- The caps read by installation: open ones, and ones opened in the last day.
CREATE INDEX IF NOT EXISTS idx_cloud_setup_prs_install_open
  ON public.cloud_setup_prs (installation_id, opened_at DESC) WHERE closed_at IS NULL;

COMMENT ON TABLE public.cloud_setup_prs IS
  'Setup pull requests the cloud agent opened, per installation and repository; service role only.';

ALTER TABLE public.cloud_setup_prs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cloud_setup_prs FROM PUBLIC;
REVOKE ALL ON public.cloud_setup_prs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cloud_setup_prs TO service_role;
REVOKE TRUNCATE, MAINTAIN ON public.cloud_setup_prs FROM service_role;

COMMIT;
