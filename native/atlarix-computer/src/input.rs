//! Mouse and keyboard, the screen lock, and the "user took control" check.

use crate::capture::{self, Space};
use crate::keys;
use crate::{Fail, Reply};
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::path::PathBuf;
use std::time::Duration;

/// How far the real cursor may drift from where we put it before we treat it
/// as the user's hand. Some platforms round our own moves by a pixel or two.
const TAKEOVER_PX: i32 = 8;
const DRAG_STEPS: i32 = 12;
/// Between typed characters (see "type", not Windows).
#[cfg_attr(windows, allow(dead_code))]
const TYPE_GAP_MS: u64 = 8;
/// After a paste, before the clipboard is put back (Windows).
#[cfg_attr(not(windows), allow(dead_code))]
const PASTE_SETTLE_MS: u64 = 400;

#[derive(Default)]
pub struct Session {
    enigo: Option<Enigo>,
    pub space: Option<Space>,
    /// Where we last left the cursor, in input coordinates.
    last: Option<(i32, i32)>,
    /// Where this op sent the cursor, if it moved it.
    moved: Option<(i32, i32)>,
    took_control: bool,
    lock: Option<File>,
}

fn lock_path() -> PathBuf {
    if let Some(p) = std::env::var_os("ATLARIX_COMPUTER_LOCK") {
        return PathBuf::from(p);
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_default();
    PathBuf::from(home).join(".atlarix").join("computer.lock")
}

fn arg<'a>(req: &'a Value, k: &str) -> Option<&'a Value> {
    req.get(k).filter(|v| !v.is_null())
}

fn num(req: &Value, k: &str) -> Result<f64, Fail> {
    arg(req, k).and_then(Value::as_f64).ok_or_else(|| Fail::new("bad_request", format!("missing number: {k}")))
}

fn button(req: &Value) -> Result<Button, Fail> {
    Ok(match arg(req, "button").and_then(Value::as_str).unwrap_or("left") {
        "left" => Button::Left,
        "right" => Button::Right,
        "middle" => Button::Middle,
        other => return Err(Fail::new("bad_request", format!("unknown button: {other}"))),
    })
}

fn input_fail(e: impl std::fmt::Display) -> Fail {
    if cfg!(target_os = "macos") && !crate::permissions::accessibility_granted() {
        return Fail::new("permission", crate::permissions::not_allowed("Accessibility"));
    }
    Fail::new("failed", format!("input failed: {e}"))
}

impl Session {
    /// One driver per machine. The OS drops the lock when this process exits,
    /// however it exits, so a crashed session never leaves the screen locked.
    pub fn lock(&mut self) -> Result<(), Fail> {
        self.lock_at(&lock_path())
    }

