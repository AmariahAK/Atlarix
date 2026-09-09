/**
 * ONE spelling rule for reaching outside the workspace, honoured by all four file
 * tools.
 *
 * Before this, the four disagreed:
 *   - glob / grep     accepted `../sibling` AND an absolute path
 *   - read_file       accepted absolute only; `../x` threw '".." is not allowed'
 *   - edit_file       accepted absolute only; `../x` was confined then failed
 *   - glob's PATTERN  hard-rejected any `..` with "Use a path within the project"
 *
 * So the byte-identical location resolved or failed depending on how it was typed,
 * and the one error message the model actually hit told it (falsely) that outside
 * work was forbidden — which is what sent it to `pwd`/`ls`/`find` and a guessed
 * parent directory instead of the tool that would have worked.
 *
 * The rule pinned here: **absolute is canonical, `../` is absorbed, and every tool
 * lands on the same absolute path either way.** Relative paths without `..` stay
 * confined under the workspace exactly as before — that containment invariant is
 * pinned separately by path-resolver-parity.test.ts and is NOT relaxed here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { realpathSync } from "node:fs";
import { ToolRegistry } from "@/lib/tools/registry";
import { absorbPatternDirectoryPrefix } from "@/lib/tools/glob";
import "@/lib/tools/file"; // registers read_file
import "@/lib/tools/edit"; // registers edit_file
import "@/lib/tools/glob"; // registers glob
import "@/lib/tools/grep"; // registers grep

let base = "";
let ws = "";
let sibling = "";

const MARKER = "cross-repo-marker-9c1f";

beforeEach(() => {
  base = realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-spelling-")),
  );
  ws = path.join(base, "workspace");
  sibling = path.join(base, "sibling-repo");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.mkdirSync(path.join(sibling, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "inside.ts"), `export const a = 1;\n`);
  fs.writeFileSync(
    path.join(sibling, "pkg", "loader.go"),
    `package loader\n\n// ${MARKER}\nconst Version = "1"\n`,
  );
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/** The same file, spelled both ways. */
function spellings(): { label: string; value: string }[] {
  return [
    { label: "absolute", value: path.join(sibling, "pkg", "loader.go") },
    {
      label: "parent-relative",
      value: path.join("..", "sibling-repo", "pkg", "loader.go"),
    },
  ];
}

describe("read_file: both spellings reach the same outside file", () => {
  it("resolves absolute and ../ to the same content", async () => {
    const results = await Promise.all(
      spellings().map(({ value }) =>
        ToolRegistry.execute("read_file", { workspace: ws, path: value }),
      ),
    );
    for (const [i, res] of results.entries()) {
      const text = typeof res === "string" ? res : JSON.stringify(res);
      expect(text, `spelling: ${spellings()[i].label}`).toContain(MARKER);
    }
  });

  it("an ordinary relative path still resolves inside the workspace", async () => {
    const res = await ToolRegistry.execute("read_file", {
      workspace: ws,
      path: "src/inside.ts",
    });
    expect(typeof res === "string" ? res : JSON.stringify(res)).toContain(
      "export const a = 1",
    );
  });
});

describe("edit_file: both spellings reach the same outside file", () => {
  it("absolute and ../ both produce a permission envelope for the same absolute path", async () => {
    const results = (await Promise.all(
      spellings().map(({ value }) =>
        ToolRegistry.execute("edit_file", {
          workspace: ws,
          path: value,
          operation: "replace",
          old_content: 'const Version = "1"',
          new_content: 'const Version = "2"',
        }),
      ),
    )) as {
      preview?: { path: string };
      __permission_required?: boolean;
      error?: string;
    }[];

    const expected = path.join(sibling, "pkg", "loader.go");
    for (const [i, res] of results.entries()) {
      const which = spellings()[i].label;
      expect(res.error, `spelling: ${which}`).toBeUndefined();
      expect(res.__permission_required, `spelling: ${which}`).toBe(true);
      expect(res.preview?.path, `spelling: ${which}`).toBe(expected);
    }
    // Neither spelling wrote anything — the gate governs the write.
    expect(fs.readFileSync(expected, "utf8")).toContain('const Version = "1"');
  });
});

