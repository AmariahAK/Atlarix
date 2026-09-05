//! OS-native OCR: macOS Vision, Windows `Windows.Media.Ocr`.
//!
//! Tier 3 of the computer-use read. Tiers 1 and 2 (accessibility refs, and refs
//! plus an annotated image) cover apps that expose a tree; this covers the ones
//! that draw their own surface — a CapCut timeline, an OBS preview, Excel's cell
//! grid — where there is nothing to address and pixels are all there is.
//!
//! # The output contract
//!
//! Identical JSON on every platform, so the TypeScript side has one parser:
//!
//! ```json
//! { "width": 3024, "height": 1890, "scale": 2.0,
//!   "words": [{ "text": "Save", "x": 120, "y": 480, "w": 42, "h": 18, "conf": 0.97 }] }
//! ```
//!
//! **Coordinates are IMAGE PIXELS, with `scale` carried alongside — never points.**
//! The bug that prevents: a Retina capture is 2× the point geometry, so handing a
//! model pixel coordinates that are then interpreted as screen points puts every
//! click at half the intended position. Carrying `scale` makes the conversion a
//! stated step instead of an assumption, and the overlay consumes the same value.
//!
//! Origin is TOP-LEFT, because that is what every consumer here uses. Vision
//! reports normalised bottom-left boxes, so that conversion happens below rather
//! than leaking outward.
//!
//! # PASS A WINDOW, NEVER THE WHOLE DISPLAY
//!
//! Measured on 2026-09-04 against Vision, same text at the same pixel size, only
//! the framing changed:
//!
//! | input | result |
//! |---|---|
//! | 3024×1890 full-screen capture, 24px labels | **1 word**, `"Epоnся"`, confidence **0.3** — garbage |
//! | 800×700 crop of the same pixels | **6/6 words**, confidence **1.0** each |
//!
//! And note `minimumTextHeight` was NOT the limiter in the failing case: 24/1890 is
//! 0.0127, comfortably above the 0.005 we set. Vision downscales a large input
//! internally, and on a full Retina screen that reduces 12pt UI text below
//! legibility before recognition even starts. No error, no warning — just one
//! nonsense observation, which is worse than an empty result because it looks like
//! an answer.
//!
//! So the caller MUST crop to the target window before calling us — cua-driver's
//! `zoom` (a cropped region with 20% padding) or a window-scoped capture, not
//! `get_desktop_state`. Two consequences the caller owns: add the crop's origin
//! back to every word's `x`/`y` to get screen coordinates, and keep `scale`
//! attached through that arithmetic.
//!
//! Do not "simplify" this by feeding a full screenshot. It will appear to work —
//! it returns a word — and it will be wrong.

use serde_json::{json, Value};

/// A recognised word in image-pixel coordinates, origin top-left.
pub struct Word {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub conf: f64,
}

pub fn to_json(width: u32, height: u32, scale: f64, words: &[Word]) -> Value {
    json!({
        "ok": true,
        "width": width,
        "height": height,
        "scale": scale,
        "words": words.iter().map(|w| json!({
            "text": w.text,
            "x": w.x.round(),
            "y": w.y.round(),
            "w": w.w.round(),
            "h": w.h.round(),
            "conf": (w.conf * 1000.0).round() / 1000.0,
        })).collect::<Vec<_>>(),
    })
}

/// The self-test fixture: a PNG containing exactly this string.
///
/// Embedded rather than rendered at runtime on purpose — a renderer would drag in
/// a text-layout API and make the assertion depend on which fonts the machine has.
/// A fixed image makes the check deterministic AND headless-safe: neither Vision
/// nor Windows.Media.Ocr needs a GUI session or a TCC grant, so this is the one
/// genuinely behavioural computer-use assertion CI can run on every release.
const SELF_TEST_PNG: &[u8] = include_bytes!("../assets/ocr-self-test.png");
const SELF_TEST_TEXT: &str = "ATLARIX OCR 42";

