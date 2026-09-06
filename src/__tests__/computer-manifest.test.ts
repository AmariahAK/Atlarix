/**
 * The capability manifest, and whether the binary we ship actually accepts it.
 *
 * # Why the live check is the important half
 *
 * `driver-session.ts` refuses to use a daemon that is not in bounded mode with an
 * approved manifest — deliberately, so a silent downgrade to the unrestricted
 * surface cannot happen. The cost of that choice is that a manifest cua-driver
 * REJECTS does not degrade desktop control, it disables it: `serve` prints
 * "authorization startup error" and never listens.
 *
 * So a shape assertion against a hand-written expectation is close to worthless
 * here — it would pass while the driver rejected the file. The assertion that
 * matters is that this exact JSON survives a real `serve` startup, and every field
 * below was derived that way (feeding deliberate type errors to the real binary and
 * reading serde's "expected one of ..." back). Four of them are not guessable:
 * durations are strings, `resources` is top-level, `windows` takes only the literal
 * `"all"`, `terminate` takes `deny|driver_launched|any`.
 */
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const userData = mkdtempSync(path.join(os.tmpdir(), "atlarix-manifest-"));
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getName: () => "Atlarix",
    getAppPath: () => process.cwd(),
    getPath: () => userData,
  },
}));

const DRIVER = path.join(process.cwd(), "native", ".dist", "cua-driver");
const haveDriver = existsSync(DRIVER);
if (!haveDriver) {
  console.log("[computer-manifest] native/.dist/cua-driver absent — live checks skipped");
}

/**
 * A SHORT socket path, on purpose.
 *
 * macOS caps `sun_path` at 104 bytes and the scratch directory this suite would
 * otherwise use is longer than that — the bind fails with "path must be shorter
 * than SUN_LEN", which reads like a driver bug and is not one. `socketPath()` in
 * `driver-session.ts` asserts the same limit for the real socket.
 */
const SOCK = path.join(os.tmpdir(), `atlarix-mtest-${process.pid}.sock`);

afterAll(() => {
  try {
    if (haveDriver) spawnSync(DRIVER, ["stop", "--socket", SOCK], { timeout: 5_000 });
  } catch {
    /* nothing running */
  }
  rmSync(SOCK, { force: true });
  rmSync(userData, { recursive: true, force: true });
});



describe("manifest shape", () => {
  it("declares exactly the tools Atlarix can reach, and denies the rest", async () => {
    const { buildManifest } = await import("@/lib/computer/manifest");
    const { DISPATCH, HOST_ONLY, DENIED } = await import("@/lib/computer/dispatch");
    const m = buildManifest();

    const allowed = new Set(m.allow.tools);
    for (const t of Object.keys(DISPATCH)) {
      expect(allowed.has(t), `${t} is model-facing but not in the manifest`).toBe(true);
    }
    for (const t of HOST_ONLY) {
      // Atlarix itself calls these — a manifest that omits them breaks the session
      // and the cursor rather than the model.
      expect(allowed.has(t), `${t} is host-driven but not in the manifest`).toBe(true);
    }
    for (const t of Object.keys(DENIED)) {
      expect(allowed.has(t), `${t} is denied but appears in allow.tools`).toBe(false);
      expect(m.deny.tools).toContain(t);
    }
  });

  it("is stable byte-for-byte, because the daemon reports its sha256", async () => {
    const { buildManifest } = await import("@/lib/computer/manifest");
    expect(JSON.stringify(buildManifest())).toBe(JSON.stringify(buildManifest()));
    // Sorted, or two runs of the same code produce two different hashes.
    expect(buildManifest().allow.tools).toEqual([...buildManifest().allow.tools].sort());
  });

  it("keeps the temp directory writable, which OCR depends on", async () => {
    const { buildManifest } = await import("@/lib/computer/manifest");
    // `ocr.ts` drives `--screenshot-out-file` into a temp dir on EVERY tier-3 read,
    // and that is a governed capability. Omitting this breaks OCR in bounded mode
    // and nowhere else, which is the hardest kind of gap to notice.
    expect(buildManifest().resources.files.write).toContain(os.tmpdir());
  });

  it("declares existing_profile, which is the only route to it in bounded mode", async () => {
    const { buildManifest } = await import("@/lib/computer/manifest");
    // `--grant existing-profile` is refused here — "--grant is valid only in
    // standard permission mode" — so reaching for the flag would silently force us
    // out of bounded mode. The manifest is how the owner's browser decision is
    // expressed.
    expect(buildManifest().resources.browser.profiles).toContainEqual({
      kind: "existing_profile",
    });
  });

  it("recognises the driver's expiry refusal, which is not a tool failure", async () => {
    const { isManifestExpiry } = await import("@/lib/computer/manifest");
    expect(isManifestExpiry("capability manifest expired")).toBe(true);
    expect(isManifestExpiry("capability manifest idle timeout exceeded")).toBe(true);
    expect(isManifestExpiry("window_target_not_found")).toBe(false);
  });
});

