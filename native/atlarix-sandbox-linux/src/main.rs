//! atlarix-sandbox-linux — Landlock write-confining sandbox helper for Atlarix
//! `run_command`, the Linux sibling of `native/atlarix-sandbox` (Windows).
//!
//! Policy (identical to the macOS Seatbelt / Windows AppContainer helpers):
//! confine file WRITES to the workspace + the given writable roots (caches/temp);
//! reads stay broad; NETWORK STAYS ON (Landlock governs the filesystem only).
//!
//! Contract (what `wrap-command.ts` calls):
//!   atlarix-sandbox-linux --workspace <dir> [--writable <dir>]... \
//!       [--read-only] [--deny-report <file>] -- <command>
//! Exit code = the wrapped command's exit code; stdout/stderr pass through.
//!
//! Denied-path reporting (OPTIONAL — `trace-supervisor` feature + runtime env
//! `ATLARIX_SANDBOX_TRACE=1`): forks the command under a seccomp(SECCOMP_RET_TRACE)
//! + ptrace supervisor that records write syscalls targeting a path OUTSIDE the
//! writable roots (exactly what Landlock will deny) into `--deny-report`, so
//! escalation-on-denial can offer the precise path even when the failing tool
//! doesn't print it. OFF by default — the base build is landlock-only and pulls
//! no extra crates, so this can be compiled/validated only on real Linux without
//! risking the default release. On any supervisor setup failure it degrades to
//! the plain landlock-exec path below (the sandbox never breaks).
//!
//! Best-effort: uses the most capable Landlock ABI the running kernel supports
//! and degrades gracefully on older kernels. If Landlock is unavailable the
//! command still runs, unconfined — the harness approval gate is the other layer.
//!
//! Build: `cargo build --release` (Linux CI job). Add `--features trace-supervisor`
//! to compile the reporting supervisor.

#![cfg(target_os = "linux")]

use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{exit, Command};

use landlock::{
    path_beneath_rules, AccessFs, Ruleset, RulesetAttr, RulesetCreatedAttr, ABI,
};

/// Setup-failure exit code (mirrors the Windows helper's `87`).
fn die(msg: &str) -> ! {
    eprintln!("atlarix-sandbox-linux: {msg}");
    exit(87);
}

struct Args {
    workspace: String,
    writable: Vec<String>,
    /// Read-only mode: the workspace is NOT granted write (only `--writable` roots are).
    read_only: bool,
    /// Optional file the supervisor writes denied paths to (one per line).
    /// Only read under the `trace-supervisor` feature.
    #[allow(dead_code)]
    deny_report: Option<String>,
    command: String,
}

fn parse_args() -> Args {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut workspace = String::new();
    let mut writable: Vec<String> = Vec::new();
    let mut read_only = false;
    let mut deny_report: Option<String> = None;
    let mut command = String::new();
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--workspace" => {
                i += 1;
                workspace = argv.get(i).cloned().unwrap_or_default();
            }
            "--writable" => {
                i += 1;
                if let Some(p) = argv.get(i) {
                    writable.push(p.clone());
                }
            }
            "--read-only" => {
                read_only = true;
            }
            "--deny-report" => {
                i += 1;
                deny_report = argv.get(i).cloned();
            }
            "--" => {
                // Everything after `--` is the command string (run via sh -c).
                command = argv[i + 1..].join(" ");
                break;
            }
            _ => {}
        }
        i += 1;
    }
    if workspace.is_empty() {
        die("missing --workspace");
    }
    if command.trim().is_empty() {
        die("no command supplied after --");
    }
    Args {
        workspace,
        writable,
        read_only,
        deny_report,
        command,
    }
}

/// Writable roots the child is actually granted (workspace unless read-only, plus
/// the `--writable` list). Existing paths only — Landlock needs a real fd.
fn writable_roots(args: &Args) -> Vec<String> {
    let base: Vec<String> = if args.read_only {
        Vec::new()
    } else {
        vec![args.workspace.clone()]
    };
    base.into_iter()
        .chain(args.writable.iter().cloned())
        .filter(|p| Path::new(p).exists())
        .collect()
}

