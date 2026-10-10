import { describe, expect, it } from "vitest";
import { editorLink, guessEditor, openCommand } from "@/lib/peers/open-in-editor";

describe("open in your editor", () => {
  it("links to the extension's handler with the session and folder", () => {
    const url = editorLink("cursor", "abc-123", "/Users/me/my app");
    expect(url).toBe("cursor://atlarix.atlarix/open?session=abc-123&folder=%2FUsers%2Fme%2Fmy+app");
  });

  it("picks the editor whose terminal the CLI is running in", () => {
    expect(guessEditor({ VSCODE_GIT_ASKPASS_NODE: "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper" })).toBe("cursor");
    expect(guessEditor({ VSCODE_GIT_ASKPASS_NODE: "C:\\Users\\x\\AppData\\Local\\Programs\\Kiro\\Kiro.exe" })).toBe("kiro");
    expect(guessEditor({})).toBe("vscode");
  });

  it("escapes & for cmd's start on Windows", () => {
    expect(openCommand("win32", "vscode://a/open?session=1&folder=x").args).toEqual(["/c", "start", "", "vscode://a/open?session=1^&folder=x"]);
    expect(openCommand("darwin", "vscode://x").file).toBe("open");
  });
});
