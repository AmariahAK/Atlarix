# Scripts

This directory contains utility scripts for the project.

## send-atlarix-auto-email.mjs

Outreach (2026-09-23): Atlarix Auto — free models, no API key, no credit. Emails confirmed Supabase users through Resend. Reads [`Atlarix/.env`](../.env) (`SUPABASE_SERVICE_ROLE_KEY` or `NEXT_PUBLIC_SUPABASE_SECRET_KEY`, `RESEND_API_KEY`, optional `EMAIL_SOURCE` / `OUTREACH_FROM`).

```bash
cd Atlarix
npm run email:atlarix-auto:dry-run
npm run email:atlarix-auto -- --only you@example.com
npm run email:atlarix-auto
```

- **Never emails anyone in `scripts/.email-suppression.json`** (gitignored — personal data): people who replied "stop" or asked for account deletion. It beats `--only`. Every future campaign must read it.
- From `Amariah <amariah@atlarix.dev>`, replies to `amariah@atlarix.dev`; 5 s between sends.
- Log: `scripts/.outreach-atlarix-auto-2026-09-23.log.json` (gitignored) — reruns skip anyone already sent.

## run-packaged-self-test.mjs

Launches the packaged binary with `--self-test` and propagates its exit code — a
headless smoke that exercises the real ship paths (node-pty spawn, proxy-worker
resolution from the asar, ripgrep) to catch packaged-only breakages the
static `verify-ci-package-out.mjs` can't. Runs after each CI package job and
locally:

```bash
npm run package && npm run self-test:packaged
```

## extract-codebase.ts

A script that extracts code files from a directory, respecting `.gitignore` rules, and outputs them in a format suitable for LLM consumption.

### Usage

```bash
# Make the script executable first
chmod +x scripts/extract-codebase.ts

# Run with default options (current directory, output to codebase-extract.md)
./scripts/extract-codebase.ts

# Specify a source directory and output file
./scripts/extract-codebase.ts ./src ./output.md
```

### Features

- Walks through the specified directory recursively
- Respects all `.gitignore` rules
- Extracts files with extensions: .ts, .tsx, .js, .jsx, .css
- Formats output with markdown code blocks, including file paths
- Writes all extracted code to a single markdown file

## verify-release-assets.js

A script that verifies all expected binary assets are present in the GitHub release for the current version in `package.json`.

### Usage

```bash
# Set GITHUB_TOKEN environment variable
export GITHUB_TOKEN=your_github_token

# Run the verification script
npm run verify-release

# Or run directly
node scripts/verify-release-assets.js
```

### Expected Assets

The script verifies the presence of these 7 assets for each release:

1. `atlarix-{version}-1.x86_64.rpm` (Linux RPM)
2. `atlarix-{version}-full.nupkg` (Windows NuGet package)
3. `atlarix-{version}.Setup.exe` (Windows installer)
4. `atlarix-darwin-arm64-{version}.zip` (macOS Apple Silicon)
5. `atlarix-darwin-x64-{version}.zip` (macOS Intel)
6. `atlarix_{version}_amd64.deb` (Linux DEB)
7. `RELEASES` (Windows update manifest)

### Features

- Reads version from `package.json` automatically
- Fetches release information from GitHub API
- Lists all expected vs actual assets
- Fails with clear error messages if assets are missing
- Shows warnings for unexpected assets
- Provides detailed release summary on success
