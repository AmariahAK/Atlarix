/**
 * Removing a workspace is two different actions wearing one trash icon, and the
 * copy has to tell them apart.
 *
 * For almost every workspace, `delete-app` touches nothing on disk — it drops the
 * DB rows and the folder stays put. For a workspace under an Atlarix-managed clone
 * root it really does `rm -rf` the folder. The old confirmation hedged across both
 * cases in one sentence, so taking a project off the list read as though it might
 * erase your code.
 *
 * The predicate below decides which confirmation is shown. Its previous form was
 * `appPath.includes("/Documents/Atlarix")`, which can NEVER match a Windows path —
 * so on Windows a managed workspace was described as safe and then had its files
 * deleted. That is the inverse of a scary message and considerably worse.
 */

import { describe, expect, it } from "vitest";
import { removalAlsoDeletesFiles } from "@/pages/welcome-launcher";

describe("removalAlsoDeletesFiles", () => {
  it("is false for an ordinary project folder — nothing on disk is touched", () => {
    expect(
      removalAlsoDeletesFiles("/Users/amariah/Documents/Github/wisdom-drop"),
    ).toBe(false);
    expect(removalAlsoDeletesFiles("/Users/amariah/code/vim")).toBe(false);
    expect(removalAlsoDeletesFiles("C:\\Users\\amariah\\code\\vim")).toBe(
      false,
    );
  });

  it("is true for the Atlarix-managed clone roots on POSIX", () => {
    expect(removalAlsoDeletesFiles("/Users/amariah/atlarix-apps/demo")).toBe(
      true,
    );
    expect(
      removalAlsoDeletesFiles("/Users/amariah/Documents/Atlarix/demo"),
    ).toBe(true);
  });

  it("is true for the same roots on WINDOWS — the bug this pins", () => {
    // The old `includes("/Documents/Atlarix")` check could not match either of
    // these, so the reassuring copy was shown for a removal that deletes files.
    expect(
      removalAlsoDeletesFiles("C:\\Users\\amariah\\atlarix-apps\\demo"),
    ).toBe(true);
    expect(
      removalAlsoDeletesFiles("C:\\Users\\amariah\\Documents\\Atlarix\\demo"),
    ).toBe(true);
  });

  it("matches path SEGMENTS, not substrings", () => {
    // A folder whose name merely CONTAINS the root name is not the root.
    expect(
      removalAlsoDeletesFiles("/Users/amariah/my-atlarix-apps-backup/demo"),
    ).toBe(false);
    expect(
      removalAlsoDeletesFiles("/Users/amariah/Documents/AtlarixNotes/demo"),
    ).toBe(false);
  });

  it("is case-insensitive, since Windows and macOS paths are", () => {
    expect(
      removalAlsoDeletesFiles("C:\\Users\\amariah\\Atlarix-Apps\\demo"),
    ).toBe(true);
    expect(
      removalAlsoDeletesFiles("/Users/amariah/documents/atlarix/demo"),
    ).toBe(true);
  });

  it("is false for a missing path rather than throwing", () => {
    expect(removalAlsoDeletesFiles(undefined)).toBe(false);
    expect(removalAlsoDeletesFiles(null)).toBe(false);
    expect(removalAlsoDeletesFiles("")).toBe(false);
  });
});
