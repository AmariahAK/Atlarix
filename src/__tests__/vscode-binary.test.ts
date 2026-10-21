/**
 * Which agent the VS Code extension runs. A configured `atlarix.cliPath` is a
 * choice (a dev build, a pinned version): when it cannot run, the extension
 * says so instead of quietly running another agent (QA E16: the bundled one,
 * or a different version found on PATH, against the owner's real profile).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findAtlarix } from "../../packages/vscode/src/binary";

const EXE = process.platform === "win32" ? "atlarix.exe" : "atlarix";
let root: string;
let savedPath: string | undefined;

function exe(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vsc-bin-"));
  savedPath = process.env.PATH;
  process.env.PATH = "";
});
afterEach(() => {
  process.env.PATH = savedPath;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the agent the extension runs", () => {
  it("is the configured cliPath when it runs", () => {
    exe(path.join(root, "ext", "bin", EXE));
    const mine = exe(path.join(root, "dev", EXE));
    expect(findAtlarix(path.join(root, "ext"), mine)).toEqual({ binary: mine });
  });

  it("is none when the configured cliPath can't run: never the bundled one or one on PATH instead", () => {
    exe(path.join(root, "ext", "bin", EXE));
    process.env.PATH = path.dirname(exe(path.join(root, "brew", EXE)));
    const gone = path.join(root, "dev", EXE);
    expect(findAtlarix(path.join(root, "ext"), gone)).toEqual({ binary: null, badSetting: gone });
  });

  it("is the bundled one with no setting, then the one on PATH", () => {
    const onPath = exe(path.join(root, "brew", EXE));
    process.env.PATH = path.dirname(onPath);
    const bundled = exe(path.join(root, "ext", "bin", EXE));
    expect(findAtlarix(path.join(root, "ext"), "")).toEqual({ binary: bundled });
    fs.rmSync(bundled);
    expect(findAtlarix(path.join(root, "ext"), undefined)).toEqual({ binary: onPath });
    fs.rmSync(onPath);
    expect(findAtlarix(path.join(root, "ext"), undefined)).toEqual({ binary: null, badSetting: null });
  });
});
