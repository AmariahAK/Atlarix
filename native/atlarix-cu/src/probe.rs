//! Is the private SkyLight input SPI still there?
//!
//! cua-driver delivers background mouse/keyboard on macOS through
//! `SLPSPostEventRecordTo`, which lives in the private SkyLight framework. That is
//! how it posts to a target pid without warping the real cursor — and it is also
//! the single thing most likely to break on a macOS update, because Apple owes
//! private symbols nothing.
//!
//! So we probe, and route rather than patch: cua-driver stays unmodified (any fork
//! would have to be re-merged on every pin bump), and when the SPI is gone we send
//! input through the PUBLIC `CGEventPostToPid` instead — see `post.rs` for what
//! that can and cannot do.
//!
//! DELIBERATELY SYMBOL-PRESENCE ONLY, AND SIDE-EFFECT FREE. `dlopen` + `dlsym`
//! costs microseconds and catches the likely break (a removed or renamed symbol).
//! What it cannot distinguish is "present" from "present but now a no-op or newly
//! gated" — that needs a real event, which has user-visible consequences, so the
//! behavioural half is a zero-delta scroll posted to our OWN pid from the app, not
//! from here. It is time-boxed, runs once per session, and **cannot run in CI**
//! (no GUI session), which is stated here so a green CI badge is never read as
//! "input works".

use std::ffi::CString;

const SKYLIGHT: &str =
    "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight";

/// The two symbols cua-driver's macOS input path needs.
const SYMBOLS: &[&str] = &["SLPSPostEventRecordTo", "SLSMainConnectionID"];

fn dlsym_present(handle: *mut libc::c_void, name: &str) -> bool {
    let Ok(c) = CString::new(name) else { return false };
    // SAFETY: `handle` came from a successful dlopen; `c` is a valid NUL-terminated
    // C string that outlives the call. We only test the returned pointer for null
    // and never call through it.
    unsafe { !libc::dlsym(handle, c.as_ptr()).is_null() }
}

pub fn run() -> serde_json::Value {
    let path = match CString::new(SKYLIGHT) {
        Ok(p) => p,
        Err(_) => {
            return serde_json::json!({
                "ok": false,
                "error": "SkyLight path contained an interior NUL"
            })
        }
    };

    // RTLD_LAZY: we resolve symbols ourselves and never call them, so binding
    // eagerly would only add failure modes.
    // SAFETY: `path` is a valid NUL-terminated C string; a failed dlopen returns
    // null, which is checked before use.
    let handle = unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_LAZY) };
    if handle.is_null() {
        return serde_json::json!({
            "ok": true,
            "skylight_loaded": false,
            "symbols": {},
            "rung": "public-fallback",
            "note": "SkyLight did not load; use the public CGEventPostToPid path"
        });
    }

    let mut symbols = serde_json::Map::new();
    let mut all_present = true;
    for name in SYMBOLS {
        let present = dlsym_present(handle, name);
        all_present &= present;
        symbols.insert((*name).to_string(), serde_json::Value::Bool(present));
    }

    // Not closed on the success path on purpose: SkyLight is a system framework
    // that the window server has loaded anyway, and dlclose on a framework whose
    // initialisers have run is a needless risk in a process that is about to exit.

    serde_json::json!({
        "ok": true,
        "skylight_loaded": true,
        "symbols": symbols,
        // The rung the app should use. Named rather than boolean so a log line
        // says which path is live — the `windowsSandboxUsable` doctrine: a control
        // that degrades silently must be observable.
        "rung": if all_present { "driver-spi" } else { "public-fallback" },
        "note": "symbol presence only; delivery is confirmed by the app's zero-delta self-scroll"
    })
}
