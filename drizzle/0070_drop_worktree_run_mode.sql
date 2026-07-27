-- v14.21.0 removed the "worktree-write" automation run mode along with the
-- sub-agent git worktree it depended on. Any automation still set to it would
-- otherwise load with a run_mode the zod schema no longer accepts, so downgrade
-- it to the closest surviving behaviour: an ask-mode (read-only) run.
--
-- The automation_runs.proposal_diff / proposal_files / proposal_applied_at
-- columns are deliberately NOT dropped — nothing reads them any more, and a
-- failed DROP COLUMN on a user's database is a boot failure.
UPDATE automations SET run_mode = 'read-only' WHERE run_mode = 'worktree-write';
