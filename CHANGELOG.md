# Changelog

## [3.1.0] - 2026-02-21

### Added

- **Elastic Agent Builder provider**: Use Elastic Agent Builder (Kibana) as an AI provider. Configure Kibana URL, API key, and optional space in Settings > AI > Provider Settings. Models are the agents from your Kibana deployment (list agents via GET /api/agent_builder/agents). Chat uses the Kibana converse API (POST /api/agent_builder/converse). See [Elastic Agent Builder docs](https://www.elastic.co/docs/explore-analyze/ai-features/elastic-agent-builder).

### Changed

- **AWS Bedrock**: Optional region can be set in provider settings (Settings > AI > AWS Bedrock). Region is read from settings first, then `AWS_REGION` env var, then default `us-east-1`.

## [3.0.0] - (previous)

- Workspace storage and path fixes; .atlarix folder with memory.md and spec.md; create_directory resolves relative to workspace; copy-app stores absolute paths.
