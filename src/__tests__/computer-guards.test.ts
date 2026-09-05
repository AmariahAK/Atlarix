/**
 * The refusals, and the shape of the tool schema that makes some of them
 * structural rather than enforced.
 *
 * There is deliberately NO per-app permission prompt (owner's decision: any and all
 * apps on the device). That makes these the actual containment, not a
 * belt-and-braces layer — so they are worth pinning hard.
 *
 * The most important assertion in this file is the negative one: the registered
 * parameters contain no coordinate key and the `key` enum admits nothing
 * destructive. Those are not checks that can be forgotten at runtime — a capability
 * absent from the schema is one the model cannot express at all.
 */
import { describe, expect, it } from "vitest";
import { guardTargetApp, guardTypeTarget, GUARD_LISTS_FOR_TESTS } from "@/lib/computer/guards";
import { isSelf, selfTargetRefusal } from "@/lib/computer/apps";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/computer";

describe("terminals and shells are never targets", () => {
  // The sharpest hole this feature could open: typing into a terminal is
  // run_command with no sandbox, no danger gate, no approval card and no ruleset
  // evaluation — reached from a tool whose parameters contain no command at all.
  const shells = [
    { name: "Terminal" },
    { name: "iTerm2" },
    { name: "Warp" },
    { name: "Ghostty" },
    { name: "kitty" },
    { name: "Windows Terminal" },
    { name: "powershell.exe" },
    { name: "gnome-terminal" },
    { name: "konsole" },
    { name: "xterm" },
  ];
  for (const app of shells) {
    it(`refuses ${app.name}`, () => {
      const v = guardTargetApp(app);
      expect(v.allowed).toBe(false);
      if (v.allowed) return;
      // "will not" rather than "cannot": an agent told "failed" retries.
      expect(v.reason).toMatch(/Atlarix will not do this/i);
      expect(v.reason).toMatch(/do not retry/i);
      // And it must name the supervised alternative, or the model has nowhere to go.
      expect(v.reason).toMatch(/run_command/);
    });
  }

  it("matches on bundle id too, not only the display name", () => {
    expect(guardTargetApp({ name: "Some Wrapper", bundleId: "com.googlecode.iterm2" }).allowed).toBe(
      false,
    );
  });

  /**
   * REGRESSION: this caught a real over-match on the first run.
   *
   * The list contains `st` (the suckless terminal) and the matcher was a bare
   * `name.includes(needle)`, so **OBS Studio** was refused — "OBS St-udio"
   * contains "st". A guard that refuses a video mixer because a two-letter
   * terminal exists is a guard people switch off, and switching it off removes
   * the terminal protection too. Now matched on word boundaries.
   */
  it("does not refuse an ordinary app whose name merely contains a needle", () => {
    for (const name of [
      "Slack",
      "Microsoft Excel",
      "CapCut",
      "OBS Studio", // "st"
      "Google Chrome",
      "Studio One", // "st"
      "Notion", // "n"-adjacent needles
      "Terminator 2 (the film)", // "terminator" as a WORD would still refuse; this
      // is here to document that the guard is name-based and therefore
      // approximate — a film player called this WOULD be refused, and that is
      // the safe direction to be wrong in.
    ].slice(0, 7)) {
      expect(guardTargetApp({ name }).allowed).toBe(true);
    }
  });
});

describe("credential surfaces are never targets", () => {
  for (const name of [
    "Keychain Access",
    "1Password",
    "Bitwarden",
    "KeePassXC",
    "Windows Security",
    // System Settings is where TCC grants live: driving it means granting yourself
    // permissions.
    "System Settings",
  ]) {
    it(`refuses ${name}`, () => {
      const v = guardTargetApp({ name });
      expect(v.allowed).toBe(false);
      if (!v.allowed) expect(v.reason).toMatch(/will not|do not retry/i);
    });
  }
});

describe("secure text fields", () => {
  it("refuses by ROLE, which is the reliable signal", () => {
    // Already present in the tree we just read — AXSecureTextField / IsPassword /
    // "password text" depending on platform.
    const v = guardTypeTarget({ role: "AXSecureTextField", label: "" });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/system autofill only/i);
  });

  it("refuses by NAME as a second pass, and states the false-positive cost", () => {
    const v = guardTypeTarget({ role: "AXTextField", label: "API token" });
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    // A field called "token" that is really a search box will refuse. That trade is
    // deliberate and the message has to own it rather than looking like a bug.
    expect(v.reason).toMatch(/if it genuinely is not one/i);
  });

  for (const label of ["Password", "Passcode", "PIN", "2FA code", "One-time code", "Secret key"]) {
    it(`refuses a field labelled "${label}"`, () => {
      expect(guardTypeTarget({ role: "AXTextField", label }).allowed).toBe(false);
    });
  }

  it("allows an ordinary field", () => {
    expect(guardTypeTarget({ role: "AXTextField", label: "Search" }).allowed).toBe(true);
    expect(guardTypeTarget({ role: "AXTextArea", label: "Message" }).allowed).toBe(true);
  });
});

