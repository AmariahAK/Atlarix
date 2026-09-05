/**
 * What the agent will never touch, refused by CLASS rather than by app.
 *
 * There is deliberately no per-app permission prompt (owner's decision: any and all
 * apps on the device). That makes these refusals the actual containment, not a
 * belt-and-braces layer — and they are enforced at the RESOLVE seam, so one check
 * covers reading, acting, and listing. Refusing only at act time would leave a
 * discoverable target that a model keeps probing.
 *
 * All four refusals use the permanent-policy wording ("Atlarix will not do this. Do
 * not retry — <alternative>"), because the distinction between "cannot" and "will
 * not" is what stops a retry loop. An agent told "failed" tries again.
 */

/**
 * TERMINALS AND SHELLS — the sharpest hole this feature could open.
 *
 * Typing into a terminal is `run_command` with **no OS sandbox, no danger gate, no
 * approval card and no ruleset evaluation** — a complete bypass of the command
 * permission system, reached from a tool whose parameters contain no command at
 * all. Everything Atlarix does to make shell access safe is attached to
 * `run_command`; none of it is attached to a keystroke.
 */
const SHELL_APPS = [
  "terminal", "iterm", "iterm2", "warp", "alacritty", "kitty", "hyper", "wezterm",
  "ghostty", "tabby", "rio", "cool retro term",
  // Windows
  "cmd.exe", "powershell", "pwsh", "windowsterminal", "windows terminal", "conhost",
  "conemu", "cmder", "mintty", "git bash",
  // Linux
  "gnome-terminal", "konsole", "xterm", "xfce4-terminal", "terminator", "tilix",
  "guake", "yakuake", "urxvt", "st",
];

/**
 * CREDENTIAL SURFACES. Reading these is as bad as typing into them — a password
 * manager's window contents are the secret.
 */
const CREDENTIAL_APPS = [
  "keychain access", "1password", "bitwarden", "lastpass", "dashlane", "enpass",
  "keeper", "nordpass", "proton pass", "strongbox", "keepassxc", "keepass",
  "credential manager", "windows security", "seahorse", "gnome-keyring",
  "authy", "google authenticator",
  // System Settings is where TCC grants live: an agent that could drive it could
  // grant itself permissions.
  "system settings", "system preferences",
];

function norm(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * WORD-BOUNDARY MATCHING, NOT SUBSTRING — and this is not fastidiousness.
 *
 * The first version used `name.includes(needle)`, and the test suite immediately
 * caught it refusing **OBS Studio**: the list contains `st` (the suckless
 * terminal), and "OBS St-udio" contains "st". A guard that refuses a video mixer
 * because a two-letter terminal exists is a guard people switch off, and switching
 * it off removes the terminal protection too.
 *
 * So a needle must match a whole word (or a whole multi-word phrase). Bundle ids
 * are matched loosely on purpose: they are dotted and reversed
 * (`com.googlecode.iterm2`), so a boundary there is a dot or a digit, and the
 * ambiguity that bites display names does not arise.
 */
function matches(list: string[], name: string, bundleId?: string): boolean {
  const n = norm(name);
  const b = norm(bundleId ?? "");
  return list.some((needle) => {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // `\b` on both sides, so "st" matches "st" and "st -e" but not "studio".
    if (new RegExp(`\\b${escaped}\\b`).test(n)) return true;
    const compact = needle.replace(/\s+/g, "");
    return Boolean(b) && b.includes(compact);
  });
}

export type GuardVerdict = { allowed: true } | { allowed: false; reason: string };

export function guardTargetApp(app: { name: string; bundleId?: string }): GuardVerdict {
  if (matches(SHELL_APPS, app.name, app.bundleId)) {
    return {
      allowed: false,
      reason:
        `${app.name} is a terminal or shell. Typing into one would run commands with no ` +
        `sandbox, no danger gate and no approval card — it would bypass the entire command ` +
        `permission system. Atlarix will not do this. Do not retry — use run_command, which ` +
        `is the supervised path for exactly this.`,
    };
  }
  if (matches(CREDENTIAL_APPS, app.name, app.bundleId)) {
    return {
      allowed: false,
      reason:
        `${app.name} holds credentials or system permissions. Atlarix will not read or ` +
        `control it. Do not retry — ask the user to do this themselves.`,
    };
  }
  return { allowed: true };
}

/**
 * SECURE TEXT FIELDS.
 *
 * The reliable signal is the role, and it is already in the tree we just read —
 * `AXSecureTextField` on macOS, UIA's `IsPassword`, AT-SPI's `password text`. The
 * name heuristic is a second pass with a stated false-positive cost, because a
 * field called "API token" refusing is a nuisance and a field holding a password
 * being typed into is a leak.
 */
const SECURE_ROLE = /securetextfield|password|ispassword/i;
const SECURE_NAME = /password|passcode|\bpin\b|2fa|one.?time|\botp\b|secret|api.?key|token|credential/i;

export function guardTypeTarget(el: {
  role: string;
  label: string;
  value?: string;
}): GuardVerdict {
  if (SECURE_ROLE.test(el.role)) {
    return {
      allowed: false,
      reason:
        `That is a secure text field (role ${el.role}). Atlarix never types credentials — ` +
        `system autofill only. Do not retry — ask the user to enter it, or have them use a ` +
        `saved autofill entry.`,
    };
  }
  if (SECURE_NAME.test(el.label)) {
    return {
      allowed: false,
      reason:
        `"${el.label}" looks like a credential field, so Atlarix will not type into it. ` +
        `If it genuinely is not one — a search box that happens to contain the word "token", ` +
        `say — the field is not addressable this way at all: ask the user to type it. Do not ` +
        `retry.`,
    };
  }
  return { allowed: true };
}

/** Exported for the tests that pin these lists. */
export const GUARD_LISTS_FOR_TESTS = { SHELL_APPS, CREDENTIAL_APPS };
