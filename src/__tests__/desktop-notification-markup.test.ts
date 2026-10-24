/**
 * Linux notification bodies are parsed as markup by daemons that advertise
 * "body-markup": Electron passes `A & <b>x</b> < y` through unescaped and dunst
 * fails to parse it, then strips the tags ("A & x < y"). Escape for those
 * daemons only; a daemon without markup would show "&amp;" literally.
 */
import { describe, expect, it } from "vitest";
import {
  capabilitiesListMarkup,
  escapeNotificationMarkup,
  notificationBody,
} from "@/main/desktop-notification";

const BODY = "A & <b>x</b> < y";

describe("Linux notification bodies", () => {
  it("are escaped for a daemon that parses markup", async () => {
    expect(await notificationBody(BODY, "linux", async () => true)).toBe(
      "A &amp; &lt;b&gt;x&lt;/b&gt; &lt; y",
    );
  });

  it("are left as they are for a daemon that does not, and on other platforms", async () => {
    expect(await notificationBody(BODY, "linux", async () => false)).toBe(BODY);
    expect(await notificationBody(BODY, "darwin", async () => true)).toBe(BODY);
    expect(await notificationBody(BODY, "win32", async () => true)).toBe(BODY);
  });

  it("are cut to length before escaping, so no entity is cut in half", async () => {
    const long = "x".repeat(139) + "&";
    expect(await notificationBody(long, "linux", async () => true)).toBe(
      "x".repeat(139) + "&amp;",
    );
  });

  it("read body-markup from gdbus's and dbus-send's replies", () => {
    expect(
      capabilitiesListMarkup(
        "(['actions', 'body', 'body-hyperlinks', 'body-markup'],)",
      ),
    ).toBe(true);
    expect(
      capabilitiesListMarkup(
        'method return … array [ string "actions" string "body" string "body-markup" ]',
      ),
    ).toBe(true);
    expect(capabilitiesListMarkup("(['actions', 'body'],)")).toBe(false);
  });

  it("escapes only & < >", () => {
    expect(escapeNotificationMarkup(`"it's" & <ok>`)).toBe(
      `"it's" &amp; &lt;ok&gt;`,
    );
  });
});
