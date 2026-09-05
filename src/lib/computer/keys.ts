/**
 * Which keystrokes are expressible — and, for chords, an ALLOWLIST rather than a
 * deny list.
 *
 * # Why this file exists at all
 *
 * The closed key set used to live in `src/lib/tools/computer.ts`, where exactly one
 * caller read it. `computer_call` is a second caller reaching `press_key` and
 * `hotkey` directly, and a key policy with two independent copies is a key policy
 * that drifts. So it moved here, to one place both go through.
 *
 * # The chord problem, and why an allowlist
 *
 * The obvious design is to block the destructive combinations. It does not work,
 * and the reason is worth stating because "just block cmd+Q and alt+F4" sounds
 * complete and is not:
 *
 *   cmd+Q quit · cmd+opt+esc force quit · cmd+ctrl+Q lock screen · cmd+shift+Q log
 *   out · cmd+W close window · cmd+H hide · cmd+M minimise · cmd+space Spotlight
 *   (a launcher — it runs things) · cmd+tab app switcher · ctrl+arrow Spaces ·
 *   ctrl+up Mission Control · F11 · alt+F4 · ctrl+alt+del · ctrl+shift+esc ·
 *   win+L · win+R (the Run box — a shell) · ctrl+alt+T (a terminal, on most Linux
 *   desktops) · ctrl+alt+F1..F12 (virtual console switch) · super (activities)
 *
 * That list is unbounded, differs per OS, differs per DESKTOP ENVIRONMENT, and
 * changes with OS releases — a deny list would have to be right about every future
 * shortcut Apple, Microsoft and GNOME invent. An allowlist has to be right about
 * the ones we want, which is a fixed and small set we choose.
 *
 * THE RULE THE ALLOWLIST ENCODES, in one sentence: **text editing and in-document
 * navigation; nothing that addresses a window, an application, or the OS.** Every
 * entry below is checkable against that sentence, and anything that is not clearly
 * inside it is simply left out — a refusal costs a turn, and `cmd+opt+esc` costs
 * the user their unsaved work.
 *
 * # `press_key` is also a chord tool, which is easy to miss
 *
 * Its name says "Press and release a single key" and its schema carries a
 * `modifiers` array. So `press_key {key:"q", modifiers:["cmd"]}` IS cmd+Q. Any
 * guard that reads `hotkey` and not `press_key`'s modifiers is not a guard.
 */

/**
 * The closed set the `computer` tool exposes, unchanged.
 *
 * These are OUR names, not the driver's — see `toDriverKey` for why that
 * distinction matters and where the translation happens.
 */
export const KEYS = [
  "enter", "tab", "escape", "backspace", "delete", "up", "down", "left", "right",
  "home", "end", "page_up", "page_down", "select_all", "copy", "paste", "cut",
] as const;

export type NamedKey = (typeof KEYS)[number];

/** True for a name in the closed set. */
export function isNamedKey(name: string): name is NamedKey {
  return (KEYS as readonly string[]).includes(name);
}

/**
 * The action modifier: what "the Ctrl key" means on this platform.
 *
 * macOS puts copy/paste/undo on Command; Windows and Linux put them on Control.
 * Every editing chord below is written against this rather than hardcoding `cmd`,
 * so the allowlist means the same thing on all three platforms.
 */
function actionModifier(): "cmd" | "ctrl" {
  return process.platform === "darwin" ? "cmd" : "ctrl";
}

/**
 * OUR key names translated to the driver's.
 *
 * THE TWO VOCABULARIES ARE NOT THE SAME, and the closed set was written against the
 * wrong one. `native/atlarix-cu/src/post.rs` — the rung-3 fallback helper — accepts
 * `enter`, `page_up`, `select_all`, `copy`, `paste`, `cut`. cua-driver documents a
 * different vocabulary: *"Key names: return, tab, escape, up/down/left/right, space,
 * delete, home, end, pageup, pagedown, f1-f12, plus any letter or digit."* It has no
 * `select_all` at all — that is `a` with a `cmd` modifier.
 *
 * `computer.ts` sends `key` to the DRIVER, so seven of the seventeen names in the
 * closed set were being handed to a parser whose published vocabulary does not
 * contain them. Translating here is right whether or not the driver happens to
 * accept our spellings as well: the model's vocabulary should not be hostage to
 * which of two binaries ends up delivering the keystroke.
 *
 * The semantic four (`select_all`/`copy`/`paste`/`cut`) become chords, which is
 * exactly what they always were — `post.rs` composed them with `MaskCommand` too.
 */
