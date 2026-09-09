/**
 * Write-side file permission scoping.
 *
 * v14.23.0 deleted the hardcoded protected-path list. It named `package.json`, lockfiles,
 * `.env*`, `.pem`/`.key`/`.cert`/`.p12`, `.github/workflows/**` — and `drizzle.config.ts`,
 * `src/db/schema.ts`, `drizzle/**`, which are ATLARIX'S OWN layout hardcoded into every
 * user's workspace. A match forced a prompt on every edit AND set
 * `canAlwaysAllow{File,Directory,Extension}: false`, so `.github/workflows/x.yml` was a dead
 * end: prompt forever, no way to opt out. That is what was reported.
 *
 * The list had no tests at all, which is why removing it broke nothing and why this file
 * exists. The point below is NOT "decisions stopped being enforced" — it is that the
 * dead-end is gone while every stored decision still applies.
 */

import { describe, expect, it } from "vitest";
import {
  getPathExtension,
  getParentDirectory,
  isProtectedRelativePath,
  normalizeRelativePath,
  resolveFilePermissionGate,
  type ListedFilePermission,
} from "@/lib/file-permission-scope";

const gate = (rel: string, rows: ListedFilePermission[] = []) =>
  resolveFilePermissionGate(rel, "edit_file", rows);

/** Every path the old hardcoded list refused to let you always-allow. */
const FORMERLY_PROTECTED = [
  ".github/workflows/daily-quote.yml",
  ".github/workflows/release.yml",
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".env",
  ".env.production",
  "secrets.pem",
  "server.key",
  "chain.cert",
  "bundle.p12",
  // Atlarix's own files, which had no business being special in a user's project.
  "drizzle.config.ts",
  "src/db/schema.ts",
  "drizzle/0001_init.sql",
];

describe("no path is special any more", () => {
  it.each(FORMERLY_PROTECTED)("%s can be always-allowed", (rel) => {
    const g = gate(rel);
    expect(g.action).toBe("prompt");
    if (g.action !== "prompt") return;
    // The dead-end: all three were false for any protected path.
    expect(g.canAlwaysAllowFile).toBe(true);
    expect(g.canAlwaysAllowDirectory || getParentDirectory(rel) === "").toBe(
      true,
    );
    expect(g.canAlwaysAllowExtension || getPathExtension(rel) === "").toBe(
      true,
    );
    expect(g.isProtected).toBe(false);
  });

  it("the reported case specifically: a workflow .yml offers extension scope", () => {
    const g = gate(".github/workflows/daily-quote.yml");
    if (g.action !== "prompt") throw new Error("expected a prompt");
    expect(g.extension).toBe(".yml");
    expect(g.canAlwaysAllowExtension).toBe(true);
    expect(g.parentDir).toBe(".github/workflows");
    expect(g.canAlwaysAllowDirectory).toBe(true);
  });
});

describe("stored decisions are still enforced", () => {
  it("auto-allows on a file-scope row", () => {
    const g = gate(".github/workflows/x.yml", [
      {
        scopeType: "file",
        scopeValue: ".github/workflows/x.yml",
        decision: "always_allow",
      },
    ]);
    expect(g.action).toBe("auto_allow");
  });

  it("auto-allows on a directory-scope row", () => {
    const g = gate(".github/workflows/x.yml", [
      {
        scopeType: "directory",
        scopeValue: ".github/workflows",
        decision: "always_allow",
      },
    ]);
    expect(g.action).toBe("auto_allow");
  });

  it("auto-allows on an extension-scope row, case-insensitively", () => {
    expect(
      gate("a/b/c.YML", [
        { scopeType: "extension", scopeValue: "yml", decision: "always_allow" },
      ]).action,
    ).toBe("auto_allow");
  });

  it("still auto-DENIES when that is what the user chose", () => {
    // Removing the hardcoded list must not remove the user's ability to lock a path down.
    const g = gate(".env", [
      { scopeType: "file", scopeValue: ".env", decision: "always_deny" },
    ]);
    expect(g.action).toBe("auto_deny");
  });

  it("prompts when no row matches", () => {
    expect(
      gate("src/a.ts", [
        {
          scopeType: "file",
          scopeValue: "src/other.ts",
          decision: "always_allow",
        },
      ]).action,
    ).toBe("prompt");
  });
});

describe("isProtectedRelativePath is now only a usability check", () => {
  it("refuses an empty or meaningless path", () => {
    // A malformed request, not a policy decision.
    expect(isProtectedRelativePath("")).toBe(true);
    expect(isProtectedRelativePath(".")).toBe(true);
  });

  it.each([
    ".env",
    "package.json",
    ".github/workflows/x.yml",
    "drizzle/0001.sql",
  ])("no longer flags %s", (rel) => {
    expect(isProtectedRelativePath(rel)).toBe(false);
  });
});

describe("path helpers", () => {
  it("normalizes ./ and backslashes", () => {
    expect(normalizeRelativePath("./src\\a.ts")).toBe("src/a.ts");
  });

  it("reports the parent directory and extension", () => {
    expect(getParentDirectory("a/b/c.ts")).toBe("a/b");
    expect(getPathExtension("a/b/c.ts")).toBe(".ts");
    expect(getParentDirectory("top.ts")).toBe("");
  });
});
