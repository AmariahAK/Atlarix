/**
 * Plugin files, plugins.json and hooks.json against the REAL kernel: a sandboxed
 * command in an ordinary (workspace-write) run cannot write them, even when the
 * folder around them is writable — here a temp folder, and a granted one.
 *
 * macOS only, like `sandbox-deny-e2e.test.ts`: Seatbelt is the dev host's
 * mechanism. The profile text is checked in `sandbox-readonly-profile.test.ts`;
 * this checks what happens on disk.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wrapCommandInSandbox } from "@/lib/sandbox/wrap-command";

describe.runIf(process.platform === "darwin")(
  "plugin control paths, sandboxed, end to end",
  () => {
    let home: string;
    let ws: string;
    let saved: string | undefined;

    beforeEach(() => {
      home = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-plugins-e2e-home-")),
      );
      ws = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-plugins-e2e-ws-")),
      );
      fs.mkdirSync(path.join(home, "plugins", "acme"), { recursive: true });
      saved = process.env.ATLARIX_HOME_DIR;
      process.env.ATLARIX_HOME_DIR = home;
    });
    afterEach(() => {
      fs.rmSync(path.join(path.dirname(home), "beside-home.md"), {
        force: true,
      });
      if (saved === undefined) delete process.env.ATLARIX_HOME_DIR;
      else process.env.ATLARIX_HOME_DIR = saved;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    });

    const run = (command: string) => {
      const w = wrapCommandInSandbox({
        command,
        shell: "/bin/sh",
        workspacePath: ws,
        extraWritablePaths: [path.dirname(home)],
      });
      expect(w.sandboxed).toBe(true);
      return spawnSync(w.file, w.args, { encoding: "utf8", cwd: ws });
    };

    it("refuses the control paths and allows the rest of a writable folder", () => {
      expect(
        run(
          `printf x > "${path.join(path.dirname(home), "beside-home.md")}" && echo ok`,
        ).stdout.trim(),
      ).toBe("ok");

      for (const target of [
        path.join(home, "hooks.json"),
        path.join(home, "plugins.json"),
        path.join(home, "plugins", "acme", "evil.sh"),
        path.join(home, "plugins", "new-plugin", "x"),
        path.join(home, "memory.md"),
      ]) {
        const r = run(
          `mkdir -p "${path.dirname(target)}" 2>/dev/null; printf evil > "${target}" && echo WROTE`,
        );
        expect(r.stdout.trim(), target).not.toBe("WROTE");
        expect(fs.existsSync(target), target).toBe(false);
      }
    });
  },
);
