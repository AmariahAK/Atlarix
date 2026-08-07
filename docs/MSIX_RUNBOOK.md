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

### Signing tools

MSIX signing requires `signtool.exe`. There is no PowerShell equivalent —
`Set-AuthenticodeSignature` cannot sign a `.msix`, because signing must also
rewrite `AppxBlockMap.xml` and `AppxSignature.p7x` inside the package.

Install just the signing component, not the whole SDK:

1. Download the **Windows SDK** installer from Microsoft.
2. In the component list, select **only** *Windows SDK Signing Tools for Desktop
   Apps*. Deselect everything else.
3. Note the resulting path, typically:
   ```
   C:\Program Files (x86)\Windows Kits\10\bin\<10.0.x.y>\x64\signtool.exe
   ```

Add it to `$PROFILE` so the rest of this document can just say `signtool`:

```powershell
$sdk = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Directory |
  Where-Object Name -like "10.*" | Sort-Object Name -Descending | Select-Object -First 1
$env:Path += ";$($sdk.FullName)\x64"
signtool /?   # should print usage
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

```powershell
cd <folder with the artifact>

signtool sign /fd SHA256 /a /f "$HOME\atlarix-msix-test.pfx" /p <password> `
  .\Atlarix-<version>-x64.msix

signtool verify /pa /v .\Atlarix-<version>-x64.msix    # should report a valid chain

Add-AppxPackage .\Atlarix-<version>-x64.msix
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

The Windows AppContainer sandbox helper (`atlarix-sandbox.exe`) has never been
validated on real Windows hardware — see `src/lib/sandbox/WINDOWS_HELPER.md`. If
you test it for the first time *inside* MSIX and it fails, you cannot tell whether
MSIX or the helper is at fault. So capture a baseline on a normal install first,
then uninstall it.

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
`child-exec`, `fs-outside-container`.

**Diff the MSIX log against the Squirrel baseline.** What to look for:

| Probe | Reading it |
| --- | --- |
| `context` | `windowsStore=true` confirms the MSIX branch is live. **Compare `userData=` against the baseline** — if it differs, a Squirrel user switching to the Store build gets a fresh profile (no workspaces, chats, or credentials) and we need a migration. Record the value either way. |
| `child-exec` | Proves a command actually *executed* (asserts on exit code, unlike `pty-spawn`). The `git=` field surfaces how an external dev tool resolves under inherited package identity. |
| `fs-outside-container` | A `REDIRECTED` note means writes to `$HOME` are being sent elsewhere by the container — that would be a serious finding. |
| `pty-spawn` | Terminal spawning via conpty. Note: on Windows this probe is weak — it writes `printf` into a PowerShell pty and PowerShell has no `printf`, so the marker appears in the *error* text. Trust `child-exec` for execution; trust this one only for "node-pty loads and streams". |

### 4c. Manual checks (no probe can cover these)

1. **Launch the app.** It should open a window, not just exit.
2. **Terminal tab** — open one and run a command interactively.
3. **Agent `run_command`** — run an agent turn that shells out. Check the log for
   whether the AppContainer sandbox engaged or fell back (`wrap-command.ts` logs a
   warning on fallback).
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
