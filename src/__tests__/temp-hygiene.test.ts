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
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
import { peerSocketPath } from "@/lib/peers/peers";

const sweep = __testing.sweepTempDirs;

let peerDir = "";
beforeEach(() => {
  fakeTmp = fs.realpathSync(
    fs.mkdtempSync(path.join(REAL_TMP, "hygiene-test-")),
  );
  // Peer inboxes are looked for here, not in the machine's real /tmp, where any
  // Atlarix running on this computer would change the answer.
  // Short: a Unix socket path is capped at 104 bytes on macOS, and the real
  // temp folder's path is most of that.
  peerDir = fs.mkdtempSync(process.platform === "win32" ? path.join(REAL_TMP, "hygiene-peers-") : "/tmp/hyp-");
  __testing.setPeerSocketDir?.(peerDir);
});

afterEach(() => {
  __testing.setPeerSocketDir?.(null);
  fs.rmSync(peerDir, { recursive: true, force: true });
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

describe("several Atlarix processes at once (app, CLI, editors, headless)", () => {
  // A process that is certainly running (the one that started this test), and
  // one that certainly is not (it ran and exited).
  const livePid = process.ppid;
  const deadPid = (() => {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    return spawnSync(process.execPath, ["-e", ""]).pid!;
  })();
  const lease = (pid: number) => {
    const dir = mkdir(__testing.LEASES_DIR_NAME);
    const p = path.join(dir, `${pid}.json`);
    fs.writeFileSync(p, JSON.stringify({ pid, surface: "cli" }));
    return p;
  };
  const age = (p: string, ms: number) => {
    const t = new Date(Date.now() - ms);
    fs.utimesSync(p, t, t);
  };

  it("quitting keeps the shared dirs while another Atlarix is still running", async () => {
    // The app quitting used to delete atlarix-scratch under a CLI session.
    lease(livePid);
    const scratch = mkdir("atlarix-scratch");
    const attachments = mkdir("atlarix-attachments");
    await sweep({ includeLive: true });
    expect(fs.existsSync(scratch)).toBe(true);
    expect(fs.existsSync(attachments)).toBe(true);
  });

  it("keeps a fresh leftover another process may have just made; takes an old one", async () => {
    lease(livePid);
    const fresh = mkdir("atlarix-view-image-fresh");
    const old = mkdir("atlarix-view-image-old");
    age(old, 2 * 60 * 60 * 1000);
    await sweep({ includeLive: false });
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
  });

  it("ignores, and removes, the lease of a process that has ended", async () => {
    const stale = lease(deadPid);
    const scratch = mkdir("atlarix-scratch");
    await sweep({ includeLive: true });
    expect(fs.existsSync(scratch)).toBe(false);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("never sweeps the leases themselves", async () => {
    const own = lease(livePid);
    age(path.dirname(own), 30 * 24 * 60 * 60 * 1000);
    await sweep({ includeLive: true });
    expect(fs.existsSync(own)).toBe(true);
  });

  /**
   * E4 (QA, 2 of 2): a 15.9.2 Atlarix (no leases yet) running, a newer one
   * quits: it counted only leases, took the shared dirs as the last Atlarix,
   * and deleted the running one's scratch file. Builds before leases still hold
   * a peer inbox named by their pid.
   */
  const inboxFile = (pid: number) => path.join(peerDir, path.basename(peerSocketPath(process.platform, pid)));
  const servers: net.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((srv) => new Promise((r) => srv.close(r))));
    __testing.setConnect?.(null);
  });
  /** An inbox its owner is listening on. */
  const inbox = async (pid: number) => {
    const p = inboxFile(pid);
    const srv = net.createServer((c) => c.destroy());
    await new Promise<void>((r) => srv.listen(p, r));
    servers.push(srv);
    return p;
  };
  /** The socket file a killed or crashed owner left: nothing listens on it. */
  const leftInbox = (pid: number) => {
    const p = inboxFile(pid);
    const child = spawnSync(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(p)}, () => process.kill(process.pid, "SIGKILL"))`,
    ]);
    expect(child.signal).toBe("SIGKILL");
    expect(fs.existsSync(p)).toBe(true);
    return p;
  };

  // Inboxes are named pipes on Windows (QA checks those live).
  it.skipIf(process.platform === "win32")("an older Atlarix with no lease, but its peer inbox, keeps the shared dirs", async () => {
    await inbox(livePid);
    const scratch = mkdir("atlarix-scratch");
    fs.writeFileSync(path.join(scratch, "its-file.txt"), "in use");
    const attachments = mkdir("atlarix-attachments");
    const fresh = mkdir("atlarix-view-image-fresh");
    await sweep({ includeLive: true });
    expect(fs.existsSync(path.join(scratch, "its-file.txt"))).toBe(true);
    expect(fs.existsSync(attachments)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  // Inboxes are named pipes on Windows (QA checks those live).
  it.skipIf(process.platform === "win32")("the inbox of an Atlarix that has ended, or another user's, protects nothing", async () => {
    const ended = leftInbox(deadPid);
    const theirs = path.join(peerDir, "atlarix-peer-somebody-else-" + livePid + ".sock");
    fs.writeFileSync(theirs, "");
    const scratch = mkdir("atlarix-scratch");
    await sweep({ includeLive: true });
    expect(fs.existsSync(scratch)).toBe(false);
    // Nothing owns a refusing inbox now: it goes. Another user's is left alone.
    await vi.waitFor(() => expect(fs.existsSync(ended)).toBe(false));
    expect(fs.existsSync(theirs)).toBe(true);
  });

  /**
   * E4 alone (QA, 2 of 2): left inboxes named by pids since reused (a zsh, an
   * unrelated test run) counted as running Atlarixes, so the shared dirs were
   * never cleaned. Alive is not enough: the inbox must answer.
   */
  // Inboxes are named pipes on Windows (QA checks those live).
  it.skipIf(process.platform === "win32")("a left inbox whose pid is alive again (reused) protects nothing, and is removed", async () => {
    const left = leftInbox(livePid);
    const scratch = mkdir("atlarix-scratch");
    await sweep({ includeLive: true });
    expect(fs.existsSync(scratch)).toBe(false);
    await vi.waitFor(() => expect(fs.existsSync(left)).toBe(false));
  });

  it("an inbox that does not answer in time is kept and counted, and many do not hold the sweep up", async () => {
    // Connections that never complete: "don't know", which keeps the dirs.
    __testing.setConnect?.(() => new net.Socket());
    const files = Array.from({ length: 120 }, (_, i) => {
      const p = inboxFile(livePid + 100_000 + i);
      fs.writeFileSync(p, "");
      return p;
    });
    fs.writeFileSync(inboxFile(livePid), "");
    const scratch = mkdir("atlarix-scratch");
    const t0 = Date.now();
    await sweep({ includeLive: true });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(fs.existsSync(scratch)).toBe(true);
    expect(fs.existsSync(inboxFile(livePid))).toBe(true);
    for (const f of files) expect(fs.existsSync(f)).toBe(true);
  });

  it("with nothing else running, quitting still cleans up", async () => {
    const scratch = mkdir("atlarix-scratch");
    const attachments = mkdir("atlarix-attachments");
    await sweep({ includeLive: true });
    expect(fs.existsSync(scratch)).toBe(false);
    expect(fs.existsSync(attachments)).toBe(false);
  });

  it("the LAST Atlarix to exit leaves no directory of ours behind, the leases dir included (E4)", async () => {
    // Windows piled these up per workspace in %TEMP%, empty.
    const { registerTempLease, sweepTempOnQuit } = await import("@/main/temp-hygiene");
    registerTempLease("acp");
    mkdir(path.join("atlarix-scratch", "my-project-ab12"));
    mkdir("atlarix-attachments");
    await sweepTempOnQuit();
    expect(fs.readdirSync(fakeTmp).filter((n) => n.startsWith("atlarix-"))).toEqual([]);
  });

  it("while another Atlarix runs, an EMPTY shared dir stays: it may be about to write there", async () => {
    // Both writers create their dir once and remember it (attachments at module
    // load, scratch per session); removing it under them breaks the next write.
    const { registerTempLease, sweepTempOnQuit } = await import("@/main/temp-hygiene");
    lease(livePid);
    registerTempLease("acp");
    const ws = mkdir(path.join("atlarix-scratch", "my-project-ab12"));
    const attachments = mkdir("atlarix-attachments");
    await sweepTempOnQuit();
    expect(fs.existsSync(ws)).toBe(true);
    expect(fs.existsSync(attachments)).toBe(true);
    expect(fs.existsSync(path.join(fakeTmp, __testing.LEASES_DIR_NAME))).toBe(true);
  });

  it("a process's own lease does not protect its dirs from its own exit sweep", async () => {
    const { registerTempLease, sweepTempOnQuit } = await import("@/main/temp-hygiene");
    registerTempLease("cli");
    const mine = path.join(fakeTmp, __testing.LEASES_DIR_NAME, `${process.pid}.json`);
    expect(fs.existsSync(mine)).toBe(true);
    const scratch = mkdir("atlarix-scratch");
    await sweepTempOnQuit();
    expect(fs.existsSync(mine)).toBe(false);
    expect(fs.existsSync(scratch)).toBe(false);
  });
});
