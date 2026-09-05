//! macOS input through the PUBLIC `CGEventPostToPid` — rung 3 of the ladder.
//!
//! Reached only when `probe.rs` says the private SkyLight symbol is gone. The whole
//! ladder, so the choice here is legible:
//!
//! | rung | mechanism | background? | when |
//! |---|---|---|---|
//! | 1 | cua-driver AX path (`AXUIElementPerformAction`) | yes — posts no events at all | always preferred; survives ANY SPI change |
//! | 2 | cua-driver pixel path (`SLPSPostEventRecordTo`) | yes | probe green |
//! | 3 | **this** (`CGEventPostToPid`, public since 10.11) | keyboard yes; mouse unreliable | probe red |
//! | 4 | structured refusal | — | probe red AND the action is a pixel click |
//!
//! # Why this is not a blanket replacement, which is the point of rung 4
//!
//! `CGEventPostToPid` delivers KEYBOARD events to a background process reliably —
//! the event goes to the process, and the focused view inside it handles it. A
//! MOUSE event is different: it carries a screen location, and a well-behaved app
//! hit-tests that location against its own window. Post a click at coordinates the
//! target does not own, or while another window is above it, and the app may ignore
//! it, or handle it somewhere else. `anthropics/mac-cua` takes this route and lives
//! with the same caveat.
//!
//! So on probe failure we keep AX actions and keyboard, and **refuse pixel clicks
//! explicitly**. A wrong click inside someone's application is worse than a
//! refusal: a refusal costs a turn, a misplaced click can send a message, delete a
//! row, or accept a dialog.

use objc2_core_foundation::CFRetained;
use objc2_core_graphics::{
    CGEvent, CGEventFlags, CGEventSource, CGEventSourceStateID, CGScrollEventUnit,
};
use serde_json::{json, Value};

fn arg_value(args: &[String], name: &str) -> Option<String> {
    let idx = args.iter().position(|a| a == name)?;
    args.get(idx + 1).cloned()
}

/// Virtual keycodes for the closed key set the `computer` tool exposes.
///
/// A CLOSED SET IS THE DESTRUCTIVE-COMBO GATE. There is no free-form combo form
/// anywhere in this helper or in the tool schema, so `cmd+Q`, `alt+F4` and
/// force-quit are not expressible — not filtered, unexpressible. Adding a general
/// "modifier + any key" parameter would quietly undo that, so don't.
fn keycode(name: &str) -> Option<(u16, CGEventFlags)> {
    let none = CGEventFlags::empty();
    Some(match name {
        "enter" | "return" => (0x24, none),
        "tab" => (0x30, none),
        "escape" => (0x35, none),
        "backspace" | "delete" => (0x33, none),
        "forward_delete" => (0x75, none),
        "up" => (0x7e, none),
        "down" => (0x7d, none),
        "left" => (0x7b, none),
        "right" => (0x7c, none),
        "home" => (0x73, none),
        "end" => (0x77, none),
        "page_up" => (0x74, none),
        "page_down" => (0x79, none),
        // The four editing combos, enumerated rather than composed.
        "select_all" => (0x00, CGEventFlags::MaskCommand), // cmd+A
        "copy" => (0x08, CGEventFlags::MaskCommand),       // cmd+C
        "paste" => (0x09, CGEventFlags::MaskCommand),      // cmd+V
        "cut" => (0x07, CGEventFlags::MaskCommand),        // cmd+X
        _ => return None,
    })
}

