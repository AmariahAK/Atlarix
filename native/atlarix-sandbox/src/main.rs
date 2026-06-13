//! `atlarix-sandbox.exe` — Windows AppContainer write-confining sandbox helper.
//!
//! Contract (called verbatim by `src/lib/sandbox/wrap-command.ts`):
//!
//! ```text
//! atlarix-sandbox.exe --workspace <dir> [--writable <dir>]... -- <command string>
//! ```
//!
//! It launches `cmd.exe /c <command>` inside a low-privilege AppContainer that:
//!   * can WRITE only to `--workspace` / `--writable` paths (+ its own profile temp),
//!   * can READ the rest of the volume (write-confining, not read-confining — mirrors
//!     the macOS Seatbelt / Linux bubblewrap profiles),
//!   * keeps network ON via the `internetClient` capability.
//!
//! Exit code is the wrapped command's exit code. On any sandbox setup failure we
//! print a diagnostic to stderr and exit 87 (ERROR_INVALID_PARAMETER) so the
//! caller can distinguish "sandbox broke" from a normal command failure.
//!
//! Build: `cargo build --release` (windows-latest in CI). Single static exe.

#![cfg(windows)]

use std::ffi::OsStr;
use std::iter::once;
use std::os::windows::ffi::OsStrExt;
use std::process::exit;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HLOCAL, INVALID_HANDLE_VALUE,
    WAIT_OBJECT_0,
};
use windows::Win32::Security::Authorization::{
    ConvertStringSidToSidW, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
    EXPLICIT_ACCESS_W, GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, TRUSTEE_IS_SID,
    TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
};
use windows::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows::Win32::Security::{
    ACL, DACL_SECURITY_INFORMATION, PSID, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES,
};
use windows::Win32::System::Memory::LocalFree;
use windows::Win32::System::SystemServices::{
    SE_GROUP_ENABLED, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
};
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList,
    UpdateProcThreadAttribute, WaitForSingleObject, EXTENDED_STARTUPINFO_PRESENT,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    STARTUPINFOEXW, STARTUPINFOW, INFINITE,
};

const SANDBOX_SETUP_FAILED: i32 = 87; // ERROR_INVALID_PARAMETER
const CONTAINER_NAME: &str = "Atlarix.RunCommand";
/// Well-known capability SID for `internetClient` (keeps network on).
const INTERNET_CLIENT_SID: &str = "S-1-15-3-1";
/// Modify | Read | Execute | Write | Delete on files/dirs (write-confining grant).
const FILE_MODIFY_MASK: u32 = 0x001F_01BF; // FILE_GENERIC_READ|WRITE|EXECUTE + DELETE-ish

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
}

fn parse_args() -> Args {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut writable = Vec::new();
    let mut command = String::new();
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--workspace" | "--writable" => {
                if i + 1 >= argv.len() {
                    die("missing value after --workspace/--writable");
                }
                writable.push(argv[i + 1].clone());
                i += 2;
            }
            "--" => {
                command = argv[i + 1..].join(" ");
                break;
            }
            other => die(&format!("unexpected argument: {other}")),
        }
    }
    if command.trim().is_empty() {
        die("no command supplied after --");
    }
    Args { writable, command }
}

/// Create (or reuse) the AppContainer profile and return its SID buffer.
unsafe fn app_container_sid() -> PSID {
    let name = wide(CONTAINER_NAME);
    let display = wide("Atlarix run_command");
    let desc = wide("Write-confining sandbox for Atlarix agent commands");

    match CreateAppContainerProfile(
        PCWSTR(name.as_ptr()),
        PCWSTR(display.as_ptr()),
        PCWSTR(desc.as_ptr()),
        None,
    ) {
        Ok(sid) => sid,
        Err(_) => {
            // Already exists (common) — derive the SID for the existing profile.
            if GetLastError() == ERROR_ALREADY_EXISTS || true {
                match DeriveAppContainerSidFromAppContainerName(PCWSTR(name.as_ptr())) {
                    Ok(sid) => sid,
                    Err(e) => die(&format!("DeriveAppContainerSid failed: {e:?}")),
                }
            } else {
                die("CreateAppContainerProfile failed");
            }
        }
    }
}