/// Apply the Landlock ruleset to THIS process (inherited across the exec below).
/// Only WRITE-family accesses are "handled" (deny-by-default); reads/exec stay
/// unrestricted everywhere. Writes are granted back under the writable roots. On
/// any Landlock error we log and return (run unconfined) — matching the "sandbox
/// never breaks the workflow" policy.
fn apply_landlock(roots: &[String]) {
    let abi = ABI::V2;
    let write = AccessFs::from_write(abi);

    let result = Ruleset::default()
        .handle_access(write)
        .and_then(|r| r.create())
        .and_then(|r| r.add_rules(path_beneath_rules(roots, write)))
        .and_then(|r| r.restrict_self());

    if let Err(e) = result {
        eprintln!(
            "atlarix-sandbox-linux: Landlock unavailable or failed ({e:?}); running unconfined"
        );
    }
}

fn main() {
    let args = parse_args();
    let roots = writable_roots(&args);

    // Optional authoritative denied-path reporting. Returns only if the supervisor
    // could not be set up (pre-fork) — then we fall through to the plain path.
    #[cfg(feature = "trace-supervisor")]
    {
        if std::env::var("ATLARIX_SANDBOX_TRACE").as_deref() == Ok("1") {
            trace_supervisor::run(&args, &roots);
        }
    }

    // Default / fallback: apply Landlock to self, then become the command.
    apply_landlock(&roots);
    let err = Command::new("/bin/sh").arg("-c").arg(&args.command).exec();
    die(&format!("exec /bin/sh failed: {err}"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Authoritative denied-path reporting supervisor (feature-gated).
//
// NOTE: compiles only with `--features trace-supervisor` and runs only under
// ATLARIX_SANDBOX_TRACE=1. It is written to be validated on real Linux hardware
// (it cannot be compiled on the macOS dev box) — every fallible step degrades to
// the plain landlock-exec path so it can never break the sandbox.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(feature = "trace-supervisor")]
mod trace_supervisor {
    use super::{apply_landlock, Args};
    use std::collections::BTreeSet;
    use std::os::unix::process::CommandExt;
    use std::process::{exit, Command};

    use nix::sys::ptrace;
    use nix::sys::signal::{raise, Signal};
    use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
    use nix::unistd::{fork, ForkResult, Pid};

    /// A write syscall targeting a path outside the writable roots is exactly what
    /// Landlock denies — so we record it as a (predicted) denial without needing
    /// the syscall's return value. Each entry: (syscall_nr, path-arg index).
    #[cfg(target_arch = "x86_64")]
    fn path_arg_index(nr: u64) -> Option<usize> {
        // asm/unistd_64.h numbers.
        match nr {
            2 | 85 | 83 | 82 | 84 | 87 | 76 | 90 | 92 | 94 | 133 | 188 | 189 | 197 | 198 => Some(0), // open, creat, mkdir, rename, rmdir, unlink, truncate, chmod, chown, lchown, mknod, *setxattr, *removexattr
            257 | 437 | 258 | 263 | 268 | 260 | 259 | 280 | 264 | 316 => Some(1), // openat, openat2, mkdirat, unlinkat, fchmodat, fchownat, mknodat, utimensat, renameat, renameat2 (src)
            88 => Some(1),  // symlink (target dest = arg1)
            86 => Some(1),  // link (dest = arg1)
            266 => Some(2), // symlinkat (dest = arg2)
            265 => Some(3), // linkat (dest = arg3)
            _ => None,
        }
    }

    #[cfg(target_arch = "aarch64")]
    fn path_arg_index(nr: u64) -> Option<usize> {
        // asm-generic/unistd.h numbers (aarch64 has only the -at variants).
        match nr {
            45 | 5 | 6 | 14 | 15 => Some(0), // truncate, setxattr, lsetxattr, removexattr, lremovexattr
            56 | 437 | 34 | 35 | 53 | 54 | 33 | 88 | 38 | 276 => Some(1), // openat, openat2, mkdirat, unlinkat, fchmodat, fchownat, mknodat, utimensat, renameat, renameat2 (src)
            36 => Some(2), // symlinkat (dest)
            37 => Some(3), // linkat (dest)
            _ => None,
        }
    }

    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    fn path_arg_index(_nr: u64) -> Option<usize> {
        None
    }

    #[cfg(target_arch = "x86_64")]
    fn read_syscall(pid: Pid) -> Option<(u64, [u64; 6])> {
        let mut regs: libc::user_regs_struct = unsafe { std::mem::zeroed() };
        let mut iov = libc::iovec {
            iov_base: &mut regs as *mut _ as *mut libc::c_void,
            iov_len: std::mem::size_of::<libc::user_regs_struct>(),
        };
        const NT_PRSTATUS: libc::c_int = 1;
        let r = unsafe {
            libc::ptrace(libc::PTRACE_GETREGSET, pid.as_raw(), NT_PRSTATUS, &mut iov as *mut _)
        };
        if r < 0 {
            return None;
        }
        Some((regs.orig_rax, [regs.rdi, regs.rsi, regs.rdx, regs.r10, regs.r8, regs.r9]))
    }

    #[cfg(target_arch = "aarch64")]
    fn read_syscall(pid: Pid) -> Option<(u64, [u64; 6])> {
        let mut regs: libc::user_regs_struct = unsafe { std::mem::zeroed() };
        let mut iov = libc::iovec {
            iov_base: &mut regs as *mut _ as *mut libc::c_void,
            iov_len: std::mem::size_of::<libc::user_regs_struct>(),
        };
        const NT_PRSTATUS: libc::c_int = 1;
        let r = unsafe {
            libc::ptrace(libc::PTRACE_GETREGSET, pid.as_raw(), NT_PRSTATUS, &mut iov as *mut _)
        };
        if r < 0 {
            return None;
        }
        // x8 = syscall nr; x0..x5 = args.
        Some((
            regs.regs[8],
            [regs.regs[0], regs.regs[1], regs.regs[2], regs.regs[3], regs.regs[4], regs.regs[5]],
        ))
    }

    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    fn read_syscall(_pid: Pid) -> Option<(u64, [u64; 6])> {
        None
    }

    /// Read a NUL-terminated path from the tracee's memory via /proc/<pid>/mem.
    fn read_cstr(pid: Pid, addr: u64) -> Option<String> {
        use std::io::{Read, Seek, SeekFrom};
        if addr == 0 {
            return None;
        }
        let mut f = std::fs::File::open(format!("/proc/{}/mem", pid.as_raw())).ok()?;
        f.seek(SeekFrom::Start(addr)).ok()?;
        let mut out: Vec<u8> = Vec::with_capacity(128);
        let mut chunk = [0u8; 128];
        loop {
            let n = f.read(&mut chunk).ok()?;
            if n == 0 {
                break;
            }
            for &b in &chunk[..n] {
                if b == 0 {
                    return String::from_utf8(out).ok();
                }
                out.push(b);
                if out.len() > 4096 {
                    return String::from_utf8(out).ok();
                }
            }
        }
        String::from_utf8(out).ok()
    }

    /// A path worth reporting: absolute, not under a writable root, not a system
    /// pseudo-fs. Relative paths are skipped (dirfd resolution is ambiguous —
    /// stderr-parse covers those).
    fn is_reportable(path: &str, roots: &[String]) -> bool {
        if !path.starts_with('/') {
            return false;
        }
        for sys in ["/dev/", "/proc/", "/sys/"] {
            if path.starts_with(sys) {
                return false;
            }
        }
        !roots.iter().any(|r| {
            let r = r.trim_end_matches('/');
            path == r || path.starts_with(&format!("{r}/"))
        })
    }

    /// Build + install a seccomp filter that traps only fs-mutating syscalls to
    /// the tracer (SECCOMP_RET_TRACE), allowing everything else — so overhead is
    /// bounded to write operations. Returns Err (fall back) on any failure.
    fn install_seccomp() -> Result<(), Box<dyn std::error::Error>> {
        use seccompiler::{apply_filter, BpfProgram, SeccompAction, SeccompFilter};
        use std::collections::BTreeMap;

        // Trap the union of both arches' write syscall numbers; numbers absent on
        // the running arch simply never fire.
        let traced: &[i64] = &[
            2, 85, 83, 82, 84, 87, 76, 90, 92, 94, 133, 188, 189, 197, 198, 257, 437, 258, 263,
            268, 260, 259, 280, 264, 316, 88, 86, 266, 265, // x86_64
            45, 5, 6, 14, 15, 56, 34, 35, 53, 54, 33, 38, 276, 36, 37, // aarch64
        ];
        let mut rules: BTreeMap<i64, Vec<seccompiler::SeccompRule>> = BTreeMap::new();
        for &nr in traced {
            rules.insert(nr, vec![]); // empty conditions = match the syscall unconditionally
        }
        let filter = SeccompFilter::new(
            rules,
            SeccompAction::Allow,   // non-matching syscalls
            SeccompAction::Trace(0), // matched → RET_TRACE to the tracer
            std::env::consts::ARCH.try_into()?,
        )?;
        let prog: BpfProgram = filter.try_into()?;
        apply_filter(&prog)?;
        Ok(())
    }

    /// Fork the command under the supervisor. Returns only if setup failed BEFORE
    /// forking (caller then runs the plain landlock-exec path). Otherwise the
    /// parent supervises and `exit()`s with the child's code — never returning.
    pub fn run(args: &Args, roots: &[String]) {
        match unsafe { fork() } {
            Ok(ForkResult::Child) => child(args, roots),
            Ok(ForkResult::Parent { child }) => exit(supervise(child, args, roots)),
            Err(_) => { /* fork failed — fall back to the plain path */ }
        }
    }

    /// Child: confine, request tracing, install the seccomp trap, stop for the
    /// parent to set options, then become the command. Any tracing-setup failure
    /// is non-fatal — Landlock still confines writes.
    fn child(args: &Args, roots: &[String]) -> ! {
        apply_landlock(roots);
        let _ = ptrace::traceme();
        let _ = install_seccomp();
        // Stop so the parent can set ptrace options before we exec.
        let _ = raise(Signal::SIGSTOP);
        let err = Command::new("/bin/sh").arg("-c").arg(&args.command).exec();
        super::die(&format!("exec /bin/sh failed: {err}"));
    }

    /// Parent: drive the ptrace loop, collect denied paths, write the report, and
    /// return the command's exit code.
    fn supervise(child: Pid, args: &Args, roots: &[String]) -> i32 {
        // Wait for the child's initial SIGSTOP (raised after traceme).
        if waitpid(child, None).is_err() {
            return 87;
        }
        let opts = ptrace::Options::PTRACE_O_TRACESECCOMP
            | ptrace::Options::PTRACE_O_TRACEFORK
            | ptrace::Options::PTRACE_O_TRACEVFORK
            | ptrace::Options::PTRACE_O_TRACECLONE
            | ptrace::Options::PTRACE_O_TRACEEXEC
            | ptrace::Options::PTRACE_O_EXITKILL;
        let _ = ptrace::setoptions(child, opts);
        let _ = ptrace::cont(child, None);

        let mut denied: BTreeSet<String> = BTreeSet::new();
        let mut code: i32 = 0;

        loop {
            match waitpid(None, Some(WaitPidFlag::__WALL)) {
                Ok(WaitStatus::Exited(pid, c)) => {
                    if pid == child {
                        code = c;
                        break;
                    }
                }
                Ok(WaitStatus::Signaled(pid, _, _)) => {
                    if pid == child {
                        code = 128;
                        break;
                    }
                }
                Ok(WaitStatus::PtraceEvent(pid, _sig, ev)) => {
                    if ev == libc::PTRACE_EVENT_SECCOMP {
                        if let Some((nr, argv)) = read_syscall(pid) {
                            if let Some(idx) = path_arg_index(nr) {
                                if let Some(p) = read_cstr(pid, argv[idx]) {
                                    if is_reportable(&p, roots) {
                                        denied.insert(p);
                                    }
                                }
                            }
                        }
                    }
                    let _ = ptrace::cont(pid, None);
                }
                Ok(WaitStatus::Stopped(pid, sig)) => {
                    // Forward real signals; swallow SIGTRAP (ptrace bookkeeping).
                    let deliver = if sig == Signal::SIGTRAP { None } else { Some(sig) };
                    let _ = ptrace::cont(pid, deliver);
                }
                Ok(WaitStatus::PtraceSyscall(pid)) => {
                    let _ = ptrace::cont(pid, None);
                }
                Ok(_) => {}
                Err(nix::errno::Errno::ECHILD) => break,
                Err(_) => break,
            }
        }

        if let Some(report) = &args.deny_report {
            if !denied.is_empty() {
                let body = denied.into_iter().collect::<Vec<_>>().join("\n");
                let _ = std::fs::write(report, body);
            }
        }
        code
    }
}