pub fn run(path: &str) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    if bytes.len() < 8 || &bytes[0..4] != b"\x89PNG" {
        return Err(format!(
            "{path} is not a PNG (first bytes {:02x?}) — the caller writes captures with \
             cua-driver's `--screenshot-out-file`, which emits PNG",
            &bytes[..bytes.len().min(4)]
        ));
    }
    recognize(&bytes)
}

pub fn self_test() -> Result<Value, String> {
    let report = recognize(SELF_TEST_PNG)?;
    let found: String = report["words"]
        .as_array()
        .map(|ws| {
            ws.iter()
                .filter_map(|w| w["text"].as_str())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();

    // Compare on alphanumerics only. Engines differ on spacing and on whether a
    // line is one observation or several, and asserting the exact string would make
    // this brittle for no gain — what we are proving is that the OS engine is
    // present and our binding returns its text.
    let norm = |s: &str| {
        s.chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_uppercase()
    };
    if !norm(&found).contains(&norm(SELF_TEST_TEXT)) {
        return Err(format!(
            "OCR self-test FAILED: expected to find {SELF_TEST_TEXT:?}, got {found:?}. \
             The OS OCR engine is missing or the binding is broken."
        ));
    }
    Ok(json!({ "ok": true, "engine": engine_name(), "expected": SELF_TEST_TEXT, "got": found }))
}

fn engine_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos-vision"
    } else {
        "windows-media-ocr"
    }
}

// ── macOS ────────────────────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
fn recognize(png: &[u8]) -> Result<Value, String> {
    use objc2::AllocAnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
    };

    let (width, height) = png_dimensions(png)?;
    let data = NSData::with_bytes(png);

    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);

    // Language correction MANGLES UI text: it "fixes" `⌘K`, `v14.42.0` and
    // `node_modules` into words. We want what is on screen, not what a dictionary
    // thinks was meant.
    request.setUsesLanguageCorrection(false);

    // THE TRAP THAT MAKES VISION LOOK BROKEN. `minimumTextHeight` is a FRACTION OF
    // IMAGE HEIGHT and its default is tuned for document scans. On a 1890px-tall
    // Retina screenshot a 12pt UI label is well under the default, so Vision
    // returns NOTHING AT ALL — no error, no partial result, an empty observation
    // list. This is the single most common way a Vision integration appears not to
    // work, and the reason this line has a comment this long.
    request.setMinimumTextHeight(0.005);

    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &data,
        &NSDictionary::new(),
    );

    let as_request: &VNRequest = request.as_ref();
    let requests = NSArray::from_slice(&[as_request]);
    handler
        .performRequests_error(&requests)
        .map_err(|e| format!("Vision performRequests failed: {e}"))?;

    let mut words = Vec::new();
    if let Some(results) = request.results() {
        for obs in results.iter() {
            let Some(best) = obs.topCandidates(1).firstObject() else {
                continue;
            };
            let text = best.string().to_string();
            if text.trim().is_empty() {
                continue;
            }
            // Vision's boundingBox is NORMALISED (0..1) with a BOTTOM-LEFT origin.
            // Convert to top-left image pixels here so no consumer has to know that.
            // SAFETY: `obs` is a live observation owned by `results`.
            let bb = unsafe { obs.boundingBox() };
            words.push(Word {
                text,
                x: bb.origin.x * width as f64,
                y: (1.0 - bb.origin.y - bb.size.height) * height as f64,
                w: bb.size.width * width as f64,
                h: bb.size.height * height as f64,
                conf: best.confidence() as f64,
            });
        }
    }

    Ok(to_json(width, height, scale_hint(), &words))
}

