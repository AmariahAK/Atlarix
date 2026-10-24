# MSIX / Microsoft Store runbook

How to build, sign, install, and verify the Atlarix MSIX package **by hand**.

> ## Read this first
>
> **Shipping to the Store is fully automated and is the live path.** Tagging `v*`
> builds the package, wraps it, and submits it to Partner Center via
> `scripts/store-submit.mjs` — no human step, no artifact to fetch. The listing is
> live at <https://apps.microsoft.com/detail/9p3rr11dvzpw> and certification has
> passed.
>
> **So this document is NOT how releases happen**, and it must not be used to infer
> what CI does — its manual flow predates the automation and has already caused one
> wrong conclusion about the workflow (2026-08-17: the MSIX artifact was justified
> as a "manual submission fallback" that no longer exists). **Read
> `.github/workflows/msix.yml` for what actually runs.**
>
> What this document IS for: getting a signed package onto a Windows machine so the
> deep-system behaviour can be verified **inside the package container** — §4. That
> verification was **confirmed by the owner on 2026-09-04**. §4 is kept as the procedure
> to re-run after any change to the sandbox helper, the protocol handler, or the payload
> binaries.

---

## Store identity (assigned by Partner Center — do not edit)

| Field                                     | Value                                     |
| ----------------------------------------- | ----------------------------------------- |
| `Package/Identity/Name`                   | `AmariahAbishai.Atlarix`                  |
| `Package/Identity/Publisher`              | `CN=B8A553CE-4E5B-49AD-B077-6973F43EADFD` |
| `Package/Properties/PublisherDisplayName` | `Amariah Abishai`                         |

These live in `build/msix/AppxManifest.template.xml`.

> **The single most common way to lose an afternoon here:** the test certificate's
> subject must be **exactly** `CN=B8A553CE-4E5B-49AD-B077-6973F43EADFD` — the
> GUID, **not** `CN=Amariah Abishai`. Windows compares the signing certificate's
> subject against `Identity/@Publisher` byte-for-byte and refuses the install on
> mismatch, with an error that does not mention the publisher at all.

---

## 1. Build the package (CI)

MSIX packaging needs the Windows SDK's `makeappx.exe`, so it cannot run on macOS.
`scripts/make-msix.mjs` exits with that message if you try.

**On a release, the whole thing is automatic and produces NOTHING to download.**
Tagging `v*` runs `release.yml`, which calls `msix.yml` with `upload_wrapper: true`;
the job builds the `.msix`, wraps it as `.msixupload`, and submits it to Partner
Center in the same job, reading straight from `out/msix/`.

`build-msix` **is** in `publish-release`'s `needs` (owner's rule, 2026-08-28), so a
failure to BUILD the MSIX blocks the desktop publish as well: `publish-release` never
runs and the draft stays invisible with all its assets attached. Recover with a job
re-run, not a new tag. (Believing the opposite is what let v14.38.3 ship desktop-only.)
Two safeguards remain:

- Submission to Partner Center (`scripts/store-submit.mjs`, Submission API v1, Azure AD
  client credentials from the `AZURE_AD_TENANT_ID` / `AZURE_AD_CLIENT_ID` /
  `AZURE_AD_CLIENT_SECRET` secrets) is `continue-on-error: true`, so a Store API outage
  cannot fail a release — only a failed build can.
- A product has ONE pending-submission slot. A release replaces a draft or a failed
  submission. One Microsoft is processing or certifying is waited for (up to 10
  minutes); if it is still there, that release skips the Store with a warning (the
  2026-10-18 "newest release wins" rule restarted certification on every release, so
  nothing published from 14.51.0 to 15.10.0). A submission whose certification was
  cancelled in Partner Center is reused as a draft. `msstore-submit` concurrency keeps
  two tags from fighting over the slot. To see what the Store has without building:
  dispatch this workflow with `store_status` on.
- **Re-running a release's Store step** (it skipped, or a newer release should take a
  submission's place): don't re-run the job, since that re-runs `publish-release` and
  `announce-release` too. Cancel the pending certification in Partner Center if there is
  one, push a branch made from the tag, and dispatch this workflow on it with
  `store_resubmit_run` = the tag's `release.yml` run id:
  `gh workflow run msix.yml --ref store/vX.Y.Z -f store_resubmit_run=<run id>`. It uses
  that run's `landlock-helper` artifact, which lasts ONE day, so do it within a day of
  the tag.
- The package is **not** uploaded to `atlarix-releases`. It is unsigned, and an
  unsigned `.msix` cannot be installed without the signer's certificate — publishing
  one would put a broken download on the public releases page.

