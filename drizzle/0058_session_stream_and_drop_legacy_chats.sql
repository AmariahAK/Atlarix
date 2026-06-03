-- Workspace sessions: persist stream transport id; remove legacy chats/messages tables.
DROP TABLE IF EXISTS `messages`;
--> statement-breakpoint
DROP TABLE IF EXISTS `chat_context_summaries`;
--> statement-breakpoint
DROP TABLE IF EXISTS `tool_session_loads`;
--> statement-breakpoint
DROP TABLE IF EXISTS `chats`;
--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD COLUMN `stream_chat_id` integer;
