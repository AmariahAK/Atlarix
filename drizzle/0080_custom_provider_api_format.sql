-- The wire format a provider the user added speaks, and how it takes the key.
--
-- A custom provider could only be OpenAI-compatible. Many endpoints serve the
-- Anthropic Messages API instead (Bedrock's /anthropic, gateways, proxies), and
-- those take the key either as `x-api-key` or as `Authorization: Bearer`.
--
-- Additive only (two nullable columns, null = OpenAI-compatible with its usual
-- Bearer key): an older reader ignores them, so min_reader stays where it is.
ALTER TABLE `language_model_providers` ADD `api_format` text;--> statement-breakpoint
ALTER TABLE `language_model_providers` ADD `auth_header` text;
