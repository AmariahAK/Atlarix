//! `atlarix-sandbox.exe` — Windows write-confining sandbox helper for `run_command`.
//!
//! Contract (called verbatim by `src/lib/sandbox/wrap-command.ts`):
//!
//! ```text
//! atlarix-sandbox.exe --workspace <dir> [--writable <dir>]... [--shell <path>] \
//!                     [--read-only] -- <command string>
//! atlarix-sandbox.exe --probe            # self-check: exit 0 if the mechanism works
//! ```
//!
//! Policy (identical to the macOS Seatbelt and Linux Landlock profiles):
//!   * WRITE only to `--workspace` / `--writable` paths,
//!   * READ and EXECUTE anything,
//!   * network stays ON.
//!
//! # Why Low Integrity Level and not AppContainer
//!
//! This helper used AppContainer until it was first executed on real hardware,
//! where it broke the toolchain outright: `bash.exe` returned "Access is denied",
//! git failed with "could not open '/dev/null'", and PowerShell could not resolve
//! its own FileSystem provider.
//!
//! The cause was a primitive/policy mismatch, not tuning. **AppContainer is
//! deny-by-default on READS**: a file is only reachable if its DACL carries an ACE
//! for the container SID or `ALL APPLICATION PACKAGES`. System32 ships that ACE,
//! which is why `where.exe` worked; `C:\Program Files\` does not, which is why
//! `bash.exe` did not. It is the browser/UWP isolation model, and our policy is the
//! opposite shape — reads broad, writes confined.
//!
//! Mandatory Integrity Control is that shape natively. A Low-IL process may read
//! and execute higher-integrity objects but cannot write them (`NO_WRITE_UP`), so
//! confinement comes from the OS with no ACL surgery on system directories. It also
//! needs no elevation, no local accounts, and no virtualization — which matters
//! because this ships inside an MSIX Store package.
//!
//! Writes are granted back by stamping a Low mandatory label on each writable root
//! (the Win32 equivalent of `icacls <dir> /setintegritylevel (OI)(CI) L`). That
//! label PERSISTS after the command: it is the user's own workspace, applying it
//! once is cheap, and reverting per-command would race between concurrent runs. The
//! trade is recorded in `src/lib/sandbox/WINDOWS_HELPER.md` — any other Low-IL
//! process running as that user could then write to the workspace.
//!
//! Exit code is the wrapped command's exit code. On sandbox setup failure we print a
//! diagnostic to stderr and exit 87 (ERROR_INVALID_PARAMETER); `wrap-command.ts`
//! runs `--probe` once per session so that case is detected BEFORE a user command,
//! rather than surfacing as a mysterious command failure.
//!
//! Build: `cargo build --release` (windows-latest in CI). Single static exe.
//!
//! NOTE: `#![cfg(windows)]` means this file compiles to an EMPTY binary on macOS and
//! Linux. `cargo build` succeeding on a dev machine proves nothing — which is
//! exactly how the AppContainer bug shipped. The `sandbox` probe in
//! `src/main/self-test.ts` is the real gate; it runs in every CI package job.

#![cfg(windows)]

use std::ffi::OsStr;
use std::iter::once;
use std::os::windows::ffi::OsStrExt;
use std::process::exit;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, LocalFree, BOOL, HANDLE, HLOCAL, WAIT_OBJECT_0};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW,
    SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows::Win32::Security::{
    DuplicateTokenEx, GetSecurityDescriptorSacl, SetTokenInformation, TokenIntegrityLevel,
    TokenPrimary, SecurityImpersonation, LABEL_SECURITY_INFORMATION, ACL, PSECURITY_DESCRIPTOR,
    PSID, SID_AND_ATTRIBUTES, TOKEN_ALL_ACCESS, TOKEN_DUPLICATE, TOKEN_MANDATORY_LABEL,
    TOKEN_QUERY,
};
use windows::Win32::System::SystemServices::SE_GROUP_INTEGRITY;
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetCurrentProcess, GetExitCodeProcess, OpenProcessToken,
    WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT, INFINITE, PROCESS_INFORMATION, STARTUPINFOW,
};

const SANDBOX_SETUP_FAILED: i32 = 87; // ERROR_INVALID_PARAMETER

/// Low mandatory level SID. A process carrying this can read/execute up but not write up.
const LOW_INTEGRITY_SID: &str = "S-1-16-4096";

/// SDDL for a Low mandatory label, inherited by children:
///   `ML` = SYSTEM_MANDATORY_LABEL_ACE, `OICI` = object+container inherit,
///   `NW` = NO_WRITE_UP, `LW` = Low mandatory level.
/// Subjects at Low or above may write; below Low may not. Building this via SDDL
/// avoids hand-assembling a SYSTEM_MANDATORY_LABEL_ACE, which `SetEntriesInAclW`
/// cannot produce (it only emits allow/deny ACEs).
const LOW_LABEL_SDDL: &str = "S:(ML;OICI;NW;;;LW)";

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(once(0)).collect()
}

