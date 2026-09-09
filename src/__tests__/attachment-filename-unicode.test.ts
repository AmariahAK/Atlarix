/**
 * An attachment keeps the name its owner gave it, and still cannot traverse.
 *
 * Same ASCII assumption as the session-title bug, found by looking for its
 * siblings: `[^\w\s.\-()·]` with JavaScript's ASCII-only `\w` replaced every
 * non-Latin filename with underscores. This one is worse in one respect — it has
 * nothing to do with model output. These are the user's OWN files, so it has been
 * mangling them for every non-English user since it was written, and the
 * attachment chip displayed the damage back to them each time.
 *
 * BOTH properties are asserted here on purpose. The reason the class existed is
 * real: filenames reach the filesystem, so separators, the Windows-reserved set
 * and control characters must not survive. A fix that keeps Cyrillic but lets a
 * separator through would be a much worse bug than the one it replaced.
 */
import { describe, expect, it } from "vitest";
import { sanitizeAttachmentFilename as clean } from "@/lib/attachment-persistence";

describe("attachment filenames keep their language", () => {
  it("keeps Cyrillic", () => {
    expect(clean("отчёт.pdf")).toBe("отчёт.pdf");
  });
  it("keeps Chinese", () => {
    expect(clean("报告.pdf")).toBe("报告.pdf");
  });
  it("keeps Japanese", () => {
    expect(clean("レポート.pdf")).toBe("レポート.pdf");
  });
  it("keeps Korean", () => {
    expect(clean("보고서.pdf")).toBe("보고서.pdf");
  });
  it("keeps Devanagari, which needs combining marks", () => {
    expect(clean("रिपोर्ट.pdf")).toBe("रिपोर्ट.pdf");
  });
  it("keeps umlauts and Turkish letters mid-word", () => {
    expect(clean("Bericht_Übersicht.pdf")).toBe("Bericht_Übersicht.pdf");
    expect(clean("rapor-özet.pdf")).toBe("rapor-özet.pdf");
  });
  it("leaves plain ASCII names untouched", () => {
    expect(clean("report (final) v2.pdf")).toBe("report (final) v2.pdf");
  });
});

describe("attachment filenames still cannot traverse or break the filesystem", () => {
  it("strips path separators", () => {
    // The dots may remain; with no separator left there is nothing to traverse.
    const out = clean("../../etc/passwd");
    expect(out).not.toContain("/");
    expect(out).not.toContain("\\");
  });
  it("strips a Windows separator", () => {
    expect(clean("a\\b\\c.txt")).not.toContain("\\");
  });
  it("strips the Windows-reserved set", () => {
    const out = clean('a:b"c|d?e*f<g>h.txt');
    for (const ch of [":", '"', "|", "?", "*", "<", ">"]) {
      expect(out, `"${ch}" survived`).not.toContain(ch);
    }
  });
  it("strips control characters", () => {
    const out = clean(
      `a${String.fromCharCode(0)}b${String.fromCharCode(10)}c.txt`,
    );
    expect(out).not.toContain(String.fromCharCode(0));
  });
  it("still caps the length", () => {
    expect(clean("ä".repeat(500)).length).toBe(120);
  });
  it("still falls back when nothing survives", () => {
    expect(clean("///")).toBe("___");
    expect(clean("")).toBe("attachment");
  });
});