    fn lock_at(&mut self, path: &std::path::Path) -> Result<(), Fail> {
        if self.lock.is_some() {
            return Ok(());
        }
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let f = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path)
            .map_err(|e| Fail::new("failed", format!("cannot open {}: {e}", path.display())))?;
        match f.try_lock() {
            Ok(()) => {
                self.lock = Some(f);
                Ok(())
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                Err(Fail::new("busy", "another Atlarix session is controlling the screen"))
            }
            Err(std::fs::TryLockError::Error(e)) => Err(Fail::new("failed", format!("cannot lock {}: {e}", path.display()))),
        }
    }

    /// Let another session drive. The OS unlocks when the file closes.
    pub fn release(&mut self) {
        self.lock = None;
    }

    /// A new turn: forget where we left the cursor, so the user's own mouse
    /// use between turns is not mistaken for a takeover.
    pub fn reset(&mut self) {
        self.last = None;
        self.took_control = false;
    }

    fn enigo(&mut self) -> Result<&mut Enigo, Fail> {
        if self.enigo.is_none() {
            self.enigo = Some(Enigo::new(&Settings::default()).map_err(input_fail)?);
        }
        Ok(self.enigo.as_mut().expect("just set"))
    }

    fn space(&mut self) -> Result<Space, Fail> {
        if let Some(s) = self.space {
            return Ok(s);
        }
        let s = capture::space(capture::DEFAULT_EDGE)?;
        self.space = Some(s);
        Ok(s)
    }

    fn check_takeover(&mut self) -> Result<(), Fail> {
        if self.took_control {
            return Err(took_control());
        }
        let Some((lx, ly)) = self.last else { return Ok(()) };
        // Where reading the cursor is impossible (some Wayland sessions), the
        // check cannot run; the host's own stop paths still work.
        let Ok(now) = self.enigo()?.location() else { return Ok(()) };
        if moved_by_user((lx, ly), now) {
            self.took_control = true;
            self.last = None;
            return Err(took_control());
        }
        Ok(())
    }

    /// Where we left the cursor: where we SENT it, not where it reads back.
    /// A posted move lands asynchronously (macOS), so reading the cursor right
    /// after it can return the position from before; the next check then saw
    /// our own move as the user's (E3: a false takeover in 3 of 6 runs).
    fn remember_cursor(&mut self) {
        let read = || self.enigo.as_ref().and_then(|e| e.location().ok());
        self.last = next_last(self.moved.take(), self.last, read);
    }

    fn move_to(&mut self, req: &Value, kx: &str, ky: &str) -> Result<(), Fail> {
        let (x, y) = self.space()?.to_input(num(req, kx)?, num(req, ky)?)?;
        self.enigo()?.move_mouse(x, y, Coordinate::Abs).map_err(input_fail)?;
        self.moved = Some((x, y));
        Ok(())
    }

    /// Windows: by paste. Injected Unicode keystrokes (VK_PACKET) are turned
    /// into characters only when the app reads them, from the most recently
    /// injected one, so a busy app reads later characters for earlier keys:
    /// "ABC" came out as "CCC" (A6, live in a VM), even one key at a time.
    /// The clipboard is put back as it was, text or image.
    #[cfg(windows)]
    fn type_text(&mut self, text: &str) -> Result<(), Fail> {
        let mut cb = arboard::Clipboard::new().map_err(|e| Fail::new("failed", format!("clipboard unavailable: {e}")))?;
        let saved_text = cb.get_text().ok();
        let saved_image = if saved_text.is_none() { cb.get_image().ok() } else { None };
        cb.set_text(text.to_owned()).map_err(|e| Fail::new("failed", format!("clipboard: {e}")))?;
        let e = self.enigo()?;
        e.key(enigo::Key::Control, Direction::Press).map_err(input_fail)?;
        let pasted = e.key(enigo::Key::Unicode('v'), Direction::Click);
        let _ = e.key(enigo::Key::Control, Direction::Release);
        pasted.map_err(input_fail)?;
        // Long enough for the app to read the clipboard before it is put back.
        std::thread::sleep(Duration::from_millis(PASTE_SETTLE_MS));
        let _ = match (saved_text, saved_image) {
            (Some(t), _) => cb.set_text(t),
            (None, Some(img)) => cb.set_image(img),
            (None, None) => cb.clear(),
        };
        Ok(())
    }

    /// Elsewhere one character at a time, which typed correctly on macOS.
    #[cfg(not(windows))]
    fn type_text(&mut self, text: &str) -> Result<(), Fail> {
        let e = self.enigo()?;
        let mut buf = [0u8; 4];
        for ch in text.chars() {
            e.text(ch.encode_utf8(&mut buf)).map_err(input_fail)?;
            std::thread::sleep(Duration::from_millis(TYPE_GAP_MS));
        }
        Ok(())
    }

    pub fn act(&mut self, op: &str, req: &Value) -> Reply {
        if op == "cursor" {
            let space = self.space()?;
            let (x, y) = self.enigo()?.location().map_err(input_fail)?;
            let (sx, sy) = space.to_shot(x, y);
            return Ok(json!({ "x": sx, "y": sy }));
        }
        self.check_takeover()?;
        self.moved = None;
        match op {
            "move" => self.move_to(req, "x", "y")?,
            "click" => {
                if arg(req, "x").is_some() {
                    self.move_to(req, "x", "y")?;
                }
                let b = button(req)?;
                let count = arg(req, "count").and_then(Value::as_u64).unwrap_or(1).clamp(1, 3);
                let e = self.enigo()?;
                for _ in 0..count {
                    e.button(b, Direction::Click).map_err(input_fail)?;
                }
            }
            "button" => {
                if arg(req, "x").is_some() {
                    self.move_to(req, "x", "y")?;
                }
                let b = button(req)?;
                let d = match arg(req, "direction").and_then(Value::as_str) {
                    Some("down") => Direction::Press,
                    Some("up") => Direction::Release,
                    _ => return Err(Fail::new("bad_request", "direction must be down or up")),
                };
                self.enigo()?.button(b, d).map_err(input_fail)?;
            }
            "drag" => {
                let space = self.space()?;
                let (x0, y0) = space.to_input(num(req, "x")?, num(req, "y")?)?;
                let (x1, y1) = space.to_input(num(req, "to_x")?, num(req, "to_y")?)?;
                let e = self.enigo()?;
                e.move_mouse(x0, y0, Coordinate::Abs).map_err(input_fail)?;
                e.button(Button::Left, Direction::Press).map_err(input_fail)?;
                // Intermediate moves: many apps ignore a drag that teleports.
                for i in 1..=DRAG_STEPS {
                    let x = x0 + (x1 - x0) * i / DRAG_STEPS;
                    let y = y0 + (y1 - y0) * i / DRAG_STEPS;
                    e.move_mouse(x, y, Coordinate::Abs).map_err(input_fail)?;
                    std::thread::sleep(Duration::from_millis(12));
                }
                e.button(Button::Left, Direction::Release).map_err(input_fail)?;
                self.moved = Some((x1, y1));
            }
            "type" => {
                let text = arg(req, "text").and_then(Value::as_str).ok_or_else(|| Fail::new("bad_request", "missing text"))?;
                self.type_text(text)?;
            }
            "key" => {
                let spec = arg(req, "combo").and_then(Value::as_str).ok_or_else(|| Fail::new("bad_request", "missing combo"))?;
                let combos = keys::parse(spec).map_err(|e| Fail::new("bad_request", e))?;
                if combos.iter().any(keys::is_stop_chord) {
                    return Err(Fail::new("refused", "that key combination is the stop shortcut"));
                }
                let hold = arg(req, "hold_ms").and_then(Value::as_u64).map(|ms| Duration::from_millis(ms.min(10_000)));
                let e = self.enigo()?;
                for c in &combos {
                    for m in &c.mods {
                        e.key(*m, Direction::Press).map_err(input_fail)?;
                    }
                    let r = match hold {
                        Some(d) => e.key(c.key, Direction::Press).and_then(|_| {
                            std::thread::sleep(d);
                            e.key(c.key, Direction::Release)
                        }),
                        None => e.key(c.key, Direction::Click),
                    };
                    // Release modifiers even if the key failed, or Ctrl stays down.
                    for m in c.mods.iter().rev() {
                        let _ = e.key(*m, Direction::Release);
                    }
                    r.map_err(input_fail)?;
                }
            }
            "scroll" => {
                if arg(req, "x").is_some() {
                    self.move_to(req, "x", "y")?;
                }
                let dy = arg(req, "dy").and_then(Value::as_i64).unwrap_or(0).clamp(-50, 50) as i32;
                let dx = arg(req, "dx").and_then(Value::as_i64).unwrap_or(0).clamp(-50, 50) as i32;
                let e = self.enigo()?;
                if dy != 0 {
                    e.scroll(dy, Axis::Vertical).map_err(input_fail)?;
                }
                if dx != 0 {
                    e.scroll(dx, Axis::Horizontal).map_err(input_fail)?;
                }
            }
            other => return Err(Fail::new("bad_request", format!("unknown op: {other}"))),
        }
        self.remember_cursor();
        Ok(json!({}))
    }
}

