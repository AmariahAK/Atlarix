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

    extern "C" {
        // libquarantine, in libSystem: the process macOS attributes our
        // permission requests to (Atlarix.app for the app; the terminal or
        // editor that started the CLI otherwise).
        fn responsibility_get_pid_responsible_for_pid(pid: i32) -> i32;
        fn proc_pidpath(pid: i32, buffer: *mut c_void, size: u32) -> i32;
    }

    pub fn responsible_path() -> Option<String> {
        let me = std::process::id() as i32;
        let pid = match unsafe { responsibility_get_pid_responsible_for_pid(me) } {
            p if p > 0 => p,
            _ => me,
        };
        let mut buf = vec![0u8; 4096];
        let n = unsafe { proc_pidpath(pid, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
        (n > 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
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

/// The name macOS shows in its permission prompt: the outermost `.app` in the
/// responsible process's path ("Visual Studio Code", not "Code Helper"), or
/// the executable's own name when it is not in a bundle.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn app_name(path: &str) -> String {
    if let Some(app) = path.split('/').find(|c| c.ends_with(".app")) {
        return app.trim_end_matches(".app").to_string();
    }
    path.rsplit('/').next().unwrap_or(path).to_string()
}

/// Who macOS will name when it asks for Screen Recording / Accessibility.
pub fn responsible_app() -> Option<String> {
    #[cfg(target_os = "macos")]
    return mac::responsible_path().map(|p| app_name(&p));
    #[cfg(not(target_os = "macos"))]
    None
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
    json!({
        "screen": state(screen_granted()),
        "accessibility": state(accessibility_granted()),
        "app": responsible_app(),
    })
}

/// "Screen Recording is not allowed for Terminal …": the name the person will
/// find in System Settings, which is not Atlarix when the CLI or an editor
/// started us (owner, 2026-10-23: a prompt that "didn't say from Atlarix").
pub fn not_allowed(what: &str) -> String {
    match responsible_app() {
        Some(app) if app != "Atlarix" => format!(
            "{what} is not allowed for {app}, which Atlarix runs inside (System Settings > Privacy & Security > {what})"
        ),
        _ => format!("{what} is not allowed for Atlarix (System Settings > Privacy & Security > {what})"),
    }
}

#[cfg(test)]
mod tests {
    use super::app_name;

    #[test]
    fn names_the_app_macos_will_show() {
        assert_eq!(app_name("/Applications/Atlarix.app/Contents/MacOS/Atlarix"), "Atlarix");
        assert_eq!(app_name("/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"), "Terminal");
        assert_eq!(
            app_name("/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)"),
            "Visual Studio Code"
        );
        assert_eq!(app_name("/Users/me/.atlarix/bin/abc/atlarix"), "atlarix");
    }
}