describe("Atlarix is never a target", () => {
  it("recognises itself by name and by bundle id", () => {
    expect(isSelf({ name: "Atlarix" })).toBe(true);
    expect(isSelf({ name: "atlarix" })).toBe(true);
    expect(isSelf({ bundleId: "com.electron.atlarix" })).toBe(true);
  });

  it("recognises its own pid", () => {
    expect(isSelf({ pid: process.pid })).toBe(true);
  });

  it("does not claim an unrelated app", () => {
    expect(isSelf({ name: "Slack", pid: 999999 })).toBe(false);
  });

  it("explains WHY, because that is what stops a retry", () => {
    const r = selfTargetRefusal();
    // The reason matters: this check is what every other approval gate rests on.
    expect(r).toMatch(/click its own approval buttons/i);
    expect(r).toMatch(/do not retry/i);
  });
});

describe("the registered schema forecloses whole classes", () => {
  const inspect = ToolRegistry.get("computer_inspect")!;
  const act = ToolRegistry.get("computer")!;

  it("exposes NO coordinate form on either tool", () => {
    // A coordinate is correct for one window size and fails by SUCCEEDING on empty
    // space at any other — the mobile ruling's exact argument. Absent from the
    // schema means the model cannot ask for it, which is stronger than refusing it.
    const keys = (t: typeof act) =>
      Object.keys(((t.parameters as { properties?: Record<string, unknown> }).properties) ?? {});
    for (const t of [inspect, act]) {
      const k = keys(t);
      expect(k).not.toContain("x");
      expect(k).not.toContain("y");
      expect(k.some((n) => /coord|pixel|point/i.test(n))).toBe(false);
    }
  });

  it("admits no destructive key combination", () => {
    const props = (act.parameters as {
      properties?: { key?: { enum?: string[] }; action?: { enum?: string[] } };
    }).properties;
    const keys = props?.key?.enum ?? [];
    expect(keys.length).toBeGreaterThan(0);
    // The set is CLOSED so cmd+Q, alt+F4 and force-quit are not expressible —
    // unexpressible rather than filtered. A free-form combo parameter would
    // quietly undo that.
    for (const k of keys) {
      expect(k).not.toMatch(/\+/);
      expect(k).not.toMatch(/cmd|command|meta|alt|option|ctrl|control|shift/i);
      expect(k).not.toMatch(/\bq\b|f4|quit|power|eject/i);
    }
  });

  it("is peripheral under tool-reveal in every mode", async () => {
    // Absence from CORE_TOOLS_BY_MODE *is* the tiering, and it is what makes
    // every-mode availability affordable.
    const { revealTierForMode } = await import("@/lib/tools/tool-reveal");
    for (const mode of ["ask", "plan", "build", "debug", "review"] as const) {
      for (const t of [inspect, act]) {
        expect(revealTierForMode(t.name, t.description, mode)).toBe("peripheral");
      }
    }
  });

  it("keeps both first sentences inside the 200-char binding", async () => {
    const { firstSentence } = await import("@/lib/text/first-sentence");
    for (const t of [inspect, act]) {
      const bound = firstSentence(t.description);
      // A truncated first sentence loses the end of the claim — which is exactly
      // what happened to mobile_inspect, dropping "in a few hundred tokens".
      expect(bound.endsWith("…")).toBe(false);
      expect(bound.length).toBeLessThanOrEqual(200);
      // And it must carry the cheap default, not an introduction.
      expect(bound.toLowerCase()).toMatch(/text|ref/);
    }
  });
});

describe("the guard lists themselves", () => {
  it("cover all three platforms' terminals", () => {
    const { SHELL_APPS } = GUARD_LISTS_FOR_TESTS;
    expect(SHELL_APPS).toContain("terminal");
    expect(SHELL_APPS).toContain("powershell");
    expect(SHELL_APPS).toContain("gnome-terminal");
  });
});

/**
 * The empty-window message, which misled a real run on 2026-09-05.
 *
 * WhatsApp had just been launched and was showing its SPLASH SCREEN. The tree was
 * empty because nothing had rendered yet — but `degraded` was set for ANY empty
 * tree, so the message asserted "the app draws its own surface" and sent the model
 * to OCR, which needed a second macOS grant it did not have. The "it may still be
 * loading, re-read once" half of that message was unreachable: `refs.length === 0`
 * is exactly when it prints, so the empty-tree condition made the flag always true.
 *
 * A window still painting is indistinguishable from one with no tree. So the
 * message must not pick, and the free check has to come first.
 */