export interface DriverKey {
  key: string;
  modifiers?: string[];
}

export function toDriverKey(name: NamedKey): DriverKey {
  const action = actionModifier();
  switch (name) {
    case "enter":
      return { key: "return" };
    // Both of ours mean the backspace key, matching post.rs, which maps
    // "backspace"|"delete" to the same 0x33 and keeps 0x75 as `forward_delete`.
    case "backspace":
    case "delete":
      return { key: "delete" };
    case "page_up":
      return { key: "pageup" };
    case "page_down":
      return { key: "pagedown" };
    case "select_all":
      return { key: "a", modifiers: [action] };
    case "copy":
      return { key: "c", modifiers: [action] };
    case "paste":
      return { key: "v", modifiers: [action] };
    case "cut":
      return { key: "x", modifiers: [action] };
    default:
      // tab, escape, up, down, left, right, home, end — same word in both.
      return { key: name };
  }
}

// ── chords ──────────────────────────────────────────────────────────────────

/**
 * Modifier spellings the driver recognises: *"cmd/command, shift, option/alt,
 * ctrl/control, fn"*.
 *
 * `meta`, `super`, `win` and `windows` are deliberately ABSENT rather than mapped.
 * They are ambiguous — `meta` is Command on macOS and Super on Linux — and every
 * chord they name (win+L, win+R, super for the activities overview) is an OS-level
 * one this allowlist would refuse anyway. An unrecognised modifier is refused, so
 * leaving them out is the fail-closed choice and needs no special case.
 */
const MODIFIER_ALIASES: Readonly<Record<string, string>> = {
  cmd: "cmd", command: "cmd", "⌘": "cmd",
  ctrl: "ctrl", control: "ctrl",
  alt: "alt", opt: "alt", option: "alt", "⌥": "alt",
  shift: "shift", "⇧": "shift",
  fn: "fn",
};

const MODIFIER_ORDER = ["cmd", "ctrl", "alt", "shift", "fn"];

/** Base keys an editing chord may end on, with the action modifier. */
const EDIT_BASES = new Set(["a", "c", "v", "x", "z", "s", "f", "g", "b", "i", "u", "r", "return"]);

/** Base keys an editing chord may end on, with action+shift. */
const EDIT_SHIFT_BASES = new Set([
  "z", // redo
  "g", // find previous
  "v", // paste and match style
]);

/**
 * Base keys a navigation chord may end on.
 *
 * Note what is NOT here: `space`, `tab`, `escape` and `f1`–`f12`. Every chord that
 * addresses a window, an app or the OS ends on one of those — cmd+space, cmd+tab,
 * cmd+opt+esc, alt+F4, ctrl+alt+F1 — so excluding four base keys excludes that whole
 * family at once, without needing to know which shortcut each OS assigns to them.
 */
const NAV_BASES = new Set([
  "left", "right", "up", "down", "home", "end", "pageup", "pagedown", "delete",
]);

/**
 * Modifier sets a navigation chord may carry.
 *
 * `ctrl` appears only through the action modifier, which means it appears on
 * Windows and Linux (where ctrl+arrow is word-wise movement) and NOT on macOS
 * (where ctrl+arrow switches Spaces and ctrl+up opens Mission Control — both
 * OS-level, both exactly what this file exists to prevent).
 *
 * `ctrl` and `alt` together never appear, on any platform: ctrl+alt+arrow switches
 * workspace on GNOME and KDE.
 */
function navModifierSets(): string[][] {
  const action = actionModifier();
  return [["shift"], [action], [action, "shift"], ["alt"], ["alt", "shift"]];
}

export type ChordVerdict = { allowed: true; keys: string[] } | { allowed: false; reason: string };

function canonicalModifier(raw: string): string | null {
  return MODIFIER_ALIASES[raw.trim().toLowerCase()] ?? null;
}

