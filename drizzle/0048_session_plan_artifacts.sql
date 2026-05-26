ALTER TABLE `session_messages` ADD COLUMN `kind` text NOT NULL DEFAULT 'message';
ALTER TABLE `session_messages` ADD COLUMN `plan_status` text;
