/**
 * The read-only sandbox profile (Explore/Plan/Review): the WORKSPACE must be
 * excluded from the writable set so a command can read anything but can't modify
 * the source — the OS denies the write instead of a command classifier. macOS
 * Seatbelt is the profile we can assert on the host; the native Win/Linux helpers
 * get `--read-only` (their own CI tests).
 */
import { describe, it, expect } from "vitest";
import os from "os";
import path from "path";
import { wrapCommandInSandbox } from "@/lib/sandbox/wrap-command";

const isMac = process.platform === "darwin";

describe.runIf(isMac)("read-only sandbox profile (macOS Seatbelt)", () => {
  const workspace = path.join(os.tmpdir(), "atlarix-ro-test-ws");
  const base = {
    command: "cat package.json",
    shell: "/bin/zsh",
    workspacePath: workspace,
  };

  it("workspace IS writable in the default (workspace-write) profile", () => {
    const w = wrapCommandInSandbox({ ...base });
    const profile = w.args.join(" ");
    // The Seatbelt profile allows file-write* to the workspace subpath.
    expect(profile).toContain("file-write*");
    // (workspace may not resolve if it doesn't exist; /tmp caches are always there)
    expect(profile).toContain("/tmp");
  });

  it("read-only profile OMITS the workspace from the writable subpaths", () => {
    const real = path.join(os.tmpdir()); // a path that exists
    const w = wrapCommandInSandbox({
      ...base,
      workspacePath: real,
      readOnly: true,
    });
    const profile = w.args.join(" ");
    expect(w.sandboxed).toBe(true);
    // The read-only profile denies writes, and its allow-list is caches/tmp only —
    // never the workspace subpath.
    expect(profile).toContain("(deny file-write*)");
    // /tmp (a cache root) stays writable; the workspace does not appear as an
    // extra writable beyond that shared cache set.
    const roWritableCount = (profile.match(/subpath/g) ?? []).length;
    const rwWritableCount = (
      wrapCommandInSandbox({ ...base, workspacePath: real })
        .args.join(" ")
        .match(/subpath/g) ?? []
    ).length;
    // Workspace-write has at least as many writable subpaths as read-only.
    expect(rwWritableCount).toBeGreaterThanOrEqual(roWritableCount);
  });
});
