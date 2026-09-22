/**
 * The deny set, proven against the REAL kernel — not against the profile text.
 *
 * Every other sandbox test asserts on the generated SBPL string. That catches a
 * malformed profile and nothing else: a profile can name the right paths, in the
 * right order, with the right syntax, and still enforce nothing if any one
 * assumption about Seatbelt is wrong. This file actually spawns the command and
 * looks at what happened on disk.
 *
 * It exists because the two halves of this change pull in opposite directions
 * and both have to hold at once:
 *
 *   1. the workspace must be WRITABLE — the previous profile dropped it, which
 *      is what broke vitest at startup (`node_modules/.vite-temp`), `npm
 *      install`, every build (`dist/`) and every dev server;
 *   2. three paths inside it must NOT be — `.git/config`, `.git/hooks` and
 *      `.atlarix/` decide what runs next, so a command that edits one is not
 *      making a change you can read in a diff.
 *
 * Asserting either alone is how you ship the other one broken.
 *
 * macOS only: Seatbelt is the mechanism available on a dev host. The Linux
 * `bwrap` fallback expresses the same deny with `--ro-bind-try`; the bundled
 * Landlock helper and the Windows Low-IL helper have no deny primitive at all,
 * which is what `denyEnforced` reports and why no prompt claims these are
 * "blocked".
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { wrapCommandInSandbox } from "@/lib/sandbox/wrap-command";

describe.runIf(process.platform === "darwin")(
  "source-protected sandbox, end to end",
  () => {
    it("workspace writes succeed and protected writes are refused", () => {
      const ws = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-deny-e2e-")),
      );
      fs.mkdirSync(path.join(ws, ".git", "hooks"), { recursive: true });
      fs.writeFileSync(path.join(ws, ".git", "config"), "[core]\n");

      const run = (command: string) => {
        const w = wrapCommandInSandbox({
          command,
          shell: "/bin/sh",
          workspacePath: ws,
          readOnly: true,
        });
        // A sandbox that was not applied is the false pass this file exists to
        // kill — every assertion below would trivially "succeed" unconfined.
        expect(w.sandboxed).toBe(true);
        expect(w.denyEnforced).toBe(true);
        return spawnSync(w.file, w.args, { encoding: "utf8", cwd: ws });
      };

      try {
        // 1. The capability being restored. These are the exact writes that
        //    failed under the old profile, in the order they failed.
        expect(
          run("mkdir -p node_modules/.vite-temp && echo ok").stdout.trim(),
        ).toBe("ok");
        expect(
          run(
            "mkdir -p dist && printf x > dist/out.js && echo ok",
          ).stdout.trim(),
        ).toBe("ok");
        expect(run("printf x > src.ts && echo ok").stdout.trim()).toBe("ok");

        // 2. The protection. `echo WROTE` runs only if the redirect succeeded,
        //    so an empty stdout is the refusal.
        const cfg = run("printf evil > .git/config && echo WROTE");
        expect(cfg.stdout.trim()).not.toBe("WROTE");
        expect(`${cfg.stderr}`).toMatch(/not permitted|denied/i);

        expect(
          run(
            "printf evil > .git/hooks/pre-commit && echo WROTE",
          ).stdout.trim(),
        ).not.toBe("WROTE");

        // A directory that does not exist yet must still be un-creatable —
        // otherwise the protection would depend on the user already having one.
        expect(run("mkdir -p .atlarix && echo WROTE").stdout.trim()).not.toBe(
          "WROTE",
        );

        // …and none of it actually landed.
        expect(fs.readFileSync(path.join(ws, ".git", "config"), "utf8")).toBe(
          "[core]\n",
        );
        expect(fs.existsSync(path.join(ws, ".atlarix"))).toBe(false);

        // 3. Reads are untouched. "Writes confined, reads broad" is the whole
        //    policy, and a sandbox that blocked reads here would break `git`
        //    itself — the failure mode the Windows helper shipped with once.
        expect(run("cat .git/config").stdout).toContain("[core]");
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });
  },
);
