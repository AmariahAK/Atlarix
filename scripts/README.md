# Scripts

This directory contains utility scripts for the project.

## send-user-feedback-email.mjs

One-off outreach to confirmed Supabase users (product research email). Reads [`Atlarix/.env`](../.env) (`SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `EMAIL_SOURCE`).

```bash
cd Atlarix
npm run email:user-feedback:dry-run
npm run email:user-feedback -- --only you@example.com
npm run email:user-feedback
```

- Prefers **From:** `Amariah <amariah@atlarix.dev>`; falls back to `EMAIL_SOURCE` with `reply_to: amariah@atlarix.dev` if Resend rejects the sender.
- Excludes `amariah.abish@gmail.com` and `amani.kamau06@gmail.com` by default.
- Log: `scripts/.outreach-sent.log.json` (gitignored).

## send-v85-upgrade-emails.mjs

One-off outreach: notify confirmed Supabase users that **v8.5.0** is available at [atlarix.dev](https://atlarix.dev). Reads [`Atlarix/.env`](../.env). Replies go to **amariah@atlarix.dev**.

```bash
cd Atlarix
npm run email:v85-upgrade:dry-run
npm run email:v85-upgrade -- --only you@example.com
npm run email:v85-upgrade
```

- **From:** `Amariah @ Atlarix <amariah@atlarix.dev>` (or `EMAIL_SOURCE` in `.env`)
- **Reply-To:** `amariah@atlarix.dev`
- Excludes `amariah.abish@gmail.com` and `amani.kamau06@gmail.com`
- Ledger: `scripts/.feedback-outreach-v85-sent.jsonl` (gitignored)
- `--init-ledger-from-supabase` — seed ledger without sending
- `--include-unconfirmed` — include users without confirmed email

Workspace copy (same campaign): `../scripts/send-v85-upgrade-emails.mjs` with `node --env-file=../Atlarix/.env`.

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
