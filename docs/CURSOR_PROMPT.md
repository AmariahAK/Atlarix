# Cursor Task — Mac Code Signing, Release Workflow & Website Updates

## Context
Atlarix is an Electron app built with Electron Forge + Vite. We are adding Mac code signing and notarization, temporarily hiding Windows downloads, and wiring up VirusTotal scanning. 

**DO NOT commit, tag, or push anything. All changes are local only until instructed.**

---

## Task 1 — Update forge.config.ts (signing env var names)

In `forge.config.ts`, the `osxSign` and `osxNotarize` blocks currently reference `APPLE_PASSWORD` and `APPLE_TEAM_ID`. Update them to match our actual GitHub secrets:

- `APPLE_PASSWORD` → keep as is (this is correct, maps to `APPLE_APP_SPECIFIC_PASSWORD` secret which will be passed as `APPLE_PASSWORD` in the workflow env)
- The `osxSign` identity should use the full Developer ID string, not just the Team ID. Update it to:

```ts
osxSign: isEndToEndTestBuild || !process.env.APPLE_IDENTITY
  ? undefined
  : {
      identity: process.env.APPLE_IDENTITY,
    },
osxNotarize: isEndToEndTestBuild || !process.env.APPLE_ID || !process.env.APPLE_PASSWORD || !process.env.APPLE_TEAM_ID
  ? undefined
  : {
      appleId: process.env.APPLE_ID!,
      appleIdPassword: process.env.APPLE_PASSWORD!,
      teamId: process.env.APPLE_TEAM_ID!,
    },
```

Where `APPLE_IDENTITY` will be the full string like `"Developer ID Application: Your Name (TEAMID)"` — this will be set as a GitHub secret later (currently TBD, do not hardcode).

---

## Task 2 — Update existing release workflow

Find the existing release workflow in `.github/workflows/` that currently builds and publishes Mac + Windows + Linux. Make the following changes:

### 2a — Mac job: add certificate import + signing env vars
In the Mac build job, add a step BEFORE the build step to import the Apple certificate into the macOS keychain:

```yaml
- name: Import Apple certificate
  env:
    APPLE_CERT_BASE64: ${{ secrets.APPLE_CERT_BASE64 }}
    APPLE_CERT_PASSWORD: ${{ secrets.APPLE_CERT_PASSWORD }}
  run: |
    echo "$APPLE_CERT_BASE64" | base64 --decode > certificate.p12
    security create-keychain -p actions-keychain build.keychain
    security default-keychain -s build.keychain
    security unlock-keychain -p actions-keychain build.keychain
    security import certificate.p12 -k build.keychain \
      -P "$APPLE_CERT_PASSWORD" \
      -T /usr/bin/codesign \
      -T /usr/bin/security
    security set-key-partition-list \
      -S apple-tool:,apple:,codesign: \
      -s -k actions-keychain build.keychain
    security find-identity -v build.keychain
    rm certificate.p12
```

In the Mac build step, add these env vars (mapping our secret names to what forge.config.ts expects):

```yaml
env:
  APPLE_ID: ${{ secrets.APPLE_ID }}
  APPLE_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
  APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
  APPLE_IDENTITY: ${{ secrets.APPLE_IDENTITY }}
  GITHUB_TOKEN: ${{ secrets.RELEASES_TOKEN }}
```

Note: `APPLE_CERT_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_IDENTITY`, and `APPLE_TEAM_ID` are currently TBD (pending Apple Developer approval). Add them to the workflow but add a comment `# TBD - pending Apple Developer Program approval` next to each one so we know to update later.

### 2b — Windows job: temporarily disable
In the Windows build/publish job, wrap the entire job with a condition that prevents it from running:

```yaml
if: false # Windows signing pending — temporarily disabled. Re-enable when YubiKey and OV cert are ready.
```

This keeps the job in the file for when we're ready, but skips it on every run.

### 2c — Add VirusTotal scanning job
Add a new job at the end of the workflow called `virustotal` that runs after the Mac job succeeds:

```yaml
virustotal:
  needs: [mac-job-name] # use the actual Mac job name from the existing workflow
  runs-on: ubuntu-latest
  steps:
    - name: Wait for release assets
      run: sleep 30

    - name: Get release tag
      id: tag
      run: echo "tag=${GITHUB_REF#refs/tags/}" >> $GITHUB_OUTPUT

    - name: Download DMG from atlarix-releases
      run: |
        mkdir -p ./assets
        gh release download ${{ steps.tag.outputs.tag }} \
          --repo AmariahAK/atlarix-releases \
          --pattern "*.dmg" \
          --dir ./assets
      env:
        GITHUB_TOKEN: ${{ secrets.RELEASES_TOKEN }}

    - name: Submit to VirusTotal
      run: |
        for file in ./assets/*.dmg; do
          if [ -f "$file" ]; then
            echo "Submitting $(basename $file)..."
            RESPONSE=$(curl --silent --request POST \
              --url https://www.virustotal.com/api/v3/files \
              --header "x-apikey: ${{ secrets.VIRUSTOTAL_API_KEY }}" \
              --form "file=@$file")
            echo "$RESPONSE"
            ANALYSIS_ID=$(echo $RESPONSE | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('id','N/A'))")
            echo "VirusTotal analysis: https://www.virustotal.com/gui/file-analysis/$ANALYSIS_ID"
          fi
        done
```

---

## Task 3 — Website: hide Windows download

Find where the Windows download button/section is rendered on the website (likely in the landing page or download page component). 

- **Remove or hide the Windows download button/link entirely**
- **Add a message in its place** that reads:

> "Windows version is currently in development. Stay tuned for updates!"

Style it to match the existing UI — a subtle muted text or a small badge/pill, not an error state. If there's a platform detection system showing OS-specific downloads, make sure Windows users also see this message instead of a download button.

---

## Task 4 — Release page: hide Windows releases

In the atlarix-releases repo README or wherever release download links are listed, if there's any automation or script that generates the release page or links:

- Add a note or comment that Windows `.exe` releases should not be linked/promoted until further notice
- If the release page is auto-generated from GitHub releases, add a comment in the relevant script or component that says:
  `// Windows releases temporarily hidden — pending code signing setup`

---

## Summary of secrets referenced (for your awareness, do not hardcode any values)

| Secret Name (GitHub) | Maps to in workflow env | Status |
|---------------------|------------------------|--------|
| `APPLE_ID` | `APPLE_ID` | ✅ Set |
| `APPLE_APP_SPECIFIC_PASSWORD` | `APPLE_PASSWORD` | ✅ Set |
| `APPLE_TEAM_ID` | `APPLE_TEAM_ID` | ⏳ TBD |
| `APPLE_CERT_BASE64` | `APPLE_CERT_BASE64` | ⏳ TBD |
| `APPLE_CERT_PASSWORD` | `APPLE_CERT_PASSWORD` | ⏳ TBD |
| `APPLE_IDENTITY` | `APPLE_IDENTITY` | ⏳ TBD |
| `RELEASES_TOKEN` | `GITHUB_TOKEN` | ✅ Set |
| `VIRUSTOTAL_API_KEY` | `VIRUSTOTAL_API_KEY` | ✅ Set |

---

**Reminder: DO NOT commit, tag, or push. Local changes only.**