**There is normally no `atlarix-msix-x64` artifact, and its ABSENCE is the success
signal.** The upload is conditional (v14.32.0):

```yaml
if: github.event_name == 'workflow_dispatch' || steps.store_submit.outcome == 'failure'
```

It used to upload on every tag at 14-day retention while nothing ever downloaded it —
nine copies at 163–326 MB took the account's 0.5 GB Actions storage to 100% and
tripped an Actions budget that blocked all CI. Retention is now 2 days.

**So you only get an artifact in two cases:**

| Case                             | Why the artifact exists                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| Manual run (`workflow_dispatch`) | Nothing submits — the package IS the deliverable, and this is the path for §2–§4 below |
| Store submission failed on a tag | It is the only copy of a package that already took ~40 min to build                    |

**For a manual build**, Actions → **Atlarix MSIX** → _Run workflow_.

- Leave `arch` on `x64`. It is the only valid value: `scripts/win-ci-lib.mjs`
  hardcodes `ARCH = "x64"`.
- `upload_wrapper` defaults to off for manual runs (a test build doesn't need the
  Store wrapper) and on for release runs.
- `runner` defaults to `windows-latest` (the VS 2026 image); `windows-2022` is kept as
  a dispatch option for an A/B when a Windows build fails.

The `atlarix-msix-x64` artifact then contains:

- `Atlarix-<version>-x64.msix` — **unsigned**
- `Atlarix-<version>-x64.msixupload` — only when `upload_wrapper` was on
- `AppxManifest.xml` — the rendered manifest, so you can confirm the identity values
  without unpacking the package

Then copy it to the Windows machine. **Download it within 2 days** — that is the
retention now.

The package is unsigned by design: no code-signing private key needs to live in
GitHub secrets, and Microsoft re-signs at certification anyway. The local
signature exists only so Windows will install it for testing.

---

## 2. One-time Windows setup

### Signing tools — no SDK install required

MSIX signing requires `signtool.exe`. There is no PowerShell equivalent —
`Set-AuthenticodeSignature` cannot sign a `.msix`, because signing must also
rewrite `AppxBlockMap.xml` and `AppxSignature.p7x` inside the package.

You do **not** need the Windows SDK installer. The `Microsoft.Windows.SDK.BuildTools`
NuGet package is a ~21 MB zip that carries `signtool.exe` together with every DLL
appx signing needs (`appxpackaging.dll`, `appxsip.dll`, `mssign32.dll`,
`wintrust.dll`, `opcservices.dll`). Extract and run — no installer, no admin.

```powershell
$work = "$HOME\atlarix-msix"
New-Item -ItemType Directory -Force -Path $work | Out-Null

# Some Windows 10 builds still default to TLS 1.0 for Invoke-WebRequest.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$pkg = "microsoft.windows.sdk.buildtools"
$ver = (Invoke-RestMethod "https://api.nuget.org/v3-flatcontainer/$pkg/index.json").versions[-1]
Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/$pkg/$ver/$pkg.$ver.nupkg" `
  -OutFile "$work\sdk-buildtools.zip"
Expand-Archive "$work\sdk-buildtools.zip" -DestinationPath "$work\sdk" -Force

$signtool = (Get-ChildItem "$work\sdk\bin" -Recurse -Filter signtool.exe |
  Where-Object FullName -like "*\x64\*" | Select-Object -First 1).FullName
$signtool          # remember this path; used in step 3
& $signtool /?     # should print usage
```

### Test certificate (generate ONCE, then reuse)

Reuse the same certificate across builds. A different signing certificate on the
same package identity makes `Add-AppxPackage` refuse an in-place upgrade, forcing
a `Remove-AppxPackage` every iteration.

```powershell
# Subject MUST be the GUID from the identity table above.
$cert = New-SelfSignedCertificate `
  -Type Custom `
  -Subject "CN=B8A553CE-4E5B-49AD-B077-6973F43EADFD" `
  -KeyUsage DigitalSignature `
  -FriendlyName "Atlarix MSIX Test" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3","2.5.29.19={text}")

# 2.5.29.37 = Extended Key Usage → Code Signing (1.3.6.1.5.5.7.3.3)
# 2.5.29.19 = Basic Constraints  → not a CA
$cert.Thumbprint   # note this down

$pw = Read-Host -AsSecureString "PFX password"
Export-PfxCertificate -Cert "Cert:\CurrentUser\My\$($cert.Thumbprint)" `
  -FilePath "$HOME\atlarix-msix-test.pfx" -Password $pw

# Export the PUBLIC half and trust it machine-wide so Windows will install
# packages signed by it. Requires an ELEVATED PowerShell.
Export-Certificate -Cert "Cert:\CurrentUser\My\$($cert.Thumbprint)" `
  -FilePath "$HOME\atlarix-msix-test.cer"