pub fn run(args: &[String]) -> Result<Value, String> {
    let action = args
        .get(1)
        .filter(|a| !a.starts_with("--"))
        .ok_or_else(|| "`post` needs an action: key | scroll".to_string())?;

    let pid: i32 = arg_value(args, "--pid")
        .ok_or_else(|| "`post` needs --pid <pid>".to_string())?
        .parse()
        .map_err(|_| "--pid must be an integer".to_string())?;

    match action.as_str() {
        "key" => {
            let name = arg_value(args, "--key")
                .ok_or_else(|| "`post key` needs --key <name>".to_string())?;
            let (code, flags) = keycode(&name).ok_or_else(|| {
                format!(
                    "{name:?} is not in the supported key set. The set is closed on purpose so \
                     no destructive combination is expressible. Atlarix will not do this — do \
                     not retry with a different spelling."
                )
            })?;
            post_key(pid, code, flags)?;
            Ok(json!({ "ok": true, "posted": "key", "key": name, "pid": pid, "rung": "public-fallback" }))
        }

        "scroll" => {
            let dy: i32 = arg_value(args, "--dy").unwrap_or_else(|| "0".into()).parse()
                .map_err(|_| "--dy must be an integer".to_string())?;
            let dx: i32 = arg_value(args, "--dx").unwrap_or_else(|| "0".into()).parse()
                .map_err(|_| "--dx must be an integer".to_string())?;
            post_scroll(pid, dx, dy)?;
            Ok(json!({ "ok": true, "posted": "scroll", "dx": dx, "dy": dy, "pid": pid, "rung": "public-fallback" }))
        }

        // RUNG 4. Stated as a policy refusal with the permanent-category wording, so
        // the model stops instead of probing for a spelling that works.
        "click" | "left_click" | "right_click" | "double_click" | "drag" | "move" => Err(format!(
            "Pixel {action} is not available on this machine: the background input SPI is \
             missing, and the public fallback cannot place a mouse event reliably inside \
             another app's window — it would click the wrong thing rather than fail. \
             Atlarix will not do this. Do not retry — read the window again and act on an \
             element `ref`, which uses the accessibility path and needs no coordinates."
        )),

        other => Err(format!("unknown post action {other:?}; expected key or scroll")),
    }
}

/// A synthetic event source. `CombinedSessionState` is the conventional choice for
/// posted input: it inherits the session's modifier state, so a posted `cmd+C` does
/// not fight a modifier the user is physically holding.
fn source() -> Result<CFRetained<CGEventSource>, String> {
    // objc2-core-graphics exposes these as SAFE fns — they take `Option<&…>` and
    // return `Option<CFRetained<…>>`, so null is modelled in the type rather than
    // left to the caller. Hence no `unsafe` block anywhere in this file; a
    // creation failure becomes an error string instead of a deref.
    CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .ok_or_else(|| "CGEventSourceCreate returned null".to_string())
}

fn post_key(pid: i32, code: u16, flags: CGEventFlags) -> Result<(), String> {
    let src = source()?;
    // Down THEN up, always both: posting only the keydown leaves the target
    // believing the key is still held, which then poisons every subsequent
    // keystroke it receives.
    let down = CGEvent::new_keyboard_event(Some(&src), code, true)
        .ok_or_else(|| "CGEventCreateKeyboardEvent(down) returned null".to_string())?;
    if !flags.is_empty() {
        CGEvent::set_flags(Some(&down), flags);
    }
    CGEvent::post_to_pid(pid, Some(&down));

    let up = CGEvent::new_keyboard_event(Some(&src), code, false)
        .ok_or_else(|| "CGEventCreateKeyboardEvent(up) returned null".to_string())?;
    if !flags.is_empty() {
        CGEvent::set_flags(Some(&up), flags);
    }
    CGEvent::post_to_pid(pid, Some(&up));
    Ok(())
}

fn post_scroll(pid: i32, dx: i32, dy: i32) -> Result<(), String> {
    let src = source()?;
    // Line units rather than pixel units, so the target scrolls by its own notion
    // of a line — the same amount a keyboard page/arrow scroll would move it.
    //
    // A ZERO-DELTA SCROLL IS THE ONE GENUINELY INERT INPUT EVENT, which is why the
    // app's behavioural probe posts one of these to its OWN pid: it proves delivery
    // without changing anything on screen. Do not "optimise" a zero delta away.
    let ev = CGEvent::new_scroll_wheel_event2(Some(&src), CGScrollEventUnit::Line, 2, dy, dx, 0)
        .ok_or_else(|| "CGEventCreateScrollWheelEvent2 returned null".to_string())?;
    CGEvent::post_to_pid(pid, Some(&ev));
    Ok(())
}