/// The user's hand, not ours: the cursor is more than TAKEOVER_PX from where
/// we left it.
fn moved_by_user(left: (i32, i32), now: (i32, i32)) -> bool {
    (now.0 - left.0).abs() > TAKEOVER_PX || (now.1 - left.1).abs() > TAKEOVER_PX
}

/// Our reference after an op: the target it moved to; else the previous one;
/// else (nothing known yet, nothing in flight) the cursor as it reads now.
fn next_last(
    moved: Option<(i32, i32)>,
    prev: Option<(i32, i32)>,
    read: impl FnOnce() -> Option<(i32, i32)>,
) -> Option<(i32, i32)> {
    moved.or(prev).or_else(read)
}

fn took_control() -> Fail {
    Fail::new("user_took_control", "the user moved the mouse and took control of the screen")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_driver_at_a_time_until_released() {
        let dir = std::env::temp_dir().join(format!("atlarix-computer-test-{}", std::process::id()));
        let path = dir.join("computer.lock");
        let (mut a, mut b) = (Session::default(), Session::default());
        assert!(a.lock_at(&path).is_ok());
        assert!(a.lock_at(&path).is_ok(), "re-locking our own lock is a no-op");
        let busy = b.lock_at(&path).err().expect("second driver must be refused");
        assert_eq!(busy.code, "busy");
        a.release();
        assert!(b.lock_at(&path).is_ok(), "released lock is free");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// E3, replayed with ai-26's numbers: a 1280x800 screenshot over a
    /// 1440x900-point display, move to (500,350), then a read-back that still
    /// shows where the cursor was before the move.
    #[test]
    fn our_own_move_is_never_a_takeover_even_if_the_read_back_is_stale() {
        let space = crate::capture::Space { mon_x: 0, mon_y: 0, mon_w: 1440, mon_h: 900, out_w: 1280, out_h: 800 };
        let target = space.to_input(500.0, 350.0).ok().unwrap();
        assert_eq!(target, (563, 394));
        let stale_read = || Some((900, 120));
        let left = next_last(Some(target), None, stale_read).unwrap();
        assert_eq!(left, (563, 394), "the reference is where we sent it");
        // The next op sees the cursor where the first move put it.
        assert!(!moved_by_user(left, (563, 394)));
        // The old code took the read-back as the reference and called this a takeover.
        assert!(moved_by_user((900, 120), (563, 394)));
    }

    #[test]
    fn a_real_hand_still_counts_and_ops_without_a_move_keep_the_reference() {
        assert!(moved_by_user((563, 394), (40, 40)));
        assert!(!moved_by_user((563, 394), (566, 390)), "a few pixels of rounding is not a hand");
        assert_eq!(next_last(None, Some((10, 10)), || Some((99, 99))), Some((10, 10)));
        assert_eq!(next_last(None, None, || Some((99, 99))), Some((99, 99)));
    }

    #[test]
    fn takeover_refuses_until_reset() {
        let mut s = Session { took_control: true, ..Session::default() };
        assert_eq!(s.check_takeover().err().map(|f| f.code), Some("user_took_control"));
        s.reset();
        assert!(s.check_takeover().is_ok());
    }
}
