# TODO

## Current Version: 4.0.0

## Atlarix 4.0.5 — Progressive dependency & deprecation cleanup (patch)

- **Audit & fix:** Run `npm audit` and address 2 moderate vulnerabilities; prefer `npm audit fix` without `--force` first.
- **Deprecation replacements (transitive):**
  - `inflight` / old `glob`: ensure top-level deps don’t pull them; prefer `glob@11` and avoid `inflight` (use `lru-cache` where applicable).
  - `prebuild-install`: comes from native deps (e.g. `better-sqlite3`); upgrade to a maintained prebuild pipeline or accept until upstream drops it.
  - `node-domexception`: replace with platform `DOMException` where possible or upgrade the dep that pulls it in.
- **Patch/minor bumps:** Update all deps to latest patch/minor in range (no major jumps yet); run tests and `npm run make` after each batch.
- **CI:** Re-run release after changes and confirm deprecation warnings are reduced and audit is clean or documented.

## Atlarix 4.1.0 — Node, Electron & toolchain upgrades (minor)

- **Node:** Move from 20 to 22 LTS in `package.json` `engines` and in `.github/workflows/release.yml` (`node-version: '22'`). Verify Electron compatibility for Node 22.
- **Electron:** Upgrade to latest stable in the major line supported by Forge; run full test suite and manual smoke test.
- **TypeScript / Vite:** Bump to latest minor (or major if needed for Electron); fix any config or type breaks.
- **ESLint/oxlint, Prettier:** Update and fix any rule changes.
- **Major dependency passes:** After Node/Electron/TS are stable, do a pass of major upgrades for non-native deps (e.g. React ecosystem, AI SDKs); run tests and e2e after each.
- **Optional (later):** Evaluate Node 24 when LTS and when Electron officially supports it; repeat same staged approach.

## Why build-macos (arm64) can lag behind build-macos (x64)

- **Single job, sequential makers:** Release runs one `npm run make` on `macos-latest`. Electron Forge builds macOS targets one after the other (e.g. x64 then arm64). So arm64 starts only after x64 finishes; it’s not a separate parallel job.
- **Native rebuilds per arch:** `better-sqlite3` (and any prebuild/native modules) is rebuilt for each architecture. The second arch (arm64) does another full native compile and “Preparing native dependencies,” which can take several minutes.
- **Notarization:** If notarization runs per artifact, arm64 is notarized after x64 and can sit in Apple’s queue, so the job stays in “Notarize macOS app” for longer.
- **Deprecations:** Extra work during `packageAfterPrune` / npm install (e.g. `prebuild-install`, old `glob`) can make the second arch’s install step slower. Cleaning deps (4.0.5) may reduce this.

## Next (4.1+)

- Wire full API implementations for Workforce tools (Slack, Jira, Linear, Sentry, Calendar, etc.) behind Token Vault.
- Permission queue / step-up UI for approval-required Workforce actions.
- Team Settings UI in app (invite flow, members list, add seats).

## Future

- Enterprise SSO
- Voice input
- Timeline export (GIF)
- Workspace templates (Pro)

## Done (v4.0)

- Workforce tier and pricing
- Auth0 Token Vault (env, service, IPC)
- LemonSqueezy Workforce checkout and webhook
- Teams (schema, service, IPC, effective_tier)
- Progressive Tool Reveal (ToolManifest, ToolSessionLoader, prompt integration)
- Workforce extensions (abstraction + Slack, Jira, Linear, CI, Sentry, Notion, Calendar)
- Workspace Context (Workforce-only block)
- Workforce AI tools (registry + stubs)
- DB Studio move to Workforce + grandfather + migration notice
- File revert ("Revert to here" → snapshot restore)

## Done (v3.9)

- GitHub Actions in left panel (Pro)
- Pre-exchange snapshots for conversation revert
- stream_terminal_output, stream_pipeline_logs
