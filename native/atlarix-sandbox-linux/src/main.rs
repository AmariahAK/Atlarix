//! atlarix-sandbox-linux — Landlock write-confining sandbox helper for Atlarix
//! `run_command`, the Linux sibling of `native/atlarix-sandbox` (Windows).
//!
//! Policy (identical to the macOS Seatbelt / Windows AppContainer helpers):
//! confine file WRITES to the workspace + the given writable roots (caches/temp);
//! reads stay broad; NETWORK STAYS ON (Landlock governs the filesystem only, so
//! nothing extra is needed to keep network working).
//!
//! Contract (what `wrap-command.ts` calls):
//!   atlarix-sandbox-linux --workspace <dir> [--writable <dir>]... -- <command>
//! Exit code = the wrapped command's exit code; stdout/stderr pass through.
//!
//! Best-effort: uses the most capable Landlock ABI the running kernel supports
//! and degrades gracefully on older kernels (Landlock ABI v1 = 5.13; ideally
//! v2 = 5.19 for create/remove parity). If Landlock is unavailable the command
//! still runs, unconfined — the harness approval gate is the other layer.
//!
//! Build: `cargo build --release` in the Linux CI job. Single small binary.

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
    command: String,
}

fn parse_args() -> Args {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut workspace = String::new();
    let mut writable: Vec<String> = Vec::new();
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
        command,
    }
}

/// Apply the Landlock ruleset to THIS process (inherited across the exec below).
/// Only WRITE-family accesses are "handled" (deny-by-default); reads/exec are not
/// handled, so they stay unrestricted everywhere. Writes are then granted back
/// under the workspace + writable roots. On any Landlock error we log and return
/// (run unconfined) — matching the "sandbox never breaks the workflow" policy.
fn apply_landlock(workspace: &str, writable: &[String]) {
    // Request the newest ABI; `Ruleset::default()` is best-effort, so this clamps
    // down to whatever the running kernel actually supports.
    let abi = ABI::V2;
    let write = AccessFs::from_write(abi);

    // Existing writable roots only (a cache dir may not exist yet — skip it,
    // mirroring bwrap's `--bind-try`). Workspace first.
    let roots: Vec<String> = std::iter::once(workspace.to_string())
        .chain(writable.iter().cloned())
        .filter(|p| Path::new(p).exists())
        .collect();

    let result = Ruleset::default()
        .handle_access(write)
        .and_then(|r| r.create())
        .and_then(|r| r.add_rules(path_beneath_rules(&roots, write)))
        .and_then(|r| r.restrict_self());

    if let Err(e) = result {
        eprintln!(
            "atlarix-sandbox-linux: Landlock unavailable or failed ({e:?}); running unconfined"
        );
    }
}

fn main() {
    let args = parse_args();
    apply_landlock(&args.workspace, &args.writable);
    // Replace this process with the command (in a shell, like the AppContainer
    // helper's `cmd.exe /c`). The Landlock domain is inherited across execve, and
    // the shell's exit code becomes ours. `exec` only returns on failure.
    let err = Command::new("/bin/sh")
        .arg("-c")
        .arg(&args.command)
        .exec();
    die(&format!("exec /bin/sh failed: {err}"));
}
