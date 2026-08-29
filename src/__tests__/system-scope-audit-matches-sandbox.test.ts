/**
 * A system-scope approval does NOT always lift the sandbox, and the audit line
 * must say which happened.
 *
 * `[SYSTEM-SCOPE-AUDIT]` printed "(runs unsandboxed)" for every interactively
 * approved system-scope command, re-deriving the claim from
 * `preview.systemScopeInteractive` alone. The builder applies a second condition:
 * a command that is system-scope ONLY because it touches a path outside the
 * workspace keeps the sandbox, and the approved path reaches it through
 * `extraWritablePaths` instead. So both spellings appeared in one live log a
 * millisecond apart — the audit claiming the opposite of what happened
 * (2026-08-29), which is the worst property an audit line can have, since it is
 * read after an incident and nowhere else.
 *
 * The fix logs from the builder's return value rather than re-deriving. These
 * pin the DECISION the line now reports; the log string itself is not worth a
 * test, but a silent flip of this branch would make the line wrong again.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
    fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-scopeaudit-")),
  );
  tmpRoots.push(base);
  const ws = path.join(base, "workspace");
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}

/** Reach the private builder the same way the other interceptor tests do. */
function sandboxFor(ws: string, command: string) {
  const i = new PermissionInterceptor(ws, APP_ID, undefined, 1, "build") as unknown as {
    buildRunCommandSandbox: (preview?: unknown) => unknown | undefined;
  };
  return i.buildRunCommandSandbox({ systemScopeInteractive: true, command });
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

describe("what a system-scope approval actually does to the sandbox", () => {
  it("outside-path-only KEEPS the sandbox — so 'runs unsandboxed' was a lie", () => {
    const ws = makeWorkspace();
    // The shape from the live log: a write to a path outside the workspace,
    // approved, and still confined.
    expect(sandboxFor(ws, "echo test > ~/.docker/buildx/activity/.writetest")).toBeDefined();
    expect(sandboxFor(ws, "cd /Users/dev/other-repo && ls")).toBeDefined();
  });

  it("a genuine installer DOES lift it — that half was always true", () => {
    const ws = makeWorkspace();
    // An installer writes places nobody can enumerate up front, so the boundary
    // genuinely has to come off. This is the case the old wording described.
    expect(sandboxFor(ws, "sudo rm -rf /var/cache")).toBeUndefined();
    expect(sandboxFor(ws, "brew install jq")).toBeUndefined();
    expect(sandboxFor(ws, "npm install -g typescript")).toBeUndefined();
  });

  it("an installer BEHIND a cd still lifts it — the install is the reason", () => {
    const ws = makeWorkspace();
    expect(sandboxFor(ws, "cd /tmp && brew install jq")).toBeUndefined();
  });

  it("reports UNSANDBOXED honestly when the sandbox is switched off globally", () => {
    // The old line could not describe this at all. `sandboxRunCommand: false`
    // returns no options, so the audit now says so.
    const ws = makeWorkspace();
    globalSettings = { sandboxRunCommand: false };
    expect(sandboxFor(ws, "cd /Users/dev/other-repo && ls")).toBeUndefined();
  });
});
