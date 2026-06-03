import { describe, expect, it } from "vitest";
import {
  cleanPreviewErrorFilePath,
  previewErrorMatchesFile,
} from "@/lib/monaco/preview-error-paths";

describe("preview-error-paths", () => {
  it("strips localhost URL to project-relative path", () => {
    expect(
      cleanPreviewErrorFilePath(
        "http://localhost:5174/src/components/App.tsx",
      ),
    ).toBe("src/components/App.tsx");
  });

  it("matches editor path to preview error path", () => {
    expect(
      previewErrorMatchesFile(
        "http://localhost:5174/src/App.tsx",
        "src/App.tsx",
      ),
    ).toBe(true);
  });
});