describe("glob: a directory prefix in the pattern is absorbed, not refused", () => {
  it("finds an outside file from the pattern alone", async () => {
    const res = await ToolRegistry.execute("glob", {
      workspace: ws,
      pattern: path.join("..", "sibling-repo", "**", "*.go"),
    });
    const text = typeof res === "string" ? res : JSON.stringify(res);
    expect(text).toContain("loader.go");
  });

  it("agrees with the explicit path form", async () => {
    const viaPath = await ToolRegistry.execute("glob", {
      workspace: ws,
      pattern: "**/*.go",
      path: sibling,
    });
    const viaPattern = await ToolRegistry.execute("glob", {
      workspace: ws,
      pattern: path.join(sibling, "**", "*.go"),
    });
    const a = typeof viaPath === "string" ? viaPath : JSON.stringify(viaPath);
    const b =
      typeof viaPattern === "string" ? viaPattern : JSON.stringify(viaPattern);
    expect(a).toContain("loader.go");
    expect(b).toContain("loader.go");
  });

  it("never returns the old dead-end error for a '..' pattern", async () => {
    const res = await ToolRegistry.execute("glob", {
      workspace: ws,
      pattern: path.join("..", "sibling-repo", "*"),
    });
    const text = typeof res === "string" ? res : JSON.stringify(res);
    expect(text).not.toContain("may not contain");
    expect(text).not.toContain("Use a path within the project");
  });
});

describe("grep: both spellings search the same outside tree", () => {
  it("absolute and ../ both find the marker", async () => {
    const results = await Promise.all(
      [sibling, path.join("..", "sibling-repo")].map((p) =>
        ToolRegistry.execute("grep", {
          workspace: ws,
          pattern: MARKER,
          path: p,
        }),
      ),
    );
    for (const res of results) {
      const text = typeof res === "string" ? res : JSON.stringify(res);
      expect(text).toContain("loader.go");
    }
  });
});

describe("absorbPatternDirectoryPrefix", () => {
  const sep = path.sep;

  it("splits a ../ directory prefix off the pattern", () => {
    expect(absorbPatternDirectoryPrefix("../telios/**/*.go", ".")).toEqual({
      pattern: "**/*.go",
      searchPath: "../telios",
    });
  });

  it("treats a bare outside directory as a listing", () => {
    expect(absorbPatternDirectoryPrefix("../telios", ".")).toEqual({
      pattern: "*",
      searchPath: "../telios",
    });
  });

  it("keeps the parent when the pattern is the only segment left", () => {
    expect(absorbPatternDirectoryPrefix("../*.ts", ".")).toEqual({
      pattern: "*.ts",
      searchPath: "..",
    });
  });

  it("handles an absolute prefix without losing the root", () => {
    expect(
      absorbPatternDirectoryPrefix(`${sep}abs${sep}dir${sep}**/*.ts`, "."),
    ).toEqual({
      pattern: "**/*.ts",
      searchPath: `${sep}abs${sep}dir`,
    });
  });

  it("leaves an ordinary workspace pattern alone", () => {
    expect(absorbPatternDirectoryPrefix("src/**/*.ts", ".")).toEqual({
      pattern: "src/**/*.ts",
      searchPath: ".",
    });
  });

  it("does not retarget when the caller supplied an explicit path", () => {
    // The caller said WHERE to look; a directory-looking pattern must not override
    // it, or `glob({pattern:"../x/*", path:"/somewhere"})` would silently search
    // somewhere other than what was asked for.
    expect(absorbPatternDirectoryPrefix("../telios/*.go", "/explicit")).toEqual(
      {
        pattern: "../telios/*.go",
        searchPath: "/explicit",
      },
    );
  });
});
