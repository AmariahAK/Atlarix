CREATE TABLE `counsel_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`chat_id` integer NOT NULL,
	`turn_id` text NOT NULL,
	`trigger` text NOT NULL,
	`mode` text NOT NULL,
	`question` text NOT NULL,
	`fast_response` text,
	`balanced_response` text,
	`thinking_response` text,
	`synthesis` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
