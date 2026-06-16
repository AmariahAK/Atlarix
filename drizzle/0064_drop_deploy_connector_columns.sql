-- v13.6: user-facing Supabase/Neon/Vercel deploy connectors removed.
-- Drop the now-unused per-app connector columns (LOCAL sqlite only — this does
-- NOT touch Atlarix's own prod Supabase). Atlarix auth + Core token metering are
-- unaffected (they live in Supabase, not this table).
ALTER TABLE `apps` DROP COLUMN `supabase_project_id`;--> statement-breakpoint
ALTER TABLE `apps` DROP COLUMN `supabase_parent_project_id`;--> statement-breakpoint
ALTER TABLE `apps` DROP COLUMN `neon_project_id`;--> statement-breakpoint
ALTER TABLE `apps` DROP COLUMN `neon_development_branch_id`;--> statement-breakpoint
ALTER TABLE `apps` DROP COLUMN `neon_preview_branch_id`;--> statement-breakpoint
ALTER TABLE `apps` DROP COLUMN `vercel_project_id`;--> statement-breakpoint
ALTER TABLE `apps` DROP COLUMN `vercel_project_name`;--> statement-breakpoint
ALTER TABLE `apps` DROP COLUMN `vercel_team_id`;--> statement-breakpoint
ALTER TABLE `apps` DROP COLUMN `vercel_deployment_url`;--> statement-breakpoint
ALTER TABLE `versions` DROP COLUMN `neon_db_timestamp`;
