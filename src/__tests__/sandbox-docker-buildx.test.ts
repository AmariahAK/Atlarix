/**
 * The docker/buildx grant must reach the REAL writable set, not just the list.
 *
 * `sandbox-platform-cache-dirs.test.ts` asserts `HOME_CACHE_DIRS` and
 * `dockerBuildxDirs()` directly, deliberately, so it runs on every platform. That
 * leaves one thing uncovered: whether the entries are actually wired into
 * `defaultWritablePaths` — a call site can be dropped while both lists stay
 * correct, and the list tests would still pass.
 *
 * This drives `wrapCommandInSandbox` end to end and reads the Seatbelt profile.
 * **macOS-gated, and that is a real limit**: CI's `quality` job runs on ubuntu, so
 * this executes on a developer machine only. It is kept because macOS is where the
 * failure was reported (2026-08-29 — `docker compose build` aborting on a denied
 * write to `~/.docker/buildx/activity/`), and a wiring check that runs somewhere
 * beats one that runs nowhere. The list assertions remain the cross-platform net.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { wrapCommandInSandbox } from "@/lib/sandbox/wrap-command";

const isMac = process.platform === "darwin";

function profileFor(): string {
  const w = wrapCommandInSandbox({
    command: "docker compose build",
    shell: "/bin/zsh",
    workspacePath: os.tmpdir(),
  });
  expect(w.sandboxed).toBe(true);
  return w.args.join(" ");
}

describe.runIf(isMac)("macOS sandbox grants buildx its state dir", () => {
  const saved = process.env.DOCKER_CONFIG;
  const created: string[] = [];

  afterEach(() => {
    if (saved === undefined) delete process.env.DOCKER_CONFIG;
    else process.env.DOCKER_CONFIG = saved;
    for (const d of created.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it("grants ~/.docker/buildx by default", () => {
    delete process.env.DOCKER_CONFIG;
    // Curated entries are granted even when missing, so this holds on a machine
    // that has never run Docker.
    expect(profileFor()).toContain(path.join(os.homedir(), ".docker", "buildx"));
  });

  it("follows a redirected DOCKER_CONFIG", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-dockercfg-"));
    created.push(dir);
    fs.mkdirSync(path.join(dir, "buildx"), { recursive: true });
    process.env.DOCKER_CONFIG = dir;

    expect(profileFor()).toContain(realpathSync(path.join(dir, "buildx")));
  });

  it("does not grant the config dir itself — config.json lives there", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-dockercfg-"));
    created.push(dir);
    fs.mkdirSync(path.join(dir, "buildx"), { recursive: true });
    process.env.DOCKER_CONFIG = dir;

    const profile = profileFor();
    const real = realpathSync(dir);
    // The buildx subpath is granted; its parent must not appear as its own
    // subpath rule. Seatbelt grants are `(subpath "…")`, so match exactly.
    expect(profile).toContain(`(subpath "${path.join(real, "buildx")}")`);
    expect(profile).not.toContain(`(subpath "${real}")`);
  });
});
