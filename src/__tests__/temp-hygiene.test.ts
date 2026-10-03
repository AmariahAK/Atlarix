/**
 * The sweep must delete our leftovers and nothing else.
 *
 * This is the whole risk of the feature. Atlarix's temp directories were never
 * cleaned by anything — `atlarix-attachments` is created at module load and no
 * code has ever removed it — and we relied on the OS, which is fine on macOS,
 * mostly fine on Linux, and simply false on Windows, where `%TEMP%` is never
 * cleaned unless the user turned Storage Sense on. We ship a Windows build.
 *
 * But `os.tmpdir()` is shared, and the agent writes into it. A sweep that
 * matched too widely would delete a user's files, so the predicate — prefix,
 * top level only, real directory only — is the safety argument, and it is what
 * these tests pin rather than the deletion itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The real temp root, captured BEFORE the `node:os` mock below rewrites
// `tmpdir()` — otherwise this file would try to create its scratch dirs inside
// the fake root it is about to define, which is the previous test's deleted one.
// Windows sets TEMP/TMP, not TMPDIR; "/tmp" there resolves to D:\tmp, which
// does not exist (the v15.0.0 Windows job failed on exactly that).
const REAL_TMP = fs.realpathSync(process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp");

vi.mock("electron-log", () => {
  const scope = () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  });
  return { default: { scope, ...scope() } };
});

let fakeTmp = "";
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, default: { ...actual, tmpdir: () => fakeTmp } };
});

import { __testing } from "@/main/temp-hygiene";

const sweep = __testing.sweepTempDirs;

beforeEach(() => {
  fakeTmp = fs.realpathSync(
    fs.mkdtempSync(path.join(REAL_TMP, "hygiene-test-")),
  );
});

afterEach(() => {
  try {
    fs.rmSync(fakeTmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const mkdir = (name: string) => {
  const p = path.join(fakeTmp, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

describe("sweepTempDirs — what it will and will not touch", () => {
  it("removes our own directories", async () => {
    const ours = [
      mkdir("atlarix-attachments"),
      mkdir("atlarix-scratch"),
      mkdir("atlarix-cli-install-1234"),
    ];
    fs.writeFileSync(path.join(ours[0]!, "spill.txt"), "x");
    // NOT a fresh `atlarix-headless-*`: that belongs to another process and has
    // its own rule, covered below.

    expect(await sweep({ includeLive: true })).toBe(3);
    for (const p of ours) expect(fs.existsSync(p)).toBe(false);
  });

  it("NEVER touches anything that is not ours", async () => {
    // The agent writes into /tmp constantly, and so does everything else on the
    // machine. Each of these is a real shape that sits next to ours.
    const theirs = [
      mkdir("important-user-data"),
      mkdir("com.apple.something"),
      mkdir("pip-build-env-xyz"),
      mkdir("vscode-typescript"),
      // A near-miss: the prefix must be a prefix, not a substring.
      mkdir("not-atlarix-stuff"),
      mkdir("my-atlarix-backup"),
    ];
    const looseFile = path.join(fakeTmp, "atlarix-notes.txt");
    fs.writeFileSync(looseFile, "a file, not a directory");

    expect(await sweep({ includeLive: true })).toBe(0);
    for (const p of theirs) expect(fs.existsSync(p)).toBe(true);
    // A FILE named atlarix-… is not swept either: the sweep removes
    // directories, and widening it to files is how a glob starts eating things.
    expect(fs.existsSync(looseFile)).toBe(true);
  });

  it("refuses a symlink even when it carries our prefix", async () => {
    // The one way a path we "own" can point somewhere we do not. Following it
    // with `rm -rf` would delete the target, not the link.
    const target = mkdir("precious-target");
    fs.writeFileSync(path.join(target, "keep.txt"), "x");
    fs.symlinkSync(target, path.join(fakeTmp, "atlarix-evil-link"));

    expect(await sweep({ includeLive: true })).toBe(0);
    expect(fs.existsSync(path.join(target, "keep.txt"))).toBe(true);
  });

  it("only looks at the top level, never recursively", async () => {
    // A nested `atlarix-…` inside someone else's directory is theirs, not ours.
    const outer = mkdir("someone-elses-project");
    const nested = path.join(outer, "atlarix-attachments");
    fs.mkdirSync(nested, { recursive: true });

    expect(await sweep({ includeLive: true })).toBe(0);
    expect(fs.existsSync(nested)).toBe(true);
  });
});

describe("app open takes the remainder, but never what this run is using", () => {
  it("removes leftovers from a previous run with no age gate", async () => {
    // A close can be skipped by a crash, a kill -9 or a forced reboot, so
    // anything here that this process is not holding open is left over from a
    // run that has ended — age is not the question.
    const leftovers = [mkdir("atlarix-cli-install-999"), mkdir("atlarix-x")];
    expect(await sweep({ includeLive: false })).toBe(2);
    for (const p of leftovers) expect(fs.existsSync(p)).toBe(false);
  });

  it("does NOT delete the directories this process holds open", async () => {
    // `atlarix-attachments` is created once at module load and its path is kept
    // in a const for the session. Deleting it mid-run breaks the next
    // attachment write with a bare ENOENT — and an age gate would not save it,
    // because mkdirSync on an existing dir does not refresh its mtime, so a dir
    // inherited from a previous run looks old while being actively used.
    const attachments = mkdir("atlarix-attachments");
    const scratch = mkdir("atlarix-scratch");
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const p of [attachments, scratch]) {
      fs.utimesSync(p, new Date(old), new Date(old));
    }

    expect(await sweep({ includeLive: false })).toBe(0);
    expect(fs.existsSync(attachments)).toBe(true);
    expect(fs.existsSync(scratch)).toBe(true);

    // …and the close pass does take them.
    expect(await sweep({ includeLive: true })).toBe(2);
    expect(fs.existsSync(attachments)).toBe(false);
  });

  it("will not touch a RECENT headless dir — another process may own it", async () => {
    // The single-instance lock covers the desktop app and says nothing about a
    // headless run, which is a separate process that can be mid-task while the
    // app opens or quits. Sweeping one would destroy a live run's user data.
    const live = mkdir("atlarix-headless-ud-live");
    expect(await sweep({ includeLive: true })).toBe(0);
    expect(fs.existsSync(live)).toBe(true);

    // Old enough to be certainly dead → taken.
    const old = Date.now() - 3 * 24 * 60 * 60 * 1000;
    fs.utimesSync(live, new Date(old), new Date(old));
    expect(await sweep({ includeLive: true })).toBe(1);
  });
});