fn die(msg: &str) -> ! {
    eprintln!("atlarix-sandbox: {msg}");
    exit(SANDBOX_SETUP_FAILED);
}

struct Args {
    writable: Vec<String>,
    command: String,
    /// Shell to run the command with, from `--shell`. Empty means `cmd.exe`.
    ///
    /// This matters more on Windows than anywhere else. `runShellCommand` spawns
    /// UNsandboxed commands with `shell: getAcceptableShell()`, which prefers Git
    /// bash when Git for Windows is installed — while this helper used to hardcode
    /// `cmd.exe /c`. So the same command ran in bash unsandboxed and cmd sandboxed,
    /// and POSIX-shaped commands (`printf`, `VAR=x cmd`, `mkdir -p`) failed with
    /// cmd.exe syntax errors that looked nothing like a sandbox problem. A sandbox
    /// must change permissions, not the language.
    shell: String,
    /// `--probe`: verify the mechanism works on this machine, then exit.
    probe: bool,
}

fn parse_args() -> Args {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    // The workspace is tracked separately so `--read-only` can exclude it from the
    // write grant (Explore/Plan/Review: workspace source is not writable).
    let mut workspace: Option<String> = None;
    let mut writable = Vec::new();
    let mut command = String::new();
    let mut shell = String::new();
    let mut read_only = false;
    let mut probe = false;

    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--probe" => {
                probe = true;
                i += 1;
            }
            "--shell" if i + 1 < argv.len() => {
                shell = argv[i + 1].clone();
                i += 2;
            }
            "--read-only" => {
                read_only = true;
                i += 1;
            }
            "--workspace" if i + 1 < argv.len() => {
                workspace = Some(argv[i + 1].clone());
                i += 2;
            }
            "--writable" if i + 1 < argv.len() => {
                writable.push(argv[i + 1].clone());
                i += 2;
            }
            "--" => {
                command = argv[i + 1..].join(" ");
                break;
            }
            _ => i += 1,
        }
    }

    if !read_only {
        if let Some(ws) = workspace {
            writable.insert(0, ws);
        }
    }

    if !probe && command.trim().is_empty() {
        die("no command given (expected `-- <command>`)");
    }

    Args {
        writable,
        command,
        shell,
        probe,
    }
}

/// Build the command line, matching how the UNsandboxed path would run it.
///
/// `cmd.exe` (and an unset shell) takes `/c`; a POSIX-style shell such as Git
/// bash takes `-c`. Quoting the shell path handles `C:\Program Files\…`.
fn command_line_for(shell: &str, command: &str) -> String {
    let base = shell
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if shell.is_empty() || base == "cmd.exe" || base == "cmd" {
        format!("cmd.exe /c {command}")
    } else {
        format!("\"{shell}\" -c \"{}\"", command.replace('"', "\\\""))
    }
}

/// Resolve a SID string (e.g. `S-1-16-4096`) to a PSID. Caller leaks it; the
/// process is short-lived and exits immediately after the child.
unsafe fn sid_from_string(s: &str) -> PSID {
    let mut sid = PSID::default();
    if ConvertStringSidToSidW(PCWSTR(wide(s).as_ptr()), &mut sid).is_err() {
        die(&format!("ConvertStringSidToSid failed for {s}"));
    }
    sid
}

/// Stamp a Low mandatory label on `path` so a Low-IL child can write there.
///
/// Non-fatal: a path we cannot label simply stays unwritable, which fails closed.
/// Erroring out here would make one stale entry in the writable list break every
/// command.
unsafe fn label_low(path: &str) {
    let mut psd = PSECURITY_DESCRIPTOR::default();
    if ConvertStringSecurityDescriptorToSecurityDescriptorW(
        PCWSTR(wide(LOW_LABEL_SDDL).as_ptr()),
        SDDL_REVISION_1,
        &mut psd,
        None,
    )
    .is_err()
    {
        eprintln!("atlarix-sandbox: could not build Low label SDDL");
        return;
    }

    let mut present = BOOL(0);
    let mut sacl: *mut ACL = std::ptr::null_mut();
    let mut defaulted = BOOL(0);
    if GetSecurityDescriptorSacl(psd, &mut present, &mut sacl, &mut defaulted).is_ok()
        && present.as_bool()
        && !sacl.is_null()
    {
        let err = SetNamedSecurityInfoW(
            PCWSTR(wide(path).as_ptr()),
            SE_FILE_OBJECT,
            LABEL_SECURITY_INFORMATION,
            PSID::default(),
            PSID::default(),
            None,
            Some(sacl),
        );
        if err.is_err() {
            eprintln!("atlarix-sandbox: could not label {path} Low ({err:?}); it stays unwritable");
        }
    }

    let _ = LocalFree(HLOCAL(psd.0));
}