describe.skipIf(!haveDriver)("the shipped driver accepts it", () => {
  let daemon: ChildProcess | null = null;
  let startupOutput = "";

  /**
   * `spawn`, NOT `spawnSync` with a timeout.
   *
   * `spawnSync`'s timeout KILLS the child, so the daemon it just started is dead
   * before the next assertion runs — the first version of this suite proved the
   * manifest parsed and then found nothing listening. A long-lived child plus a
   * poll for the socket is the only shape that lets the enforcement test run
   * against the daemon this manifest actually started.
   */
  beforeAll(async () => {
    rmSync(SOCK, { force: true });
    const { writeManifest } = await import("@/lib/computer/manifest");
    const file = writeManifest();
    daemon = spawn(
      DRIVER,
      [
        "serve",
        "--embedded",
        "--socket",
        SOCK,
        "--permission-mode",
        "bounded",
        "--capability-manifest",
        file,
        "--approve-capability-manifest",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    daemon.stdout?.on("data", (d: Buffer) => (startupOutput += d.toString()));
    daemon.stderr?.on("data", (d: Buffer) => (startupOutput += d.toString()));

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (existsSync(SOCK) || daemon.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 40_000);

  afterAll(() => {
    try {
      daemon?.kill();
    } catch {
      /* already gone */
    }
  });

  it("starts in bounded mode and reports the manifest approved", () => {
    expect(startupOutput, "the driver rejected the manifest").not.toMatch(
      /authorization startup error/i,
    );
    const status = execFileSync(DRIVER, ["status", "--socket", SOCK], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(status).toMatch(/permission mode:\s*bounded/i);
    expect(status).toMatch(/capability manifest:.*configured=true/i);
    expect(status).toMatch(/approved_at_startup=true/i);
  });

  it("actually enforces the ceiling", () => {
    // The whole point of the second layer: a tool outside `allow.tools` is refused
    // by the DRIVER, in its own process, whatever our dispatch layer does.
    const denied = spawnSync(
      DRIVER,
      ["call", "replay_trajectory", "{}", "--socket", SOCK],
      { encoding: "utf8", timeout: 20_000 },
    );
    const out = `${denied.stdout ?? ""}${denied.stderr ?? ""}`;
    // "denies tool" rather than "outside the manifest": the explicit `deny.tools`
    // entry is what fired, which is the stronger of the two — every driver tool is
    // in allow OR deny, so "outside" is reserved for a name that does not exist.
    expect(out).toMatch(/capability manifest denies tool 'replay_trajectory'/i);

    // And an allowed one is not refused, or the test above proves only that the
    // daemon says no to everything.
    const allowed = spawnSync(DRIVER, ["call", "get_screen_size", "{}", "--socket", SOCK], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(`${allowed.stdout ?? ""}`).not.toMatch(/outside the capability manifest/i);
  }, 40_000);

  it("rejects a manifest with the wrong duration type, so the live check has teeth", () => {
    // Proves the assertion above can FAIL. Seconds-as-a-number was the first thing
    // tried and the driver refused it: "invalid duration unit in '86400'".
    const bad = path.join(userData, "bad-manifest.json");
    writeFileSync(
      bad,
      JSON.stringify({
        version: 3,
        expires_after: 86_400,
        idle_timeout: 3_600,
        allow: { tools: ["list_apps"] },
      }),
    );
    const served = spawnSync(
      DRIVER,
      [
        "serve",
        "--embedded",
        "--socket",
        path.join(os.tmpdir(), `atlarix-bad-${process.pid}.sock`),
        "--permission-mode",
        "bounded",
        "--capability-manifest",
        bad,
        "--approve-capability-manifest",
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(`${served.stdout ?? ""}${served.stderr ?? ""}`).toMatch(
      /authorization startup error/i,
    );
  }, 20_000);
});
