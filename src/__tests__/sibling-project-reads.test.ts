import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/glob";

/**
 * Looking at a sibling project must just work.
 *
 * `glob({path: "../telios"})` used to return a tool error while the byte-identical
 * ABSOLUTE path was accepted — reads have always been allowed anywhere. So an
 * agent asked to take a look at a neighbouring repo hit the error, then spent
 * `pwd`, `ls -la ..` and a `find` rediscovering a path it could have used from
 * the start. Four calls and a wrong turn to satisfy a spelling rule.
 *
 * The boundary is WHERE a path lands, not how it was written: writes to a
 * sibling still require an explicit folder grant (granted-folders.test.ts).
 */

let base = "";
let ws = "";
let sibling = "";

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-sib-")));
  ws = path.join(base, "wisdom-drop");
  sibling = path.join(base, "telios");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.mkdirSync(path.join(sibling, "Telios_Backend"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "own.ts"), "//");
  fs.writeFileSync(path.join(sibling, "README.md"), "# telios");
  fs.writeFileSync(path.join(sibling, "Telios_Backend", "app.py"), "print(1)");
});

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

/**
 * glob returns a formatted string on success; ToolRegistry wraps failures in an
 * envelope. Stringify either so assertions read the same for both.
 */
const glob = (args: Record<string, unknown>) =>
  ToolRegistry.execute("glob", { workspace: ws, ...args });

const text = (r: unknown) =>
  typeof r === "string" ? r : JSON.stringify(r ?? "");

describe("globbing a sibling project", () => {
  it("works with ../ — no error, real results", async () => {
    const out = text(await glob({ pattern: "**/*", path: "../telios" }));
    expect(out).not.toMatch(/may not contain|Failed to find/);
    expect(out).toMatch(/README\.md/);
    expect(out).toMatch(/app\.py/);
  });

  it("gives the same answer as the absolute path", async () => {
    const viaRelative = text(await glob({ pattern: "**/*", path: "../telios" }));
    const viaAbsolute = text(await glob({ pattern: "**/*", path: sibling }));
    expect(viaRelative).toBe(viaAbsolute);
  });

  it("breaks an mtime TIE deterministically, not by directory order", async () => {
    // Files that share an mtime — checked out together, generated together, or
    // just written in the same millisecond — used to come back in whatever order
    // the directory happened to enumerate in, so two identical calls could
    // disagree. It failed exactly once, on a release tag, having passed on the
    // same commit minutes earlier: the worst way to find out.
    //
    // Not only cosmetic. When a result is TRUNCATED at `limit`, an arbitrary
    // tie-break decides which files the agent is allowed to see.
    //
    // The tie is forced here rather than hoped for: on a filesystem with
    // high-resolution timestamps these two writes land microseconds apart and
    // never tie at all, which is why this only ever broke on CI.
    const tied = path.join(base, "tied");
    fs.mkdirSync(tied, { recursive: true });
    for (const name of ["zebra.md", "alpha.md", "middle.md"]) {
      fs.writeFileSync(path.join(tied, name), "x");
      fs.utimesSync(path.join(tied, name), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    }

    const first = text(await glob({ pattern: "**/*", path: tied }));
    for (let i = 0; i < 5; i++) {
      expect(text(await glob({ pattern: "**/*", path: tied }))).toBe(first);
    }
    expect(first.indexOf("alpha.md")).toBeLessThan(first.indexOf("middle.md"));
    expect(first.indexOf("middle.md")).toBeLessThan(first.indexOf("zebra.md"));
  });

  it("bare .. reaches the parent directory", async () => {
    const out = text(await glob({ pattern: "**/*", path: ".." }));
    expect(out).toMatch(/telios/);
  });

  it("ordinary in-workspace globs are unchanged", async () => {
    expect(text(await glob({ pattern: "**/*.ts" }))).toMatch(/own\.ts/);
  });

  it("a `..` inside the PATTERN is still refused", async () => {
    // The path says where to root the search; a traversal hidden in the pattern
    // would wander out of it regardless of that root.
    expect(text(await glob({ pattern: "../*", path: "." }))).toMatch(/\.\./);
  });

  it("an absolute-looking relative paste is still refused", async () => {
    // Not a location to allow — a dropped leading slash is a typo, and resolving
    // it under the workspace would silently target the wrong tree.
    expect(text(await glob({ pattern: "*", path: "Users/me/elsewhere" }))).toMatch(
      /outside|escape|not.*allow|fail/i,
    );
  });
});
