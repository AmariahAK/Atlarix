/**
 * resolveToolTargetPath: an EXPLICIT absolute path may target outside the
 * workspace (caller decides policy — reads auto-allow, writes gate); a RELATIVE
 * path stays confined under the workspace exactly as before.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { realpathSync } from "node:fs";
import { resolveToolTargetPath } from "@/ipc/utils/safeWorkspaceRelativePath";

let WS = "";
let OUTSIDE = "";

beforeAll(() => {
  // Real dirs so realpath (symlink defusing) resolves deterministically.
  const base = realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-ttp-")));
  WS = path.join(base, "workspace");
  OUTSIDE = path.join(base, "other-repo");
  fs.mkdirSync(path.join(WS, "src"), { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
  fs.writeFileSync(path.join(WS, "src", "app.ts"), "x");
  fs.writeFileSync(path.join(OUTSIDE, "loader.go"), "x");
});

afterAll(() => {
  try {
    fs.rmSync(path.dirname(WS), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("resolveToolTargetPath", () => {
  it("relative path → confined under the workspace, not outside", () => {
    const r = resolveToolTargetPath(WS, "src/app.ts");
    expect(r.isOutsideWorkspace).toBe(false);
    expect(r.absPath).toBe(path.join(WS, "src", "app.ts"));
  });

  it("absolute path INSIDE the workspace → allowed, not outside", () => {
    const r = resolveToolTargetPath(WS, path.join(WS, "src", "app.ts"));
    expect(r.isOutsideWorkspace).toBe(false);
    expect(r.absPath).toBe(path.join(WS, "src", "app.ts"));
  });

  it("absolute path OUTSIDE the workspace → allowed + flagged outside", () => {
    const target = path.join(OUTSIDE, "loader.go");
    const r = resolveToolTargetPath(WS, target);
    expect(r.isOutsideWorkspace).toBe(true);
    expect(r.absPath).toBe(target);
  });

  it("relative escapes stay confined (throw, as before)", () => {
    expect(() => resolveToolTargetPath(WS, "../escape.txt")).toThrow();
    expect(() => resolveToolTargetPath(WS, "Users/me/x")).toThrow(); // absolute-looking relative paste
  });
});
