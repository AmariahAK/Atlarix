-- ---------------------------------------------------------------------------
-- The account page's Slack row: which workspaces this account is linked in.
-- ---------------------------------------------------------------------------
--
-- `slack_links` is readable by its owner, but the workspace's NAME lives in
-- `slack_installs`, which also holds the (encrypted) bot token and stays
-- service-role only. This returns the owner's links with the name and nothing
-- else from that table.

BEGIN;

CREATE OR REPLACE FUNCTION public.my_slack_workspaces()
RETURNS TABLE (team_id text, team_name text, default_repo text, linked_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT l.team_id, i.team_name, l.default_repo, l.created_at
  FROM public.slack_links l
  LEFT JOIN public.slack_installs i ON i.team_id = l.team_id
  WHERE l.user_id = auth.uid()
  ORDER BY l.created_at;
$$;

-- CREATE OR REPLACE re-grants EXECUTE to PUBLIC; take it back every time.
REVOKE ALL ON FUNCTION public.my_slack_workspaces() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_slack_workspaces() TO authenticated;

COMMIT;