/// Duplicate our own primary token and drop its integrity level to Low.
///
/// Lowering our OWN token needs no privilege — this is the same construction
/// Chrome uses for renderers on standard user accounts. `CreateProcessAsUserW`
/// documents `SE_ASSIGNPRIMARYTOKEN_NAME` as required only when the token "is not
/// assignable", and a restricted duplicate of the caller's token is.
unsafe fn low_integrity_token() -> HANDLE {
    let mut own = HANDLE::default();
    if OpenProcessToken(
        GetCurrentProcess(),
        TOKEN_DUPLICATE | TOKEN_QUERY,
        &mut own,
    )
    .is_err()
    {
        die("OpenProcessToken failed");
    }

    let mut dup = HANDLE::default();
    if DuplicateTokenEx(
        own,
        TOKEN_ALL_ACCESS,
        None,
        SecurityImpersonation,
        TokenPrimary,
        &mut dup,
    )
    .is_err()
    {
        die("DuplicateTokenEx failed");
    }
    let _ = CloseHandle(own);

    let mut label = TOKEN_MANDATORY_LABEL {
        Label: SID_AND_ATTRIBUTES {
            Sid: sid_from_string(LOW_INTEGRITY_SID),
            Attributes: SE_GROUP_INTEGRITY as u32,
        },
    };
    if SetTokenInformation(
        dup,
        TokenIntegrityLevel,
        &mut label as *mut _ as *const _,
        std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32,
    )
    .is_err()
    {
        die("SetTokenInformation(TokenIntegrityLevel=Low) failed");
    }

    dup
}

/// A UTF-16 `KEY=VALUE\0…\0\0` block: our environment with TEMP/TMP redirected.
///
/// A Low-IL child cannot write the normal `%TEMP%` (Medium integrity), and a tool
/// that cannot create a temp file fails in ways that look nothing like a sandbox
/// denial — that is precisely how git's `/dev/null` failure presented. `LocalLow`
/// is already Low-labelled by Windows, so no labelling is needed here.
fn env_block_with_low_temp(temp: &str) -> Vec<u16> {
    let mut block: Vec<u16> = Vec::new();
    for (k, v) in std::env::vars() {
        let upper = k.to_ascii_uppercase();
        if upper == "TEMP" || upper == "TMP" {
            continue;
        }
        block.extend(wide(&format!("{k}={v}")));
    }
    block.extend(wide(&format!("TEMP={temp}")));
    block.extend(wide(&format!("TMP={temp}")));
    block.push(0); // terminating empty string
    block
}

/// Create (and return) a Low-writable temp directory for the child.
fn low_temp_dir() -> String {
    let base = std::env::var("USERPROFILE").unwrap_or_default();
    let dir = format!("{base}\\AppData\\LocalLow\\Atlarix\\sandbox-temp");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Run `command` under a Low-IL token and return its exit code.
unsafe fn run_confined(writable: &[String], command: &str, shell: &str) -> u32 {
    for p in writable {
        label_low(p);
    }

    let token = low_integrity_token();

    let temp = low_temp_dir();
    let mut env = env_block_with_low_temp(&temp);

    let mut si = STARTUPINFOW::default();
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut pi = PROCESS_INFORMATION::default();

    // Same shell the unsandboxed path would use, so builtins and syntax match.
    let mut cmdline = wide(&command_line_for(shell, command));

    let created = CreateProcessAsUserW(
        token,
        PCWSTR::null(),
        PWSTR(cmdline.as_mut_ptr()),
        None,
        None,
        false,
        CREATE_UNICODE_ENVIRONMENT,
        Some(env.as_mut_ptr() as *const _),
        PCWSTR::null(),
        &si,
        &mut pi,
    );
    if created.is_err() {
        die(&format!(
            "CreateProcessAsUser (Low IL) failed: {created:?} — if this is \
             ERROR_PRIVILEGE_NOT_HELD (1314) the Low IL mechanism is unavailable here"
        ));
    }

    let mut code: u32 = SANDBOX_SETUP_FAILED as u32;
    if WaitForSingleObject(pi.hProcess, INFINITE) == WAIT_OBJECT_0 {
        let _ = GetExitCodeProcess(pi.hProcess, &mut code);
    }
    let _ = CloseHandle(pi.hThread);
    let _ = CloseHandle(pi.hProcess);
    let _ = CloseHandle(token);
    code
}

fn main() {
    let args = parse_args();

    unsafe {
        // `--probe`: prove the mechanism works before any user command relies on it.
        // Runs a trivial confined command in a Low-writable temp dir; exit 0 means
        // token creation and Low-IL spawn both succeeded on this machine.
        if args.probe {
            let temp = low_temp_dir();
            // Probe with cmd.exe explicitly: we are testing the TOKEN mechanism, and
            // a missing or exotic --shell must not make the probe report the sandbox
            // as unusable.
            let code = run_confined(&[temp], "exit 0", "");
            exit(if code == 0 { 0 } else { SANDBOX_SETUP_FAILED });
        }

        exit(run_confined(&args.writable, &args.command, &args.shell) as i32);
    }
}
