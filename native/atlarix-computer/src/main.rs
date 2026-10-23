//! atlarix-computer: the one local executor for computer use.
//!
//! The host (app, CLI, ACP) spawns this once and talks JSON lines over stdio:
//! one request per line in, one response per line out, matched by `id`.
//!
//!   {"id":1,"op":"screenshot","max_long_edge":1280}
//!   {"id":1,"ok":true,"width":1280,"height":800,"mime":"image/jpeg","data":"..."}
//!   {"id":2,"op":"click","x":640,"y":400}
//!   {"id":2,"ok":false,"code":"user_took_control","error":"..."}
//!
//! Coordinates are always in SCREENSHOT space: the pixel grid of the last image
//! this process returned (or would return, see `display`). Mapping them onto the
//! real display is done here, once, so no host has to know about Retina scale or
//! Windows DPI.
//!
//! Two safety properties live here because only this process can enforce them
//! for every surface at once:
//! - one driver at a time: an OS file lock taken by the first input op, held
//!   until the host sends `release` (it does after a short idle) or we die;
//! - stop by moving the mouse: if the real cursor is not where we last put it,
//!   the user has taken over and every input op refuses until `reset`.

mod capture;
mod input;
mod keys;
mod permissions;

use serde_json::{json, Value};
use std::io::{BufRead, Write};

pub struct Fail {
    pub code: &'static str,
    pub error: String,
}

impl Fail {
    pub fn new(code: &'static str, error: impl Into<String>) -> Self {
        Fail { code, error: error.into() }
    }
}

pub type Reply = Result<Value, Fail>;

fn main() {
    #[cfg(windows)]
    unsafe {
        // Without this, capture returns physical pixels while SendInput takes
        // DPI-virtualised ones, and every click on a 150% display lands short.
        use windows::Win32::UI::HiDpi::{
            SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        };
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    if std::env::args().any(|a| a == "--version") {
        println!("atlarix-computer {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let mut session = input::Session::default();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let (id, reply) = match serde_json::from_str::<Value>(&line) {
            Ok(req) => {
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                (id, dispatch(&mut session, &req))
            }
            Err(e) => (Value::Null, Err(Fail::new("bad_request", format!("not JSON: {e}")))),
        };
        let mut out = match reply {
            Ok(Value::Object(mut map)) => {
                map.insert("ok".into(), Value::Bool(true));
                Value::Object(map)
            }
            Ok(_) => json!({ "ok": true }),
            Err(f) => json!({ "ok": false, "code": f.code, "error": f.error }),
        };
        out["id"] = id;
        if writeln!(stdout, "{out}").and_then(|_| stdout.flush()).is_err() {
            break; // host went away
        }
    }
}

fn dispatch(s: &mut input::Session, req: &Value) -> Reply {
    let op = req.get("op").and_then(Value::as_str).unwrap_or("");
    match op {
        "permissions" => Ok(permissions::read(req.get("request").and_then(Value::as_str))),
        "reset" => {
            s.reset();
            Ok(json!({}))
        }
        "release" => {
            s.release();
            Ok(json!({}))
        }
        // Looking takes no lock; only driving the mouse and keyboard does.
        "display" | "screenshot" => {
            let edge = req.get("max_long_edge").and_then(Value::as_u64).unwrap_or(capture::DEFAULT_EDGE as u64) as u32;
            if op == "display" {
                let space = capture::space(edge)?;
                s.space = Some(space);
                Ok(json!({ "width": space.out_w, "height": space.out_h }))
            } else {
                let (space, shot) = capture::screenshot(edge)?;
                s.space = Some(space);
                Ok(shot)
            }
        }
        "click" | "move" | "drag" | "type" | "key" | "scroll" | "cursor" | "button" => {
            s.lock()?;
            s.act(op, req)
        }
        "" => Err(Fail::new("bad_request", "missing op")),
        other => Err(Fail::new("bad_request", format!("unknown op: {other}"))),
    }
}
