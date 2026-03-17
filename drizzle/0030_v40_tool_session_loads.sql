-- v4.0: Tool session tracking (analytics - which tools get discovered and used)
CREATE TABLE IF NOT EXISTS `tool_session_loads` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `chat_id` integer NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  `tool_name` text NOT NULL,
  `first_called_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tool_session_loads_chat_id_idx` ON `tool_session_loads` (`chat_id`);
