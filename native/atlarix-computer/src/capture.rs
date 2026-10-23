//! Screenshots of the primary display, already sized for a model.

use crate::Fail;
use base64::Engine;
use serde_json::{json, Value};
use xcap::Monitor;

pub const DEFAULT_EDGE: u32 = 1280;
const MIN_EDGE: u32 = 320;
const MAX_EDGE: u32 = 2000;
const JPEG_QUALITY: u8 = 80;

/// The display in input coordinates, and the screenshot grid laid over it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Space {
    pub mon_x: i32,
    pub mon_y: i32,
    pub mon_w: u32,
    pub mon_h: u32,
    pub out_w: u32,
    pub out_h: u32,
}

impl Space {
    /// Screenshot pixel -> input coordinate (points on macOS, pixels elsewhere).
    pub fn to_input(&self, x: f64, y: f64) -> Result<(i32, i32), Fail> {
        if !(x.is_finite() && y.is_finite()) || x < 0.0 || y < 0.0 || x >= self.out_w as f64 || y >= self.out_h as f64 {
            return Err(Fail::new(
                "bad_request",
                format!("({x}, {y}) is outside the {}x{} screenshot", self.out_w, self.out_h),
            ));
        }
        let ix = self.mon_x as f64 + x * self.mon_w as f64 / self.out_w as f64;
        let iy = self.mon_y as f64 + y * self.mon_h as f64 / self.out_h as f64;
        Ok((ix.round() as i32, iy.round() as i32))
    }

    /// Input coordinate -> screenshot pixel (for `cursor`).
    pub fn to_shot(&self, x: i32, y: i32) -> (i64, i64) {
        let sx = (x - self.mon_x) as f64 * self.out_w as f64 / self.mon_w as f64;
        let sy = (y - self.mon_y) as f64 * self.out_h as f64 / self.mon_h as f64;
        (sx.round() as i64, sy.round() as i64)
    }
}

/// Fit (w, h) inside a square of `edge`, keeping the aspect ratio. Never upscales.
pub fn fit(w: u32, h: u32, edge: u32) -> (u32, u32) {
    let edge = edge.clamp(MIN_EDGE, MAX_EDGE);
    let long = w.max(h);
    if long <= edge {
        return (w, h);
    }
    let k = edge as f64 / long as f64;
    (((w as f64 * k).round() as u32).max(1), ((h as f64 * k).round() as u32).max(1))
}

fn primary() -> Result<Monitor, Fail> {
    let all = Monitor::all().map_err(|e| capture_fail(&e.to_string()))?;
    let mut first = None;
    for m in all {
        if m.is_primary().unwrap_or(false) {
            return Ok(m);
        }
        first.get_or_insert(m);
    }
    first.ok_or_else(|| Fail::new("failed", "no display found"))
}

fn geometry(m: &Monitor) -> Result<(i32, i32, u32, u32), Fail> {
    let g = || -> Result<_, xcap::XCapError> { Ok((m.x()?, m.y()?, m.width()?, m.height()?)) };
    g().map_err(|e| capture_fail(&e.to_string()))
}

/// Capture failures on macOS are almost always the missing Screen Recording
/// grant; say so, because the raw error does not.
fn capture_fail(raw: &str) -> Fail {
    if cfg!(target_os = "macos") && !crate::permissions::screen_granted() {
        return Fail::new("permission", crate::permissions::not_allowed("Screen Recording"));
    }
    Fail::new("failed", format!("screen capture failed: {raw}"))
}

pub fn space(edge: u32) -> Result<Space, Fail> {
    let m = primary()?;
    let (mon_x, mon_y, mon_w, mon_h) = geometry(&m)?;
    let (out_w, out_h) = fit(mon_w, mon_h, edge);
    Ok(Space { mon_x, mon_y, mon_w, mon_h, out_w, out_h })
}

pub fn screenshot(edge: u32) -> Result<(Space, Value), Fail> {
    let m = primary()?;
    let (mon_x, mon_y, mon_w, mon_h) = geometry(&m)?;
    let img = m.capture_image().map_err(|e| capture_fail(&e.to_string()))?;
    // Fit against the LOGICAL size: on Retina the capture is 2x, and a model
    // looking at 1280 logical-wide pixels gets the same picture for half the tokens.
    let (out_w, out_h) = fit(mon_w, mon_h, edge);
    let small = if img.width() == out_w && img.height() == out_h {
        img
    } else {
        image::imageops::resize(&img, out_w, out_h, image::imageops::FilterType::Triangle)
    };
    let rgb = image::DynamicImage::ImageRgba8(small).to_rgb8();
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
        .encode_image(&rgb)
        .map_err(|e| Fail::new("failed", format!("jpeg encode failed: {e}")))?;
    let space = Space { mon_x, mon_y, mon_w, mon_h, out_w, out_h };
    let data = base64::engine::general_purpose::STANDARD.encode(&jpeg);
    Ok((space, json!({ "width": out_w, "height": out_h, "mime": "image/jpeg", "data": data })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_keeps_aspect_and_never_upscales() {
        assert_eq!(fit(2880, 1800, 1280), (1280, 800));
        assert_eq!(fit(1080, 1920, 1280), (720, 1280));
        assert_eq!(fit(800, 600, 1280), (800, 600));
        // out-of-range edges are clamped, not trusted
        assert_eq!(fit(4000, 2000, 99_999), (2000, 1000));
        assert_eq!(fit(4000, 2000, 1), (320, 160));
    }

    #[test]
    fn mapping_round_trips_on_a_scaled_secondary_origin() {
        let s = Space { mon_x: -1440, mon_y: 0, mon_w: 1440, mon_h: 900, out_w: 1280, out_h: 800 };
        assert_eq!(s.to_input(0.0, 0.0).ok(), Some((-1440, 0)));
        assert_eq!(s.to_input(640.0, 400.0).ok(), Some((-720, 450)));
        assert_eq!(s.to_shot(-720, 450), (640, 400));
    }

    #[test]
    fn mapping_refuses_points_outside_the_screenshot() {
        let s = Space { mon_x: 0, mon_y: 0, mon_w: 1440, mon_h: 900, out_w: 1280, out_h: 800 };
        assert!(s.to_input(1280.0, 10.0).is_err());
        assert!(s.to_input(-1.0, 10.0).is_err());
        assert!(s.to_input(f64::NAN, 10.0).is_err());
    }
}
