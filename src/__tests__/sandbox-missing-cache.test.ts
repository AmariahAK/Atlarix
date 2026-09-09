/**
 * Regression: a cache dir a tool is about to CREATE (e.g. `~/.yarn` on a fresh
 * machine) must still be granted write. Previously `realIfExists` pruned any
 * not-yet-existing candidate, so its grant was never emitted and the tool's
 * first `mkdir` was denied (`EPERM: mkdir '~/.yarn'`). On macOS the grant is a
 * prospective `(subpath …)` — resolved against the nearest existing ancestor,
 * with NO directory created.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { wrapCommandInSandbox } from "@/lib/sandbox/wrap-command";

const isMac = process.platform === "darwin";

describe.runIf(isMac)(
  "macOS sandbox grants not-yet-existing write-intent paths",
  () => {
    const created: string[] = [];
    afterEach(() => {
      for (const p of created.splice(0)) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    });

    it("emits a prospective subpath for a missing extra dir WITHOUT creating it", () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-missing-"));
      created.push(base);
      const missing = path.join(base, "does-not-exist-yet", "cache");
      expect(fs.existsSync(missing)).toBe(false);

      const w = wrapCommandInSandbox({
        command: "yarn install",
        shell: "/bin/zsh",
        workspacePath: os.tmpdir(),
        extraWritablePaths: [missing],
      });

      expect(w.sandboxed).toBe(true);
      // Prospective grant = realpath(existing ancestor) + the missing tail.
      const expected = path.join(
        realpathSync(base),
        "does-not-exist-yet",
        "cache",
      );
      expect(w.args.join(" ")).toContain(expected);
      // macOS must NOT have created the directory (Seatbelt allows prospective subpaths).
      expect(fs.existsSync(missing)).toBe(false);
    });

    it("grants ~/.yarn even when it does not exist on this machine", () => {
      const w = wrapCommandInSandbox({
        command: "yarn install",
        shell: "/bin/zsh",
        workspacePath: os.tmpdir(),
      });
      // A yarn cache grant is present regardless of whether ~/.yarn exists yet.
      expect(w.args.join(" ")).toContain(
        path.join(realpathSync(os.homedir()), ".yarn"),
      );
    });

    // End-to-end against real Seatbelt: the exact yarn-EPERM scenario — a granted
    // dir that does not exist yet must be creatable from inside the sandbox.
    it("actually allows mkdir into a granted-but-missing dir under real Seatbelt", () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-e2e-"));
      created.push(base);
      const missing = path.join(base, "freshcache"); // does NOT exist yet
      const target = path.join(missing, "sub", "file.txt");
      expect(fs.existsSync(missing)).toBe(false);

      const w = wrapCommandInSandbox({
        command: `mkdir -p ${JSON.stringify(path.dirname(target))} && echo hi > ${JSON.stringify(target)} && echo OK`,
        shell: "/bin/zsh",
        workspacePath: path.join(base, "ws"),
        extraWritablePaths: [missing],
      });
      expect(w.sandboxed).toBe(true);

      const res = spawnSync(w.file, w.args, { encoding: "utf8" });
      expect(res.stdout.trim()).toBe("OK");
      expect(fs.existsSync(target)).toBe(true);
    });
  },
);
