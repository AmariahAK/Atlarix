//! `atlarix-cu` — the first-party half of Atlarix's computer-use support.
//!
//! Three jobs cua-driver does not do for us:
//!
//!   `probe --json`         macOS: is the private SkyLight input SPI still there?
//!   `post <action> …`      macOS: input via the PUBLIC `CGEventPostToPid`, used
//!                          when the probe says the SPI is gone.
//!   `ocr --in <png> --json`  OS-native OCR — macOS Vision, Windows Media.Ocr.
//!   `ocr --self-test`      Render known text, OCR it, assert it round-trips.
//!
//! WHY OS OCR AND NOT A BUNDLED MODEL. cua-driver ships no OCR, and apps that draw
//! their own surface expose no accessibility tree — so a text-only model (both
//! Atlarix Core models are text-only) has nothing to read. The alternative was an
//! ONNX model, and this repo already has that experiment costed: on-device Whisper
//! is a ~285 MB CDN fetch cached under userData that *required* a clear-cache UI
//! because userData survives reinstalls, and it runs in a RENDERER worker because
//! transformers.js needs the `caches` API — which a main-process tool cannot reach.
//! Vision and Windows.Media.Ocr need no download, no cache, no CSP change, and
//! screen text is crisp machine-rendered type, which is exactly where they are
//! strong. Linux has no OS OCR, so that path shells out to `tesseract` from
//! TypeScript and is not in this crate.
//!
//! PURE RUST, NO build.rs SHIM. Never call `swiftc`/`clang` from a build script: the
//! whole value of `scripts/check-sandbox-helpers.mjs` is that
//! `cargo check --target aarch64-apple-darwin` runs from the LINUX CI runner,
//! because `check` never links. A build script that needs the macOS SDK destroys
//! that, and this crate becomes uncheckable on the one runner that checks
//! everything.
//!
//! Every subcommand prints JSON on stdout and exits non-zero on failure, so the
//! TypeScript side has one parser and one error convention.

#![cfg(any(target_os = "macos", target_os = "windows"))]

use std::process::ExitCode;

mod ocr;
#[cfg(target_os = "macos")]
mod post;
#[cfg(target_os = "macos")]
mod probe;

/// Coordinates are reported in IMAGE PIXELS with `scale` alongside, never in
/// points. The classic bug this prevents: handing a model Retina pixel coordinates
/// that get interpreted as screen points, so every click lands at half the intended
/// position. Carrying `scale` explicitly makes the conversion a stated step rather
/// than an assumption.
pub const USAGE: &str = "\
atlarix-cu — Atlarix computer-use helper

  probe --json                  Report whether the macOS private input SPI resolves.
  post <action> --pid <pid> …   Input via the public CGEventPostToPid (macOS).
  ocr --in <file.png> --json    OCR an image; prints {width,height,scale,words[]}.
  ocr --self-test               Round-trip known text through the OS OCR engine.
";

fn arg_value(args: &[String], name: &str) -> Option<String> {
    let idx = args.iter().position(|a| a == name)?;
    args.get(idx + 1).cloned()
}

fn fail(msg: &str) -> ExitCode {
    // Errors are JSON too — the caller never has to branch on stream shape.
    let payload = serde_json::json!({ "ok": false, "error": msg });
    eprintln!("{payload}");
    ExitCode::FAILURE
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first().map(String::as_str) else {
        print!("{USAGE}");
        return ExitCode::FAILURE;
    };

    match cmd {
        "probe" => {
            #[cfg(target_os = "macos")]
            {
                let report = probe::run();
                println!("{report}");
                ExitCode::SUCCESS
            }
            #[cfg(not(target_os = "macos"))]
            {
                // Not a failure: the SPI this probes is macOS-only, so "not
                // applicable" is the correct answer and the caller must not treat
                // it as a broken helper.
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": true,
                        "applicable": false,
                        "reason": "the SkyLight input SPI is macOS-only"
                    })
                );
                ExitCode::SUCCESS
            }
        }

        "post" => {
            #[cfg(target_os = "macos")]
            {
                match post::run(&args) {
                    Ok(report) => {
                        println!("{report}");
                        ExitCode::SUCCESS
                    }
                    Err(e) => fail(&e),
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                fail("`post` is macOS-only; Windows and Linux input goes through cua-driver")
            }
        }

        "ocr" => {
            if args.iter().any(|a| a == "--self-test") {
                return match ocr::self_test() {
                    Ok(report) => {
                        println!("{report}");
                        ExitCode::SUCCESS
                    }
                    Err(e) => fail(&e),
                };
            }
            let Some(input) = arg_value(&args, "--in") else {
                return fail("`ocr` needs --in <file.png> (or --self-test)");
            };
            match ocr::run(&input) {
                Ok(report) => {
                    println!("{report}");
                    ExitCode::SUCCESS
                }
                Err(e) => fail(&e),
            }
        }

        "--help" | "-h" | "help" => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        "--version" => {
            println!("atlarix-cu {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        other => fail(&format!("unknown subcommand {other:?}")),
    }
}
