-- Where a chat came from: the chat it was started from, and how.
--
-- A session can be started by another one (a /fork, a peer messaging a session
-- that had no row yet, an automation an agent set up) and nothing recorded it,
-- so every list of past chats was flat. `parent_session_id` is that chat (no
-- foreign key: deleting a parent never deletes its forks; a child whose parent
-- is gone lists as a root). `origin` is JSON `{via, surface, by?, automationId?}`
-- (src/shared/session-lineage.ts). `automations.session_id` is the chat whose
-- agent created the automation, so its runs list under that chat.
--
-- Additive only (nullable columns and an index): an older reader ignores them,
-- so min_reader stays where it is.
ALTER TABLE `chat_sessions` ADD `parent_session_id` text;
--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `origin` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `chat_sessions_parent_idx` ON `chat_sessions` (`parent_session_id`);
--> statement-breakpoint
ALTER TABLE `automations` ADD `session_id` text;
