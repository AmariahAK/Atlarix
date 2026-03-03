# Release pipeline secrets

Before tagging a release, ensure these repository secrets are set in **GitHub → Settings → Secrets and variables → Actions** for this repo:

- `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password (used as `APPLE_PASSWORD` in the workflow)
- `APPLE_CERT_BASE64` — base64-encoded `.p12` certificate
- `APPLE_CERT_PASSWORD` — password for the `.p12`
- `APPLE_ID` — Apple ID email
- `APPLE_IDENTITY` — **exact** identity string from `security find-identity -v` (e.g. `Developer ID Application: Your Name (TEAMID)`)
- `APPLE_TEAM_ID` — 10-character team ID
- `RELEASES_TOKEN`
- `VIRUSTOTAL_API_KEY`
- `SENTRY_DSN` (optional; for error reporting in builds)
- `POSTHOG_API_KEY` (optional; only if CI uses it)

### macOS build: "The operation was canceled" during Finalizing package

This error on GitHub Actions (often during the arm64 or x64 macOS build) usually means the **runner canceled the task** (resource exhaustion, runner image bug, or timeout). It is not a bug in your app or Forge config.

- **Re-run the job** — it often succeeds on retry.
- The workflow uses `timeout-minutes: 60` and `fail-fast: false` so one arch can fail without canceling the other.
- If it keeps failing for one arch, try re-running from the Actions tab or trigger the workflow again.
