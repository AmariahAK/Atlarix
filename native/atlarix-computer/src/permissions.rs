//! OS permissions. Only macOS gates screen capture and input behind a user
//! grant (TCC); elsewhere both report "unsupported", meaning nothing to grant.
//!
//! The grant attaches to the RESPONSIBLE app, not to this binary: Atlarix.app
//! when the app spawned us, the terminal for the CLI, VS Code for its panel.

use serde_json::{json, Value};

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;

    type CFTypeRef = *const c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> bool;
        static kAXTrustedCheckOptionPrompt: CFTypeRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: CFTypeRef;
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        fn CFDictionaryCreate(
            allocator: CFTypeRef,
            keys: *const CFTypeRef,
            values: *const CFTypeRef,
            num: isize,
            key_cb: *const c_void,
            value_cb: *const c_void,
        ) -> CFTypeRef;
        fn CFRelease(cf: CFTypeRef);
    }

    pub fn screen() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    pub fn accessibility() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    /// Shows the system prompt once; later calls only re-check.
    pub fn request_screen() -> bool {
        unsafe { CGRequestScreenCaptureAccess() }
    }

    pub fn request_accessibility() -> bool {
        unsafe {
            let keys = [kAXTrustedCheckOptionPrompt];
            let values = [kCFBooleanTrue];
            let dict = CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                &kCFTypeDictionaryKeyCallBacks as *const c_void,
                &kCFTypeDictionaryValueCallBacks as *const c_void,
            );
            let ok = AXIsProcessTrustedWithOptions(dict);
            if !dict.is_null() {
                CFRelease(dict);
            }
            ok
        }
    }
}

pub fn screen_granted() -> bool {
    #[cfg(target_os = "macos")]
    return mac::screen();
    #[cfg(not(target_os = "macos"))]
    true
}

pub fn accessibility_granted() -> bool {
    #[cfg(target_os = "macos")]
    return mac::accessibility();
    #[cfg(not(target_os = "macos"))]
    true
}

fn state(granted: bool) -> &'static str {
    if cfg!(target_os = "macos") {
        if granted { "granted" } else { "denied" }
    } else {
        "unsupported"
    }
}

/// `request` is "screen" or "accessibility" to show that system prompt first.
pub fn read(request: Option<&str>) -> Value {
    #[cfg(target_os = "macos")]
    match request {
        Some("screen") => {
            mac::request_screen();
        }
        Some("accessibility") => {
            mac::request_accessibility();
        }
        _ => {}
    }
    #[cfg(not(target_os = "macos"))]
    let _ = request;
    json!({ "screen": state(screen_granted()), "accessibility": state(accessibility_granted()) })
}
