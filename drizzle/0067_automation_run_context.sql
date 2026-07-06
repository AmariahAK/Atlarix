-- Notify-only automations: persist the fired trigger's context on the run so
-- the feed's "Send to chat" can present the event to the model on demand.
ALTER TABLE `automation_runs` ADD COLUMN `trigger_context` text;