describe("empty-window message", () => {
  it("offers the cheap re-read BEFORE suggesting OCR", async () => {
    const { formatWindow } = await import("@/lib/computer/ax-tree");
    const msg = formatWindow(
      { elements: [], total: 0, degraded: false },
      [],
      { name: "WhatsApp", pid: 1 },
    );
    expect(msg).toMatch(/read it again/i);
    expect(msg.indexOf("read it again")).toBeLessThan(msg.indexOf('mode:"text"'));
  });

  it("does not claim the app draws its own surface on a FIRST empty read", async () => {
    const { formatWindow } = await import("@/lib/computer/ax-tree");
    const msg = formatWindow(
      { elements: [], total: 0, degraded: false },
      [],
      { name: "WhatsApp", pid: 1 },
    );
    // It may say so as a CONDITIONAL second step, but never as the diagnosis.
    expect(msg).not.toMatch(/which usually means the app draws its own surface/i);
    expect(msg).toMatch(/second read is also empty/i);
  });

  it("still surfaces a reason the driver actually gave", async () => {
    const { formatWindow } = await import("@/lib/computer/ax-tree");
    const msg = formatWindow(
      { elements: [], total: 0, degraded: true, degradedReason: "ax timeout" },
      [],
      { name: "OBS", pid: 2 },
    );
    // A reason from the driver is real signal and must not be swallowed.
    expect(msg).toContain("ax timeout");
  });

  it("says OCR gives positions, not refs — so nothing there is clickable", async () => {
    const { formatWindow } = await import("@/lib/computer/ax-tree");
    const msg = formatWindow({ elements: [], total: 0, degraded: false }, [], {
      name: "CapCut",
      pid: 3,
    });
    // Without this the model reads OCR output and tries to act on it, and there
    // is deliberately no coordinate form to act with.
    expect(msg).toMatch(/rather than refs/i);
  });
});

/**
 * The bundle-id branch, which carried the SAME over-match the display-name branch
 * was fixed for — and survived because the fix was tested only on names.
 *
 * `SHELL_APPS` contains `st` (the suckless terminal). `b.includes("st")` is true of
 * `com.apple.systempreferences`, so System Settings was refused AS A TERMINAL, with
 * the terminal wording. Observed live 2026-09-05. On one ordinary Mac, `st` alone
 * wrongly claimed six installed apps — including OBS, the very app the display-name
 * fix had been written for, because its bundle id defeated the fix anyway.
 */
describe("guardTargetApp — bundle ids need boundaries too", () => {
  const cases: Array<[string, string]> = [
    ["OBS", "com.obsproject.obs-studio"],
    ["App Store", "com.apple.appstore"],
    ["Podcasts", "com.apple.podcasts"],
    ["Stickies", "com.apple.stickies"],
    ["Stocks", "com.apple.stocks"],
  ];
  for (const [name, bundleId] of cases) {
    it(`does not call ${name} a terminal because its id contains "st"`, async () => {
      const { guardTargetApp } = await import("@/lib/computer/guards");
      const v = guardTargetApp({ name, bundleId });
      expect(v.allowed).toBe(true);
    });
  }

  it("still refuses System Settings — but as a CREDENTIAL surface, not a terminal", async () => {
    // It stays blocked: it is where TCC grants live, so an agent that could drive
    // it could grant itself permissions. Only the REASON was wrong.
    const { guardTargetApp } = await import("@/lib/computer/guards");
    const v = guardTargetApp({
      name: "System Settings",
      bundleId: "com.apple.systempreferences",
    });
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.reason).toMatch(/credentials or system permissions/i);
    expect(v.reason).not.toMatch(/terminal or shell/i);
  });

  it("still catches real terminals by bundle id, which is the point of the branch", async () => {
    const { guardTargetApp } = await import("@/lib/computer/guards");
    // A dot before and the end after; a dot before and a digit after (iterm2).
    for (const [name, bundleId] of [
      ["Terminal", "com.apple.terminal"],
      ["iTerm", "com.googlecode.iterm2"],
      ["Ghostty", "com.mitchellh.ghostty"],
      ["WezTerm", "com.github.wez.wezterm"],
      ["Alacritty", "org.alacritty"],
      ["kitty", "net.kovidgoyal.kitty"],
      ["st", "suckless.st"],
    ] as Array<[string, string]>) {
      const v = guardTargetApp({ name: "Innocuous Name", bundleId });
      expect(v.allowed, `${name} (${bundleId}) must still be refused`).toBe(false);
    }
  });

  it("catches a terminal even when the display name is disguised", async () => {
    // The bundle id is the harder thing to fake, which is why the branch exists.
    const { guardTargetApp } = await import("@/lib/computer/guards");
    const v = guardTargetApp({ name: "Notes", bundleId: "com.apple.terminal" });
    expect(v.allowed).toBe(false);
  });
});