// ── Windows ──────────────────────────────────────────────────────────────────
#[cfg(target_os = "windows")]
fn recognize(png: &[u8]) -> Result<Value, String> {
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    // A language pack that includes OCR is a real SKU gap, not a theoretical one —
    // Windows Server and some N/KN editions ship without one. Say what to DO about
    // it rather than reporting a null.
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .ok()
        .filter(|e| e.RecognizerLanguage().is_ok())
        .or_else(|| {
            Language::CreateLanguage(&windows::core::HSTRING::from("en-US"))
                .ok()
                .and_then(|l| OcrEngine::TryCreateFromLanguage(&l).ok())
        })
        .ok_or_else(|| {
            "ocr-unavailable: Windows has no OCR language pack installed. Add one via \
             Settings → Time & language → Language & region (a language whose optional \
             features include optical character recognition), or run: DISM /Online \
             /Add-Capability /CapabilityName:Language.OCR~~~en-US~0.0.1.0. This is a \
             platform limitation, not a transient failure — do not retry."
                .to_string()
        })?;

    let stream = InMemoryRandomAccessStream::new()
        .map_err(|e| format!("InMemoryRandomAccessStream: {e}"))?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(|e| format!("DataWriter: {e}"))?;
    writer.WriteBytes(png).map_err(|e| format!("WriteBytes: {e}"))?;
    writer.StoreAsync().and_then(|op| op.get()).map_err(|e| format!("StoreAsync: {e}"))?;
    writer.FlushAsync().and_then(|op| op.get()).map_err(|e| format!("FlushAsync: {e}"))?;
    stream.Seek(0).map_err(|e| format!("Seek: {e}"))?;

    let decoder = BitmapDecoder::CreateAsync(&stream)
        .and_then(|op| op.get())
        .map_err(|e| format!("BitmapDecoder: {e}"))?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .and_then(|op| op.get())
        .map_err(|e| format!("GetSoftwareBitmap: {e}"))?;

    let result = engine
        .RecognizeAsync(&bitmap)
        .and_then(|op| op.get())
        .map_err(|e| format!("RecognizeAsync: {e}"))?;

    let mut words = Vec::new();
    if let Ok(lines) = result.Lines() {
        for line in lines {
            if let Ok(ws) = line.Words() {
                for word in ws {
                    let text = word.Text().map(|t| t.to_string()).unwrap_or_default();
                    if text.trim().is_empty() {
                        continue;
                    }
                    let r = word.BoundingRect().map_err(|e| format!("BoundingRect: {e}"))?;
                    words.push(Word {
                        text,
                        x: r.X as f64,
                        y: r.Y as f64,
                        w: r.Width as f64,
                        h: r.Height as f64,
                        // Windows.Media.Ocr exposes no per-word confidence. Report
                        // 1.0 rather than inventing a number, and never let the
                        // TypeScript side rank on a value this engine cannot give.
                        conf: 1.0,
                    });
                }
            }
        }
    }

    let (width, height) = png_dimensions(png)?;
    Ok(to_json(width, height, scale_hint(), &words))
}

/// Read a PNG's dimensions from its IHDR, without decoding it.
///
/// The engines report geometry differently (Vision in normalised units, Windows in
/// decoded-bitmap pixels), so both paths need the same authoritative source: the
/// file itself.
fn png_dimensions(png: &[u8]) -> Result<(u32, u32), String> {
    // 8-byte signature, then a 4-byte length + "IHDR" + width + height.
    if png.len() < 24 || &png[12..16] != b"IHDR" {
        return Err("not a PNG, or no IHDR where one is required".to_string());
    }
    let width = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let height = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    if width == 0 || height == 0 {
        return Err(format!("PNG reports a zero dimension ({width}x{height})"));
    }
    Ok((width, height))
}

/// The backing scale of the capture.
///
/// Reported as 1.0 here and OVERRIDDEN by the caller, which is the only side that
/// knows: cua-driver's `get_screen_size` returns the display's real backing factor,
/// and a capture may have been downscaled before it reached us. Guessing from the
/// image alone would be wrong exactly when it matters.
fn scale_hint() -> f64 {
    1.0
}
