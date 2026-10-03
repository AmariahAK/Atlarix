/**
 * The CLI's silent self-update (src/cli/update.ts) against a fake release on a
 * local server: how it decides it was installed, which asset it wants, that a
 * wrong checksum changes nothing, and that a good one swaps the binary.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assetName, checkAndUpdate, checksumFor, due, installMethod, type UpdateEvent } from "@/cli/update";

describe("deciding", () => {
  it("knows how it was installed from where the binary lives", () => {
    expect(installMethod("/Users/a/.atlarix/bin/atlarix", "/Users/a", {})).toBe("script");
    expect(installMethod("C:\\Users\\a\\AppData\\Local\\Atlarix\\bin\\atlarix.exe", "C:\\Users\\a", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" })).toBe("script");
    expect(installMethod("/opt/homebrew/Cellar/atlarix/14.52.4/bin/atlarix", "/Users/a", {})).toBe("brew");
    expect(installMethod("/usr/local/lib/node_modules/atlarix-darwin-arm64/bin/atlarix", "/Users/a", {})).toBe("npm");
    expect(installMethod("/usr/local/bin/atlarix", "/Users/a", {})).toBe("manual");
  });

  it("asks for the same asset the install script does", () => {
    expect(assetName("darwin", "arm64", false)).toBe("atlarix-cli-darwin-arm64.tar.gz");
    expect(assetName("linux", "x64", true)).toBe("atlarix-cli-linux-x64-musl.tar.gz");
    expect(assetName("win32", "x64", false)).toBe("atlarix-cli-windows-x64.zip");
  });

  it("reads SHA256SUMS lines, with or without the binary-mode star", () => {
    const sums = `${"a".repeat(64)}  atlarix-cli-darwin-arm64.tar.gz\n${"b".repeat(64)} *atlarix-cli-linux-x64.tar.gz\n`;
    expect(checksumFor(sums, "atlarix-cli-linux-x64.tar.gz")).toBe("b".repeat(64));
    expect(checksumFor(sums, "nope.tar.gz")).toBeNull();
  });

  it("checks at most once a day", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "upd-")), "stamp.json");
    expect(due(f)).toBe(true);
    fs.writeFileSync(f, JSON.stringify({ checkedAt: Date.now() }));
    expect(due(f)).toBe(false);
    expect(due(f, Date.now() + 21 * 3600_000)).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("installing from a release", () => {
  let server: http.Server;
  let base = "";
  let archive: Buffer;
  let goodSums = "";
  let sums = "";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upd-rel-"));

  beforeAll(async () => {
    const stage = path.join(dir, "stage");
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, "atlarix"), "#!/bin/sh\necho 14.99.0\n");
    const asset = assetName();
    execFileSync("tar", ["-czf", path.join(dir, asset), "-C", stage, "atlarix"]);
    archive = fs.readFileSync(path.join(dir, asset));
    goodSums = `${createHash("sha256").update(archive).digest("hex")}  ${asset}\n`;
    server = http.createServer((req, res) => {
      if (req.url === "/latest") return res.end(JSON.stringify({ tag_name: "v14.99.0" }));
      if (req.url?.endsWith("/SHA256SUMS-cli.txt")) return res.end(sums);
      if (req.url?.endsWith(`/${asset}`)) return res.end(archive);
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  const deps = (binary: string) => ({
    fetch,
    binary,
    latestUrl: `${base}/latest`,
    downloadBase: (v: string) => `${base}/download/v${v}`,
    stampFile: path.join(dir, `stamp-${Math.random()}.json`),
    run: async (cmd: string, args: string[]) => void execFileSync(cmd, args),
  });
  const installed = () => {
    const bin = path.join(dir, "home", ".atlarix", "bin");
    fs.mkdirSync(bin, { recursive: true });
    const file = path.join(bin, "atlarix");
    fs.writeFileSync(file, "old");
    return file;
  };

  it("a wrong checksum changes nothing, and says so", async () => {
    sums = `${"0".repeat(64)}  ${assetName()}\n`;
    const file = installed();
    const events: UpdateEvent[] = [];
    process.env.ATLARIX_INSTALL_DIR = path.dirname(file);
    await checkAndUpdate("14.52.4", (e) => events.push(e), deps(file), { force: true });
    expect(events.map((e) => e.kind)).toEqual(["installing", "failed"]);
    expect((events[1] as { error: string }).error).toMatch(/checksum mismatch/);
    expect(fs.readFileSync(file, "utf8")).toBe("old");
  });

  it("a newer release is downloaded, checked and swapped in", async () => {
    sums = goodSums;
    const file = installed();
    const events: UpdateEvent[] = [];
    process.env.ATLARIX_INSTALL_DIR = path.dirname(file);
    await checkAndUpdate("14.52.4", (e) => events.push(e), deps(file), { force: true });
    expect(events).toEqual([
      { kind: "installing", version: "14.99.0" },
      { kind: "installed", version: "14.99.0" },
    ]);
    expect(fs.readFileSync(file, "utf8")).toContain("14.99.0");
    expect(fs.statSync(file).mode & 0o111).toBeTruthy();
  });

  it("the same version does nothing", async () => {
    const events: UpdateEvent[] = [];
    await checkAndUpdate("14.99.0", (e) => events.push(e), deps(installed()), { force: true });
    expect(events).toEqual([]);
  });
});
