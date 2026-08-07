//! atlarix-sandbox-linux — Landlock write-confining sandbox helper for Atlarix
//! `run_command`, the Linux sibling of `native/atlarix-sandbox` (Windows).
//!
//! Policy (identical to the macOS Seatbelt / Windows AppContainer helpers):
//! confine file WRITES to the workspace + the given writable roots (caches/temp);
//! reads stay broad; NETWORK STAYS ON (Landlock governs the filesystem only).
//!
//! Contract (what `wrap-command.ts` calls):
//!   atlarix-sandbox-linux --workspace <dir> [--writable <dir>]... \
//!       [--read-only] -- <command>
//! Exit code = the wrapped command's exit code; stdout/stderr pass through.
//!
//! Best-effort: uses the most capable Landlock ABI the running kernel supports
//! and degrades gracefully on older kernels. If Landlock is unavailable the
//! command still runs, unconfined — the harness approval gate is the other layer.
//!
//! Build: `cargo build --release` (Linux CI job).
//!
//! DELETED (v14.26.0): a feature-gated seccomp(SECCOMP_RET_TRACE) + ptrace supervisor
//! that recorded denied write paths to a `--deny-report` file, so
//! escalation-on-denial could name the exact path even when the failing tool did not
//! print it. It was 258 of this crate's 429 lines — 60% — and CI never compiled it
//! (`release.yml` builds default features only), so the highest-risk-per-line code in
//! the repo was the only code no automated process type-checked. It was also never
//! consumed: `--deny-report` appeared nowhere in `src/`.
//!
//! Landlock was always the security boundary and still is; the supervisor only
//! improved DIAGNOSTICS, on one OS. That gap is now closed on all three platforms in
//! user space by `src/lib/sandbox/sandbox-failure-context.ts`, which tells the model
//! the sandbox was applied and what its writable roots were, and lets the model read
//! the command's own error. Git history keeps the supervisor if a real report ever
//! justifies it.

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
    /// Shell to exec, from `--shell`. Defaults to `/bin/sh`.
    ///
    /// Without this the helper always used `/bin/sh` while `wrap-command.ts` resolves
    /// the user's preferred shell (bash) for UNsandboxed runs — so a command using
    /// bashisms worked unsandboxed and failed sandboxed. A sandbox must change
    /// permissions, not language semantics.
    shell: String,
    command: String,
}

fn parse_args() -> Args {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut workspace = String::new();
    let mut writable: Vec<String> = Vec::new();
    let mut read_only = false;
    let mut shell = String::from("/bin/sh");
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
            "--shell" => {
                i += 1;
                if let Some(s) = argv.get(i) {
                    if !s.is_empty() {
                        shell = s.clone();
                    }
                }
            }
            "--read-only" => {
                read_only = true;
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
        shell,
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
    // V4, not V2. `AccessFs::from_write` gains rights per ABI:
    //   V2 = V1 | Refer            (no Truncate — the bug this fixes)
    //   V3/V4 = V2 | Truncate      (Linux 6.2 / 6.7)
    //   V5+   = V4 | IoctlDev      (Linux 6.10)
    //
    // Pinning V2 left `LANDLOCK_ACCESS_FS_TRUNCATE` OUT of the handled set, so
    // truncation was never confined: `truncate -s 0 ~/.ssh/id_rsa` succeeded
    // outside the writable roots. Shell redirection was always safe (that is
    // `open(O_TRUNC)`, gated by WriteFile), but `truncate(2)` works by path and
    // needs no writable fd, so it walked straight through.
    //
    // Deliberately NOT V5: that adds `IoctlDev` to the handled set, newly denying
    // ioctls on device files. That is speculative hardening with a real
    // compatibility risk — exactly the "sandbox breaks the toolchain" failure mode
    // being fixed on Windows in this same change. Revisit with a compat test.
    //
    // `Ruleset::default()` uses `CompatLevel::BestEffort` (the crate's `#[default]`),
    // so on a pre-6.2 kernel the unsupported rights are silently dropped rather
    // than erroring.
    let abi = ABI::V4;
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

    // Apply Landlock to self, then become the command. The ruleset is inherited
    // across exec, so the shell and everything it spawns stay confined.
    apply_landlock(&roots);
    let err = Command::new(&args.shell).arg("-c").arg(&args.command).exec();
    die(&format!("exec {} failed: {err}", args.shell));
}