Import-Certificate -FilePath "$HOME\atlarix-msix-test.cer" `
  -CertStoreLocation "Cert:\LocalMachine\TrustedPeople"
```

### Remove the Squirrel build first

Uninstall the normal Atlarix (`Setup.exe`) install before testing deep links.
With both present they compete for the `atlarix://` handler and you will misread
the result — and the protocol handler is the most important thing §4 checks.

---

## 3. Sign and install

GitHub serves workflow artifacts as a zip, so extract it first — signing the zip
instead of the `.msix` inside it is an easy mistake to make.

```powershell
$work = "$HOME\atlarix-msix"
Expand-Archive "$HOME\Downloads\atlarix-msix-x64.zip" -DestinationPath "$work\pkg" -Force
$msix = (Get-ChildItem "$work\pkg" -Recurse -Filter *.msix | Select-Object -First 1).FullName
$msix

# $signtool from step 2. Omit /p if you would rather be prompted.
& $signtool sign /fd SHA256 /f "$HOME\atlarix-msix-test.pfx" /p <password> $msix

& $signtool verify /pa /v $msix        # should report a valid chain

Add-AppxPackage $msix
```

**Install from an interactive session, not over SSH.** Over SSH (session 0), `Add-AppxPackage` fails with
"Failed to initialize PLM 0x80070005". Run it from the desktop, or from an Interactive scheduled task (2026-10-24).

**Before starting the installed app, check who the Windows profile is signed in as.** The MSIX shares
`%APPDATA%\Atlarix` with the Squirrel install, and a CI-built package has production Sentry/PostHog baked in. On a
profile signed in as a real account, even opening the app sends that account's app-open events. For tests, use a
fresh Windows user or move the profile aside first.

**The browser bridge's 5 registry keys and its host manifest STAY after `Remove-AppxPackage`**, because they are
deliberately unvirtualized. That's harmless: the host exits 0 when no relay runs. Every other HKCU write is
virtualized and goes with the package.

If `Add-AppxPackage` fails, the message is usually unhelpful. Get the real reason:

```powershell
Get-AppxLog | Select-Object -First 30
```

Common causes:

| Symptom                                   | Cause                                                               |
| ----------------------------------------- | ------------------------------------------------------------------- |
| "publisher … does not match"              | cert subject is not the exact GUID (see the warning above)          |
| "not trusted"                             | the `.cer` is not in `LocalMachine\TrustedPeople` (needs elevation) |
| "already installed" with a different cert | regenerated certificate — `Remove-AppxPackage` first                |
| Fails on Windows 10 build < 17763         | below the manifest's `MinVersion`; check `winver`                   |

---

## 4. The behaviour check — verifying a SHIPPED package

Run the automated probes first, then the three things no probe can cover.

> This was written as a gate to clear _before_ submitting to the Store. That gate has
> been passed: the app is listed, certification succeeded, and submission is
> automated. The owner **confirmed the in-container behaviour on 2026-09-04**, along
> with the Low-IL sandbox and the `taskkill` process-tree kill. (On-device voice was
> confirmed then too; it was removed in v14.50.0 and is no longer part of this check.)

### 4a. Baseline on the Squirrel build (do this FIRST)

Capture a baseline on a normal install before uninstalling it, so any failure inside
MSIX is attributable to MSIX rather than to the thing being tested.

> **Note:** older builds report fewer probes. Diff by probe NAME, not by count — a
> baseline from an older Squirrel build that lacks a probe is complete, not failing.

> **Do not use `npm run self-test:packaged` for this.** It sets
> `E2E_TEST_BUILD=true`, which redirects the app's data paths
> (`src/paths/paths.ts`), so the `context` probe would report test paths and the
> whole userData comparison would be meaningless.

```powershell
$env:ATLARIX_SELF_TEST_OUT="$HOME\atlarix-squirrel-selftest.log"
& "$env:LOCALAPPDATA\atlarix\atlarix.exe" --self-test
Get-Content $env:ATLARIX_SELF_TEST_OUT
```

### 4b. Probes inside the MSIX

`atlarix.exe` is on `PATH` via the manifest's `appExecutionAlias` — the installed
binary under `C:\Program Files\WindowsApps` is ACL-restricted and awkward to
launch directly.

The Windows executable is GUI-subsystem, so **stdout detaches**. The file sink is
mandatory, and pointing it at `$HOME` doubles as a filesystem-write check:

```powershell
$env:ATLARIX_SELF_TEST_OUT="$HOME\atlarix-msix-selftest.log"
atlarix.exe --self-test
Get-Content $env:ATLARIX_SELF_TEST_OUT
```

