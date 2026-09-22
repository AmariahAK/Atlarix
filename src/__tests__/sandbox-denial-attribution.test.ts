import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * "Attributed" must mean a grant card was RAISED, not that a path was PARSED.
 *
 * The two questions had drifted apart. `maybeEscalateSandboxDenial` decides
 * whether to raise a card and deliberately skips two kinds of denial: a path
 * already granted in this run, and any path inside the workspace (you must not
 * be able to grant your way out of a read-only profile). But `executeRunCommand`
 * computed `alreadyAttributed` from `parseSandboxDenialsFromOutput(...).length > 0`
 * — so for exactly those two kinds, BOTH were true at once: no card, and
 * `describeSandboxFailureContext` returning null because it believed something
 * else was explaining the failure.
 *
 * The user-visible shape of that, measured on this repo: Explore's prompt tells
 * the model `npm install` and the test suite are allowed; the read-only sandbox
 * denies `node_modules/`; and the model receives a bare
 * `Command failed with exit code 1` with no mention that Atlarix constrained the
 * process at all. It retries, or reports the project as broken.
 *
 * `sandbox-failure-context.test.ts` covers the pure formatter and could never
 * have caught this — the defect is in what the caller passes it.
 */

let globalSettings: Record<string, unknown> = {};

vi.mock("@/main/settings", () => ({
  readSettings: () => globalSettings,
  writeSettings: (s: Record<string, unknown>) => {
    globalSettings = { ...globalSettings, ...s };
  },
}));

vi.mock("@/lib/file-permissions-store", () => ({
  listSandboxWritablePaths: () => [],
  upsertSandboxWritablePath: () => {},
  revokeSandboxWritablePath: () => false,
  listWorkspaceFilePermissions: () => [],
  upsertWorkspaceFilePermission: () => {},
  revokeWorkspaceFilePermission: () => false,
}));

import { PermissionInterceptor } from "@/ipc/handlers/permissions/interceptor";

const APP_ID = 92;
const tmpRoots: string[] = [];

function makeWorkspace(): string {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-attribution-")),
  );
  tmpRoots.push(base);
  const ws = path.join(base, "workspace");
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}

/** Reach the private predicate the same way the other interceptor tests do. */
function skippableFor(ws: string) {
  const i = new PermissionInterceptor(
    ws,
    APP_ID,
    undefined,
    1,
    "ask",
  ) as unknown as {
    isSkippableDenialPath: (p: string, granted: ReadonlySet<string>) => boolean;
  };
  return (p: string, granted: string[] = []) =>
    i.isSkippableDenialPath(p, new Set(granted));
}

afterEach(() => {
  globalSettings = {};
  for (const d of tmpRoots.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("isSkippableDenialPath — the two denials that raise no card", () => {
  it("skips a path inside the workspace (the read-only case)", () => {
    const ws = makeWorkspace();
    const isSkippable = skippableFor(ws);

    expect(isSkippable(path.join(ws, "node_modules"))).toBe(true);
    expect(isSkippable(path.join(ws, "node_modules", ".vite-temp"))).toBe(true);
    expect(isSkippable(path.join(ws, "dist"))).toBe(true);
    // The workspace root itself, not just things under it.
    expect(isSkippable(ws)).toBe(true);
  });

  it("skips a path already granted earlier in the same run", () => {
    const ws = makeWorkspace();
    const isSkippable = skippableFor(ws);
    const yarn = path.join(os.homedir(), ".yarn");

    expect(isSkippable(yarn)).toBe(false);
    expect(isSkippable(yarn, [yarn])).toBe(true);
  });

  it("does NOT skip an ungranted path outside the workspace — that one gets a card", () => {
    const ws = makeWorkspace();
    const isSkippable = skippableFor(ws);

    expect(isSkippable(path.join(os.homedir(), ".cargo"))).toBe(false);
    expect(isSkippable("/opt/homebrew/lib")).toBe(false);
  });

  it("a sibling directory sharing the workspace's name prefix is NOT inside it", () => {
    // `startsWith(ws)` without the separator would swallow `…/workspace-other`,
    // which is a real path a monorepo produces and a real card the user needs.
    const ws = makeWorkspace();
    const isSkippable = skippableFor(ws);

    expect(isSkippable(`${ws}-other`)).toBe(false);
    expect(isSkippable(`${ws}-other/src`)).toBe(false);
  });
});

/**
 * The composition rule, stated directly: a denial set whose every member is
 * skippable must NOT count as attributed, because nothing was attributed.
 *
 * This is the arithmetic `executeRunCommand` now performs. Pinning it here
 * rather than only at the call site keeps it honest if the call site moves.
 */
describe("attribution follows the cards, not the parse", () => {
  it("an all-in-workspace denial set is not attributed", () => {
    const ws = makeWorkspace();
    const isSkippable = skippableFor(ws);
    const parsed = [
      path.join(ws, "node_modules"),
      path.join(ws, "node_modules", ".vite-temp"),
    ];

    expect(parsed.some((p) => !isSkippable(p))).toBe(false);
  });

  it("one grantable path among skippable ones IS attributed", () => {
    const ws = makeWorkspace();
    const isSkippable = skippableFor(ws);
    const parsed = [
      path.join(ws, "node_modules"),
      path.join(os.homedir(), ".cargo"),
    ];

    expect(parsed.some((p) => !isSkippable(p))).toBe(true);
  });
});
