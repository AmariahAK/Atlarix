# MSIX / Microsoft Store runbook

How to build, sign, install, and spike-test the Atlarix MSIX package.

The point of this exercise is **step 4 — the behavior spike**. Everything before it
exists to get an installed package onto a Windows machine so the deep-system
features can be verified inside the package container, *before* Microsoft is
involved. If the spike fails, debug it here.

---

## Store identity (assigned by Partner Center — do not edit)

| Field | Value |
| --- | --- |
| `Package/Identity/Name` | `AmariahAbishai.Atlarix` |
| `Package/Identity/Publisher` | `CN=B8A553CE-4E5B-49AD-B077-6973F43EADFD` |
| `Package/Properties/PublisherDisplayName` | `Amariah Abishai` |

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

1. Run the **Atlarix MSIX (manual)** workflow — Actions → `msix.yml` →
   *Run workflow*. It is `workflow_dispatch` only and never touches the
   `atlarix-releases` repo.
   - Leave `arch` on `x64`. It is the only valid value: `scripts/win-ci-lib.mjs`
     hardcodes `ARCH = "x64"`.
   - Tick `upload_wrapper` only when preparing an actual Store submission.
2. Download the `atlarix-msix-x64` artifact. It contains:
   - `Atlarix-<version>-x64.msix` — **unsigned**
   - `AppxManifest.xml` — the rendered manifest, so you can confirm the identity
     values without unpacking the package
3. Copy it to the Windows test machine.

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
the result — which is the single most important thing the spike measures.

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

If `Add-AppxPackage` fails, the message is usually unhelpful. Get the real reason:

```powershell
Get-AppxLog | Select-Object -First 30
```

Common causes:

| Symptom | Cause |
| --- | --- |
| "publisher … does not match" | cert subject is not the exact GUID (see the warning above) |
| "not trusted" | the `.cer` is not in `LocalMachine\TrustedPeople` (needs elevation) |
| "already installed" with a different cert | regenerated certificate — `Remove-AppxPackage` first |
| Fails on Windows 10 build < 17763 | below the manifest's `MinVersion`; check `winver` |

---

## 4. The behavior spike — the actual gate

Run the automated probes first, then the three things no probe can cover.

### 4a. Baseline on the Squirrel build (do this FIRST)

Capture a baseline on a normal install before uninstalling it, so any failure inside
MSIX is attributable to MSIX rather than to the thing being tested.

> **Note:** older builds have only 4 probes. The `context`, `child-exec`,
> `fs-outside-container` and `sandbox` probes were added later, so a baseline taken
> from a pre-14.28 build will report `PASSED (4/4)` — that is complete, not missing.

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

Expected probes: `pty-spawn`, `proxy-worker`, `ripgrep`, `ai-sdk-deps`, `context`,
`child-exec`, `fs-outside-container`, `sandbox`.

**Diff the MSIX log against the Squirrel baseline.** What to look for:

| Probe | Reading it |
| --- | --- |
| `context` | `windowsStore=true` confirms the MSIX branch is live. **Compare `userData=` against the baseline** — if it differs, a Squirrel user switching to the Store build gets a fresh profile (no workspaces, chats, or credentials) and we need a migration. Record the value either way. |
| `child-exec` | Proves a command actually *executed* (asserts on exit code, unlike `pty-spawn`). The `git=` field surfaces how an external dev tool resolves under inherited package identity. |
| `fs-outside-container` | A `REDIRECTED` note means writes to `$HOME` are being sent elsewhere by the container — that would be a serious finding. |
| `pty-spawn` | Terminal spawning via conpty. Note: on Windows this probe is weak — it writes `printf` into a PowerShell pty and PowerShell has no `printf`, so the marker appears in the *error* text. Trust `child-exec` for execution; trust this one only for "node-pty loads and streams". |
| `sandbox` | The write-confining sandbox, end to end: write-inside allowed, write-outside denied, **read-outside allowed**, a non-system binary execs, `truncate` outside denied. A failure here is a real finding — this is the probe that exists because the AppContainer helper shipped broken for several releases. |

### 4c. Manual checks (no probe can cover these)

1. **Launch the app.** It should open a window, not just exit.
2. **Terminal tab** — open one and run a command interactively.
3. **Agent `run_command`** — ask the agent something that shells out, e.g.
   *"what version of node and npm are installed?"*. **It must succeed, and `git
   --version` must work too.** Note a terminal *tab* does not exercise this: PTY tabs
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

A green probe table plus 1–7 by hand is the go/no-go for Store submission.

### Teardown

```powershell
Get-AppxPackage *Atlarix* | Remove-AppxPackage
```

---

## 5. Still to do (owner-driven, after the spike passes)

- Store listing: description, screenshots, category, age-rating questionnaire.
- **`runFullTrust` justification.** It is a *restricted* capability needing
  Microsoft approval. One honest line: a full-trust desktop AI workstation that
  spawns local developer processes (shells, git, ripgrep, package managers) and
  reads/writes the user's own source trees.
- **Lemon Squeezy / IAP note.** Purchases go through a PCI-DSS-compliant
  third-party merchant of record; the app collects no financial account
  information.
- Upload, submit, wait out certification (a few hours to ~3 business days).
  Microsoft strips the test signature and re-signs with its own trusted
  certificate — which is the whole point: zero SmartScreen for every user.
- **Only after certification passes**, wire MSIX into the release automation.
  Until then it stays on `workflow_dispatch`. Windows-only path bugs in this repo
  have a history of surfacing at tag time.

---

## Files involved

| Path | Role |
| --- | --- |
| `build/msix/AppxManifest.template.xml` | manifest; `{{VERSION}}` substituted at build time |
| `build/msix/assets/` | Store logos (committed; regenerate with `scripts/gen-icons.mjs`) |
| `scripts/make-msix.mjs` | stages the layout and runs `makeappx pack` |
| `.github/workflows/msix.yml` | manual CI build |
| `src/main/update-helpers.ts` | `chooseUpdaterKind` returns `none` for Store installs |
| `src/main/self-test.ts` | the spike probes |
| `src/main.ts` | `IS_MICROSOFT_STORE_BUILD`; skips runtime protocol registration |
