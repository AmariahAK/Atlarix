-- One repo, one approval (0g): file permissions shared across a repo's worktrees.
--
-- `repo_key` is the realpath of the repo's git COMMON directory (the main
-- checkout's `.git`, shared by every linked worktree). Set on file/directory/
-- folder rules saved from a git workspace; NULL on legacy per-workspace rules
-- and on `sandbox_path` rows. A rule with a repo_key matches every worktree of
-- that repo, so approving `src/cli/tui` once covers the other worktrees too.
--
-- Additive only (nullable column and an index): an older reader ignores them.
ALTER TABLE `workspace_file_permissions` ADD `repo_key` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workspace_file_permissions_repo_key_idx` ON `workspace_file_permissions` (`repo_key`);
