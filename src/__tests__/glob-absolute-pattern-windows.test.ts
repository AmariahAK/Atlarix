/**
 * An absolute pattern resolves to a real directory on BOTH platforms.
 *
 * THE BUG, caught by a Windows runner and nothing else. `absorbPatternDirectoryPrefix`
 * rebuilt an absolute directory prefix as:
 *
 *   path.sep + dirSegments.join(path.sep)
 *
 * Splitting `/Users/me/x` on POSIX drops an empty leading segment, so the leading
 * separator has to be put back and the line is right. Windows has no such empty
 * segment: `C:\proj\sibling\**\*.go` came back as `\C:\proj\sibling`, which is not
 * a path. ripgrep was then started with it as its cwd, failed, and `glob` returned
 * `TOOL_ERROR: glob failed to run the pattern` — for EVERY absolute pattern on
 * Windows. The documented fallback for a failing glob is for the model to go
 * hunting with `ls`/`find`, which is the exact behaviour this absorber was written
 * to stop.
 *
 * WHY IT SURVIVED THREE RELEASES OF TESTS. The existing coverage
 * (`outside-path-spelling-parity`, `sibling-project-reads`) is real and it did
 * catch this — on Windows. It could not catch it anywhere else, because
 * `path.isAbsolute("C:\\proj")` is FALSE on macOS and Linux, so the broken branch
 * was unreachable from a developer machine. The code shipped in the v14.26.0 batch,
 * which was folded into v14.27.0 rather than tagged, and the installers only build
 * on a tag — so the first Windows run of it was the release itself.
 *
 * Hence the injected path flavour: the platform is now a parameter of the pure
 * function, so one machine tests both. That is the whole point of these tests —
 * without them the next separator bug waits for a tag again.
 */
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { absorbPatternDirectoryPrefix } from "@/lib/tools/glob";

const win = (pattern: string, searchPath = ".") =>
  absorbPatternDirectoryPrefix(pattern, searchPath, path.win32);
const posix = (pattern: string, searchPath = ".") =>
  absorbPatternDirectoryPrefix(pattern, searchPath, path.posix);

describe("absolute patterns on Windows", () => {
  it("keeps the drive letter as the root instead of prepending a separator", () => {
    // The regression, stated exactly: `\C:\proj\sibling-repo` is what broke.
    const out = win("C:\\proj\\sibling-repo\\**\\*.go");
    expect(out.searchPath).toBe("C:\\proj\\sibling-repo");
    expect(out.searchPath).not.toMatch(/^[\\/]/);
    expect(out.pattern).toBe("**/*.go");
  });

  it("handles a forward-slash spelling of a Windows path", () => {
    // Models write `C:/proj/...` at least as often as `C:\proj\...`.
    const out = win("C:/proj/sibling-repo/**/*.go");
    expect(out.searchPath).toBe("C:\\proj\\sibling-repo");
    expect(out.pattern).toBe("**/*.go");
  });

  it("keeps a UNC root intact", () => {
    // Naive concatenation loses one of the two leading slashes, which silently
    // turns a network path into a local one.
    const out = win("\\\\server\\share\\proj\\**\\*.ts");
    expect(out.searchPath.startsWith("\\\\server\\share")).toBe(true);
    expect(out.pattern).toBe("**/*.ts");
  });

  it("lists the directory when the pattern is only a location", () => {
    const out = win("C:\\proj\\sibling-repo");
    expect(out.searchPath).toBe("C:\\proj\\sibling-repo");
    expect(out.pattern).toBe("*");
  });

  it("still absorbs a ../ prefix, which was never the broken case", () => {
    const out = win("..\\sibling-repo\\**\\*.go");
    expect(out.searchPath).toBe("../sibling-repo");
    expect(out.pattern).toBe("**/*.go");
  });
});

describe("POSIX behaviour is unchanged", () => {
  it("rebuilds an absolute path with its leading slash", () => {
    const out = posix("/Users/me/sibling-repo/**/*.go");
    expect(out.searchPath).toBe("/Users/me/sibling-repo");
    expect(out.pattern).toBe("**/*.go");
  });

  it("absorbs a ../ prefix", () => {
    const out = posix("../sibling-repo/**/*.go");
    expect(out.searchPath).toBe("../sibling-repo");
    expect(out.pattern).toBe("**/*.go");
  });

  it("leaves a workspace-relative pattern completely alone", () => {
    expect(posix("src/**/*.ts")).toEqual({
      pattern: "src/**/*.ts",
      searchPath: ".",
    });
  });
});

describe("an explicit path still wins on both platforms", () => {
  it("does not retarget the search when the caller named a directory", () => {
    // The caller said where to look; a prefix in the pattern must not override it.
    for (const [name, f] of [
      ["win32", win],
      ["posix", posix],
    ] as const) {
      const out = f("/elsewhere/**/*.go", "/given/root");
      expect(out.searchPath, name).toBe("/given/root");
      expect(out.pattern, name).toBe("/elsewhere/**/*.go");
    }
  });
});
