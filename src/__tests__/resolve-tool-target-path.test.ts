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
  const base = realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-ttp-")),
  );
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

  // A `../` path resolves the way the shell would, and is REPORTED as outside.
  // It used to throw — while the byte-identical absolute path was allowed — so
  // an agent asked to look at a sibling project hit a tool error and then spent
  // `pwd`, `ls ..` and a `find` rediscovering a path it could have read all
  // along. The boundary is WHERE a path lands, never how it was spelled.
  it("resolves an explicit ../ path and flags it as outside", () => {
    const r = resolveToolTargetPath(WS, "../sibling/file.ts");
    expect(r.isOutsideWorkspace).toBe(true);
    expect(r.absPath).toBe(path.join(path.dirname(WS), "sibling", "file.ts"));
  });

  it("a ../ that lands back INSIDE is not flagged as outside", () => {
    const r = resolveToolTargetPath(WS, `../${path.basename(WS)}/src/a.ts`);
    expect(r.isOutsideWorkspace).toBe(false);
    expect(r.absPath).toBe(path.join(WS, "src", "a.ts"));
  });

  it("bare `..` resolves to the parent", () => {
    expect(resolveToolTargetPath(WS, "..").absPath).toBe(path.dirname(WS));
  });

  // Still a mistake to catch, not a location to allow: an absolute path that
  // lost its leading slash is a paste error, and resolving it under the
  // workspace would silently target the wrong file.
  it("still rejects an absolute-looking relative paste", () => {
    expect(() => resolveToolTargetPath(WS, "Users/me/x")).toThrow();
  });

  it("ordinary relative paths stay confined", () => {
    const r = resolveToolTargetPath(WS, "src/a.ts");
    expect(r.isOutsideWorkspace).toBe(false);
    expect(r.absPath).toBe(path.join(WS, "src", "a.ts"));
  });
});
