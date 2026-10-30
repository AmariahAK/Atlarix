/**
 * The source-protected sandbox profile (Explore / Plan / Review, and every
 * sub-agent command).
 *
 * WHAT THIS FILE USED TO ASSERT, and why it changed: that the workspace was
 * OMITTED from the writable set. That is how read-only modes used to work, and
 * measured against a real project it meant vitest could not start
 * (`node_modules/.vite-temp` is written before its config is read), `npm install`
 * could not write `node_modules`, no build could emit `dist/`, and `git fetch`
 * could not lock a ref — while three mode prompts told the model all four were
 * allowed. The profile now matches the reference harnesses: workspace writable,
 * with a short deny set for the execution/identity paths.
 *
 * Its old arithmetic assertion (`rwWritableCount >= roWritableCount`) also has
 * to go rather than be re-tuned: with the two profiles now sharing a writable
 * set it is satisfied by equality, so it would keep passing while proving
 * nothing at all.
 *
 * macOS Seatbelt is the one profile assertable on this host. The Linux `bwrap`
 * fallback expresses the same deny with `--ro-bind-try`; the bundled Landlock
 * helper and the Windows Low-IL helper cannot express it at all, which is what
 * `denyEnforced` reports and what keeps the claim out of the prompts.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { wrapCommandInSandbox } from "@/lib/sandbox/wrap-command";
import { pluginControlDenyPaths, readOnlyDenyPaths } from "@/lib/sandbox/deny-paths";

const isMac = process.platform === "darwin";

describe.runIf(isMac)(
  "source-protected sandbox profile (macOS Seatbelt)",
  () => {
    // A path that exists, so the writable-set resolver keeps it.
    //
    // REALPATH, not resolve. `wrapCommandInSandbox` realpaths the workspace before
    // building the profile, and on macOS `os.tmpdir()` is a symlink
    // (`/var/folders/…` → `/private/var/folders/…`). Comparing against the
    // unresolved form passes by accident — the resolved path CONTAINS the
    // unresolved one as a substring — which is exactly the kind of assertion that
    // keeps passing after the thing it guards has broken.
    const workspace = fs.realpathSync(os.tmpdir());
    const base = {
      command: "cat package.json",
      shell: "/bin/zsh",
      workspacePath: workspace,
    };
    const profileOf = (extra: Record<string, unknown> = {}) =>
      wrapCommandInSandbox({ ...base, ...extra }).args.join(" ");

    it("the workspace is writable in BOTH profiles — that is the change", () => {
      const real = workspace;
      expect(profileOf()).toContain(real);
      expect(profileOf({ readOnly: true })).toContain(real);
    });

    it("source-protected adds a deny block naming the protected paths", () => {
      const w = wrapCommandInSandbox({ ...base, readOnly: true });
      const profile = w.args.join(" ");
      expect(w.sandboxed).toBe(true);
      expect(w.denyEnforced).toBe(true);
      for (const p of readOnlyDenyPaths(workspace)) {
        expect(profile).toContain(p);
      }
    });

    it("the deny block comes AFTER the allow block, or it does nothing", () => {
      // SBPL is last-match-wins. Emitted before the `(allow file-write* (subpath
      // <workspace>))` above it, the deny would simply lose and the protection
      // would be silently absent — a profile that reads correct and enforces
      // nothing. This assertion is the whole reason the test exists.
      const profile = wrapCommandInSandbox({
        ...base,
        readOnly: true,
      }).args.join("\n");
      const allowIdx = profile.indexOf("(allow file-write*");
      const denyIdx = profile.lastIndexOf("(deny file-write*");
      expect(allowIdx).toBeGreaterThan(-1);
      expect(denyIdx).toBeGreaterThan(allowIdx);
    });

    it("the workspace-write profile denies only the plugin-control paths, and says source protection is off", () => {
      const w = wrapCommandInSandbox({ ...base });
      expect(w.denyEnforced).toBe(false);
      // The trailing deny names the plugin folder, record and hooks.json — which
      // decide what runs next — and none of the source-protection paths.
      const profile = w.args.join("\n");
      for (const p of readOnlyDenyPaths(workspace)) {
        expect(profile).not.toContain(p);
      }
      const trailing = profile.slice(profile.lastIndexOf("(deny file-write*"));
      expect(trailing.indexOf("(deny file-write*")).toBe(0);
      for (const p of pluginControlDenyPaths()) {
        expect(trailing).toContain(JSON.stringify(p));
      }
    });

    it("a config FILE is denied as a literal, a directory as a subpath", () => {
      // `.git/config` is one file; `(subpath …)` on a file is not what Seatbelt
      // wants, and `(literal …)` on a directory would leave its contents writable.
      const profile = wrapCommandInSandbox({
        ...base,
        readOnly: true,
      }).args.join("\n");
      const root = workspace;
      expect(profile).toContain(
        `(literal ${JSON.stringify(path.join(root, ".git", "config"))})`,
      );
      expect(profile).toContain(
        `(subpath ${JSON.stringify(path.join(root, ".git", "hooks"))})`,
      );
      expect(profile).toContain(
        `(subpath ${JSON.stringify(path.join(root, ".atlarix"))})`,
      );
    });
  },
);

describe("readOnlyDenyPaths", () => {
  it("keeps a path that does not exist — that is the point", () => {
    // The inverse of the writable-set rule, where a missing path is dropped
    // because binding it would fail. A deny on a not-yet-existing `.atlarix/`
    // is what stops a command CREATING one; pruning it would make the
    // protection depend on whether the user happened to have the folder.
    const paths = readOnlyDenyPaths("/definitely/not/a/real/workspace");
    expect(paths).toHaveLength(3);
    expect(paths.some((p) => p.endsWith(path.join(".atlarix")))).toBe(true);
  });

  it("is empty without a workspace", () => {
    expect(readOnlyDenyPaths("")).toEqual([]);
  });
});
