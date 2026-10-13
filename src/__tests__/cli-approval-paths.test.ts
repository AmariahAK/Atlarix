import { describe, expect, it } from "vitest";
import { nativeDir, outsideWorkspace } from "@/cli/agent/approval-choices";

describe("approval paths as each system writes them (QA, Windows VM)", () => {
  it("a Windows folder keeps its backslashes", () => {
    expect(nativeDir("C:/Users/Public")).toBe("C:\\Users\\Public\\");
    expect(nativeDir("src/lib")).toBe("src/lib/");
  });

  it("knows a file outside the project, on Windows and elsewhere", () => {
    const ws = "C:\\Users\\Amariah Abishai\\atlarix-qa\\ws one";
    expect(outsideWorkspace("C:\\Users\\Public\\atlarix qa test.txt", ws)).toBe(true);
    expect(outsideWorkspace("c:/users/amariah abishai/atlarix-qa/ws one/src/math.ts", ws)).toBe(false);
    expect(outsideWorkspace("src/math.ts", ws)).toBe(false);
    expect(outsideWorkspace("/tmp/x.txt", "/Users/me/app")).toBe(true);
    expect(outsideWorkspace("/Users/me/app-old/x.ts", "/Users/me/app")).toBe(true);
    expect(outsideWorkspace("/Users/me/app/x.ts", "/Users/me/app")).toBe(false);
  });
});
