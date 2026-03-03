# Release pipeline secrets

Before tagging a release, ensure these repository secrets are set in **GitHub → Settings → Secrets and variables → Actions** for this repo:

- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_CERT_BASE64`
- `APPLE_CERT_PASSWORD`
- `APPLE_ID`
- `APPLE_IDENTITY`
- `APPLE_TEAM_ID`
- `RELEASES_TOKEN`
- `VIRUSTOTAL_API_KEY`
- `SENTRY_DSN` (optional; for error reporting in builds)
- `POSTHOG_API_KEY` (optional; only if CI uses it)