Expected probes (the list in `src/main/self-test.ts` is the authority): `pty-spawn`,
`sqlite`, `proxy-worker`, `ripgrep`, `ai-sdk-deps`, `context`, `child-exec`,
`fs-outside-container`, `sandbox`.

**Diff the MSIX log against the Squirrel baseline.** What to look for:

| Probe                  | Reading it                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context`              | `windowsStore=true` confirms the MSIX branch is live. **Compare `userData=` against the baseline** — if it differs, a Squirrel user switching to the Store build gets a fresh profile (no workspaces, chats, or credentials) and we need a migration. Record the value either way.                         |
| `child-exec`           | Proves a command actually _executed_ (asserts on exit code, unlike `pty-spawn`). The `git=` field surfaces how an external dev tool resolves under inherited package identity.                                                                                                                             |
| `fs-outside-container` | A `REDIRECTED` note means writes to `$HOME` are being sent elsewhere by the container — that would be a serious finding.                                                                                                                                                                                   |
| `sqlite`               | The `better-sqlite3` native module loads and round-trips a row. A failure is an ABI mismatch or a prune that lost the unpacked binary.                                                                                                                                                                       |
| `pty-spawn`            | Terminal spawning via conpty. Note: on Windows this probe is weak — it writes `printf` into a PowerShell pty and PowerShell has no `printf`, so the marker appears in the _error_ text. Trust `child-exec` for execution; trust this one only for "node-pty loads and streams".                            |
| `sandbox`              | The write-confining sandbox, end to end: write-inside allowed, write-outside denied, **read-outside allowed**, a non-system binary execs, `truncate` outside denied. A failure here is a real finding — this is the probe that exists because the AppContainer helper shipped broken for several releases. |

### 4c. Manual checks (no probe can cover these)

1. **Launch the app.** It should open a window, not just exit.
2. **Terminal tab** — open one and run a command interactively.
3. **Agent `run_command`** — ask the agent something that shells out, e.g.
   _"what version of node and npm are installed?"_. **It must succeed, and `git
--version` must work too.** Note a terminal _tab_ does not exercise this: PTY tabs
   are never sandboxed by design, and `edit_file` is a different path — so testing
   only those tells you nothing about the sandbox. Then confirm engagement:
   ```powershell
   Select-String -Path (Join-Path $env:APPDATA "Atlarix\logs\main.log") `
     -Pattern "Sandboxing run_command|not sandboxed" | Select-Object -Last 5
   ```
   An `info`-level `Sandboxing run_command (win32)` line means it engaged; a
   `not sandboxed` warning means it fell back and is running unconfined.
4. **A sub-agent turn** — sub-agents are in-process
   (`src/lib/agents/run-subagent.ts`, no `fork`), so this should follow from the
   app running at all. Confirm anyway.
5. **OAuth sign-in.** This is the real test of the manifest's `windows.protocol`
   declaration. `app.setAsDefaultProtocolClient` is skipped under MSIX because
   HKCU writes are virtualized; the manifest owns the handler, and activation
   arrives as argv. If sign-in completes, deep links work.
6. **Lemon Squeezy checkout, end to end.** Opening the browser
   (`shell.openExternal`) is the easy half. The half that can break is the return
   leg — `atlarix://pro-return?key=…` reaching the app and activating Pro. Verify
   Pro actually activates.
7. **CLI entry point** — `atlarix C:\some\repo` should open that folder as a
   workspace.

A green probe table plus 1–7 by hand is the go/no-go after a change to any of the above.

### Teardown

```powershell
Get-AppxPackage *Atlarix* | Remove-AppxPackage
```

---

## Files involved

| Path                                   | Role                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build/msix/AppxManifest.template.xml` | manifest; `{{VERSION}}` substituted at build time                                                                                                         |
| `build/msix/assets/`                   | Store logos (committed; regenerate with `scripts/gen-icons.mjs`)                                                                                          |
| `scripts/make-msix.mjs`                | stages the layout and runs `makeappx pack`                                                                                                                |
| `.github/workflows/msix.yml`           | the MSIX build — manual (`workflow_dispatch`) **and** called by `release.yml` on every `v*` tag. **The authority on what CI does; this document is not.** |
| `scripts/store-submit.mjs`             | automated Partner Center submission (Submission API v1)                                                                                                   |
| `src/main/update-helpers.ts`           | `chooseUpdaterKind` returns `none` for Store installs                                                                                                     |
| `src/main/self-test.ts`                | the self-test probes                                                                                                                                      |
| `src/main.ts`                          | `IS_MICROSOFT_STORE_BUILD`; skips runtime protocol registration                                                                                           |
