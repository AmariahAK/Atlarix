/**
 * 2026-10-13: a QA build launched on a fresh profile asked "Move to
 * Applications Folder?" with Move as the default, and one Enter replaced the
 * installed Atlarix (sent to the Trash) with the test build. When one is
 * there, the dialog says so and keeping it is the default.
 */
import { describe, it, expect } from "vitest";
import { moveToApplicationsDialog } from "@/main/update-helpers";

describe("the move-to-Applications dialog", () => {
  it("with nothing in Applications, Move is the default", () => {
    const d = moveToApplicationsDialog(null);
    expect(d.defaultId).toBe(0);
    expect(d.detail).toBeUndefined();
  });

  it("with an Atlarix already there, it names it and defaults to Do Not Move", () => {
    const d = moveToApplicationsDialog({ name: "Atlarix", version: "15.4.2" });
    expect(d.buttons[d.defaultId]).toBe("Do Not Move");
    expect(d.detail).toBe("Atlarix 15.4.2 is already in Applications. Moving replaces it, and it goes to the Trash.");
  });
});