/// Grant the AppContainer SID modify access (inheritable) on `path`.
unsafe fn grant_write(path: &str, container_sid: PSID) {
    let wpath = wide(path);

    // Read the existing DACL.
    let mut old_dacl: *mut ACL = std::ptr::null_mut();
    let mut sec_desc = windows::Win32::Security::PSECURITY_DESCRIPTOR::default();
    let status = GetNamedSecurityInfoW(
        PCWSTR(wpath.as_ptr()),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        None,
        None,
        Some(&mut old_dacl),
        None,
        &mut sec_desc,
    );
    if status.is_err() {
        die(&format!("GetNamedSecurityInfo failed for {path}: {status:?}"));
    }

    // Build an EXPLICIT_ACCESS granting the container SID modify, inherited by
    // child files/dirs (so newly created files are writable too).
    let mut ea = EXPLICIT_ACCESS_W {
        grfAccessPermissions: FILE_MODIFY_MASK,
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
            ptstrName: PWSTR(container_sid.0 as *mut u16),
        },
    };

    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    let merge = SetEntriesInAclW(Some(&mut [ea]), Some(old_dacl as *const ACL), &mut new_dacl);
    let _ = &mut ea;
    if merge.is_err() {
        die(&format!("SetEntriesInAcl failed for {path}: {merge:?}"));
    }

    let apply = SetNamedSecurityInfoW(
        PCWSTR(wpath.as_ptr()),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        None,
        None,
        Some(new_dacl as *const ACL),
        None,
    );
    if apply.is_err() {
        die(&format!("SetNamedSecurityInfo failed for {path}: {apply:?}"));
    }

    if !sec_desc.0.is_null() {
        let _ = LocalFree(HLOCAL(sec_desc.0 as *mut _));
    }
    if !new_dacl.is_null() {
        let _ = LocalFree(HLOCAL(new_dacl as *mut _));
    }
}

unsafe fn capability_sid(sid_string: &str) -> PSID {
    let w = wide(sid_string);
    let mut sid = PSID::default();
    if ConvertStringSidToSidW(PCWSTR(w.as_ptr()), &mut sid).is_err() {
        die(&format!("ConvertStringSidToSid({sid_string}) failed"));
    }
    sid
}

fn main() {
    let args = parse_args();

    unsafe {
        let container_sid = app_container_sid();

        // Grant write to every workspace/writable path.
        for p in &args.writable {
            grant_write(p, container_sid);
        }

        // internetClient capability so the sandboxed command keeps network access.
        let inet_sid = capability_sid(INTERNET_CLIENT_SID);
        let mut caps = [SID_AND_ATTRIBUTES {
            Sid: inet_sid,
            Attributes: SE_GROUP_ENABLED as u32,
        }];

        let mut sec_caps = SECURITY_CAPABILITIES {
            AppContainerSid: container_sid,
            Capabilities: caps.as_mut_ptr(),
            CapabilityCount: caps.len() as u32,
            Reserved: 0,
        };

        // Build a proc-thread attribute list carrying the security capabilities.
        let mut size = 0usize;
        let _ = InitializeProcThreadAttributeList(LPPROC_THREAD_ATTRIBUTE_LIST::default(), 1, 0, &mut size);
        let mut buf = vec![0u8; size];
        let attr_list = LPPROC_THREAD_ATTRIBUTE_LIST(buf.as_mut_ptr() as *mut _);
        if InitializeProcThreadAttributeList(attr_list, 1, 0, &mut size).is_err() {
            die("InitializeProcThreadAttributeList failed");
        }
        if UpdateProcThreadAttribute(
            attr_list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            Some(&mut sec_caps as *mut _ as *const _),
            std::mem::size_of::<SECURITY_CAPABILITIES>(),
            None,
            None,
        )
        .is_err()
        {
            die("UpdateProcThreadAttribute failed");
        }

        let mut si = STARTUPINFOEXW::default();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.lpAttributeList = attr_list;

        let mut pi = PROCESS_INFORMATION::default();

        // Run via cmd.exe so shell builtins / pipelines work, matching the
        // POSIX `sh -c <command>` shape on the other platforms.
        let mut cmdline = wide(&format!("cmd.exe /c {}", args.command));

        let created = CreateProcessW(
            PCWSTR::null(),
            PWSTR(cmdline.as_mut_ptr()),
            None,
            None,
            false,
            EXTENDED_STARTUPINFO_PRESENT,
            None,
            PCWSTR::null(),
            &si.StartupInfo,
            &mut pi,
        );
        if created.is_err() {
            die(&format!("CreateProcess (AppContainer) failed: {created:?}"));
        }

        // Wait and propagate the child's exit code.
        let mut code: u32 = SANDBOX_SETUP_FAILED as u32;
        if WaitForSingleObject(pi.hProcess, INFINITE) == WAIT_OBJECT_0 {
            let _ = GetExitCodeProcess(pi.hProcess, &mut code);
        }

        let _ = CloseHandle(pi.hThread);
        let _ = CloseHandle(pi.hProcess);
        DeleteProcThreadAttributeList(attr_list);

        // Quiet unused warnings for handles we never touch.
        let _ = (HANDLE::default(), INVALID_HANDLE_VALUE);

        exit(code as i32);
    }
}