/** Our own named keys are accepted in a chord too, and translated on the way. */
function canonicalBase(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (isNamedKey(s)) {
    const t = toDriverKey(s);
    // A semantic key like `copy` already IS a chord; it cannot also be a chord's
    // base key. Only the plain ones translate.
    return t.modifiers?.length ? null : t.key;
  }
  if (/^[a-z0-9]$/.test(s)) return s;
  if (/^f([1-9]|1[0-2])$/.test(s)) return s;
  if (["return", "space", "tab", "escape", "pageup", "pagedown", "home", "end"].includes(s)) {
    return s;
  }
  if (["left", "right", "up", "down", "delete"].includes(s)) return s;
  return null;
}

const CHORD_TAIL =
  "Atlarix allows key combinations for text editing and in-document navigation only — " +
  "nothing that addresses a window, an application, or the operating system. Do not retry " +
  "with a different spelling; use the menu path (computer's action:\"menu\") if you need an " +
  "application command.";

/**
 * Is this chord allowed, and what should the driver be sent?
 *
 * @param raw modifiers first, one non-modifier last — the driver's own ordering
 *            rule for `hotkey`, and the shape `press_key`'s `{modifiers, key}` is
 *            flattened into before it gets here.
 */
export function guardChord(raw: readonly string[]): ChordVerdict {
  const parts = raw.map((p) => String(p ?? "").trim()).filter(Boolean);
  if (parts.length < 2) {
    return {
      allowed: false,
      reason:
        "A key combination needs at least one modifier and exactly one other key, " +
        'e.g. ["cmd","c"]. For a single key with no modifier, use press_key with no ' +
        "`modifiers`.",
    };
  }

  const mods: string[] = [];
  for (const p of parts.slice(0, -1)) {
    const m = canonicalModifier(p);
    if (!m) {
      return {
        allowed: false,
        reason:
          `"${p}" is not a modifier Atlarix accepts (cmd/command, ctrl/control, ` +
          `alt/option, shift). Modifiers come first and exactly one non-modifier key ` +
          `comes last. ${CHORD_TAIL}`,
      };
    }
    mods.push(m);
  }

  const last = parts[parts.length - 1]!;
  // Checked BEFORE the base lookup, so "cmd+shift" reports the real mistake
  // (modifiers only, or the wrong order) rather than "shift is not a key".
  if (canonicalModifier(last)) {
    return {
      allowed: false,
      reason:
        "The last entry must be a non-modifier key — modifiers come first. " +
        'For example ["cmd","shift","z"], not ["z","cmd","shift"].',
    };
  }
  const base = canonicalBase(last);
  if (!base) {
    return { allowed: false, reason: `"${last}" is not a key Atlarix can send. ${CHORD_TAIL}` };
  }

  const set = new Set(mods);
  if (set.size !== mods.length) {
    return { allowed: false, reason: `Repeated modifier in ${JSON.stringify(parts)}.` };
  }
  // `fn` is never part of an allowed chord: fn+arrow is home/end (already
  // reachable) and fn+F-key is a hardware function.
  if (set.has("fn")) {
    return { allowed: false, reason: `The fn modifier is not available. ${CHORD_TAIL}` };
  }

  // One canonical spelling for a modifier set, so "shift+cmd" and "cmd+shift" are
  // the same thing to compare against.
  const canon = (list: readonly string[]) =>
    [...new Set(list)]
      .sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b))
      .join("+");

  const sorted = canon(mods);
  const action = actionModifier();

  const editOk =
    (sorted === action && EDIT_BASES.has(base)) ||
    (sorted === canon([action, "shift"]) && EDIT_SHIFT_BASES.has(base));

  const navOk =
    NAV_BASES.has(base) && navModifierSets().some((allowed) => canon(allowed) === sorted);

  if (!editOk && !navOk) {
    return {
      allowed: false,
      reason: `${sorted}+${base} is not an allowed key combination. ${CHORD_TAIL}`,
    };
  }

  return { allowed: true, keys: [...sorted.split("+"), base] };
}

/**
 * Flatten `press_key`'s `{key, modifiers}` into `hotkey`'s array form.
 *
 * One shape reaches `guardChord`, so `press_key` cannot be the tool that forgot.
 */
export function chordFromPressKey(input: {
  key?: unknown;
  modifiers?: unknown;
}): string[] | null {
  const mods = Array.isArray(input.modifiers)
    ? input.modifiers.map((m) => String(m ?? "").trim()).filter(Boolean)
    : [];
  if (mods.length === 0) return null;
  return [...mods, String(input.key ?? "")];
}
