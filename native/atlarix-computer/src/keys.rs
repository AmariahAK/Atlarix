//! Key names as models write them (xdotool style: "ctrl+s", "Return",
//! "Page_Down", "cmd+shift+t", several combos separated by spaces).

use enigo::Key;

#[derive(Debug, Clone, PartialEq)]
pub struct Combo {
    pub mods: Vec<Key>,
    pub key: Key,
}

/// xdotool names one side of a modifier ("Super_L", "Control_R"); either
/// side is the same key to us. Expects a normalised name ("superl").
fn sided_modifier(norm: &str) -> Option<Key> {
    let base = norm.strip_suffix('l').or_else(|| norm.strip_suffix('r'))?;
    modifier(base)
}

fn norm(token: &str) -> String {
    token.to_ascii_lowercase().chars().filter(|c| *c != '_' && *c != '-').collect()
}

fn modifier(name: &str) -> Option<Key> {
    Some(match name {
        "ctrl" | "control" | "ctl" => Key::Control,
        "alt" | "option" | "opt" => Key::Alt,
        "shift" => Key::Shift,
        "cmd" | "command" | "super" | "meta" | "win" | "windows" => Key::Meta,
        _ => return None,
    })
}

fn named(name: &str) -> Option<Key> {
    Some(match name {
        "return" | "enter" | "kpenter" => Key::Return,
        "tab" => Key::Tab,
        "escape" | "esc" => Key::Escape,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" | "prior" => Key::PageUp,
        "pagedown" | "next" => Key::PageDown,
        "capslock" => Key::CapsLock,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        "minus" => Key::Unicode('-'),
        "plus" => Key::Unicode('+'),
        "equal" | "equals" => Key::Unicode('='),
        "comma" => Key::Unicode(','),
        "period" => Key::Unicode('.'),
        "slash" => Key::Unicode('/'),
        "backslash" => Key::Unicode('\\'),
        "semicolon" => Key::Unicode(';'),
        "apostrophe" | "quote" => Key::Unicode('\''),
        "grave" => Key::Unicode('`'),
        "bracketleft" => Key::Unicode('['),
        "bracketright" => Key::Unicode(']'),
        _ => return None,
    })
}

fn key(token: &str) -> Result<Key, String> {
    let mut chars = token.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        // Single characters keep their case-free meaning: "a" with a modifier
        // is the A key; shift is the model's to send.
        return Ok(Key::Unicode(c.to_ascii_lowercase()));
    }
    let n = norm(token);
    named(&n)
        .or_else(|| modifier(&n))
        .or_else(|| sided_modifier(&n))
        .ok_or_else(|| format!("unknown key: {token}"))
}

/// Parse "ctrl+a Delete" into two combos. "+" alone is the plus key.
pub fn parse(spec: &str) -> Result<Vec<Combo>, String> {
    let mut out = Vec::new();
    for chord in spec.split_whitespace() {
        let parts: Vec<&str> = if chord == "+" { vec!["+"] } else { chord.split('+').filter(|p| !p.is_empty()).collect() };
        let Some((last, mods)) = parts.split_last() else {
            return Err(format!("empty key in {spec:?}"));
        };
        let mut combo_mods = Vec::new();
        for m in mods {
            let n = norm(m);
            combo_mods.push(modifier(&n).or_else(|| sided_modifier(&n)).ok_or_else(|| format!("unknown modifier: {m}"))?);
        }
        out.push(Combo { mods: combo_mods, key: key(last)? });
    }
    if out.is_empty() {
        return Err("no key given".into());
    }
    Ok(out)
}

/// Ctrl+Alt+Esc (Ctrl+Option+Esc on macOS) is the host's stop shortcut; a
/// model that presses it would stop itself in a confusing way, or, worse, an
/// injected page could use it to fight the user's stop. Refuse it.
pub fn is_stop_chord(c: &Combo) -> bool {
    c.key == Key::Escape && c.mods.contains(&Key::Control) && c.mods.contains(&Key::Alt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_xdotool_names_and_sequences() {
        let v = parse("ctrl+a Delete").unwrap();
        assert_eq!(v, vec![
            Combo { mods: vec![Key::Control], key: Key::Unicode('a') },
            Combo { mods: vec![], key: Key::Delete },
        ]);
        assert_eq!(parse("Page_Down").unwrap()[0].key, Key::PageDown);
        assert_eq!(parse("cmd+shift+T").unwrap()[0], Combo { mods: vec![Key::Meta, Key::Shift], key: Key::Unicode('t') });
        assert_eq!(parse("KP_Enter").unwrap()[0].key, Key::Return);
        assert_eq!(parse("+").unwrap()[0].key, Key::Unicode('+'));
    }

    #[test]
    fn takes_either_side_of_a_modifier() {
        // Seen live on Windows: a model pressed "Super_L" for the Windows key.
        assert_eq!(parse("Super_L").unwrap()[0].key, Key::Meta);
        assert_eq!(parse("Control_R+c").unwrap()[0], Combo { mods: vec![Key::Control], key: Key::Unicode('c') });
        assert_eq!(parse("Shift_L+Tab").unwrap()[0], Combo { mods: vec![Key::Shift], key: Key::Tab });
        assert!(parse("Nope_L").is_err());
    }

    #[test]
    fn rejects_unknown_names_instead_of_typing_them() {
        assert!(parse("ctrl+nope").is_err());
        assert!(parse("hyper+a").is_err());
        assert!(parse("   ").is_err());
    }

    #[test]
    fn spots_the_stop_chord_in_any_spelling() {
        assert!(is_stop_chord(&parse("ctrl+alt+Escape").unwrap()[0]));
        assert!(is_stop_chord(&parse("control+option+esc").unwrap()[0]));
        assert!(!is_stop_chord(&parse("ctrl+Escape").unwrap()[0]));
    }
}
