import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertRealpathContained } from "@/lib/security/realpath-contain";

// Real symlinks on disk — the whole point is that a string check can't see them.
let ws: string;
let outside: string;

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-realpath-"));
  ws = path.join(base, "workspace");
  outside = path.join(base, "outside");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(ws, "app.ts"), "ok");
  fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET");
  // A symlink that LIVES inside the workspace but points OUTSIDE it.
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "leak.txt"));
  // A symlink to another in-workspace file (must stay allowed).
  fs.symlinkSync(path.join(ws, "app.ts"), path.join(ws, "alias.ts"));
});

afterAll(() => {
  try {
    fs.rmSync(path.dirname(ws), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("assertRealpathContained", () => {
  it("rejects a workspace symlink whose real target escapes the workspace", () => {
    expect(() =>
      assertRealpathContained(path.join(ws, "leak.txt"), ws, [], "leak.txt"),
    ).toThrow(/escapes the workspace via a symlink/);
  });

  it("allows a real in-workspace file", () => {
    expect(() =>
      assertRealpathContained(path.join(ws, "app.ts"), ws, [], "app.ts"),
    ).not.toThrow();
  });

  it("allows a symlink that stays inside the workspace", () => {
    expect(() =>
      assertRealpathContained(path.join(ws, "alias.ts"), ws, [], "alias.ts"),
    ).not.toThrow();
  });

  it("allows the escaping target when its real dir is an allowed root", () => {
    expect(() =>
      assertRealpathContained(
        path.join(ws, "leak.txt"),
        ws,
        [outside],
        "leak.txt",
      ),
    ).not.toThrow();
  });

  it("fails open when the workspace root can't be canonicalized", () => {
    expect(() =>
      assertRealpathContained(
        "/nope/leak.txt",
        "/does/not/exist",
        [],
        "leak.txt",
      ),
    ).not.toThrow();
  });
});
