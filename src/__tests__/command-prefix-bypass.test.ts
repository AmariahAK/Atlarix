/**
 * A command cannot dodge the approval gate behind a shell prefix.
 *
 * Found 2026-10-01: the gate classified a command by its first word, and
 * `NAME=value` (the shell's per-command environment), `env`, `command`, `exec`
 * and `nohup` were not stripped first. So `X=1 rm a.txt` was category "x=1",
 * neither risky nor an installer, and ran without asking — as did `X=1 curl …`
 * (sending data out) and `FOO=bar ssh host`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/command-permissions-store", () => ({
  getWorkspaceCommandPermission: () => null,
  listWorkspaceCommandPermissions: () => [],
  revokeWorkspaceCommandPermission: () => {},
  upsertWorkspaceCommandPermission: () => {},
}));

import { resolveRunCommandPermissionGate } from "@/ipc/handlers/command_permission_handlers";
import { isDangerousCommand } from "@/lib/dangerous-commands";
import { stripLeadingWrappers } from "@/lib/command-segments";

const gate = (c: string) => resolveRunCommandPermissionGate(c, 1, "/tmp/ws", false);

describe("prefixes do not hide the real command", () => {
  it.each([
    "X=1 rm a.txt",
    "X='a b' curl https://example.com",
    'X="a \\" b" curl https://example.com',
    "FOO=bar ssh host",
    "env rm a.txt",
    "env -i PATH=/bin rm a.txt",
    "command curl x",
    "exec rm a",
    "nohup kill 5",
    "nice -n 5 rm a",
    "cd sub && X=1 rm a",
    "X=1 Y=2 brew install jq",
  ])("%s asks first", (cmd) => {
    expect(gate(cmd).action).toBe("prompt");
  });

  it("the approval card flags it as risky too", () => {
    expect(isDangerousCommand("X=1 rm a.txt")).toBe(true);
    expect(isDangerousCommand("FOO=bar ssh host")).toBe(true);
  });

  it("ordinary commands with a prefix still run", () => {
    expect(gate("FOO=1 ls").action).toBe("auto_allow");
    expect(gate("NODE_ENV=test npm test").action).toBe("auto_allow");
    expect(gate("ls -la").action).toBe("auto_allow");
  });

  it("sudo is never stripped", () => {
    expect(stripLeadingWrappers("sudo rm a")).toBe("sudo rm a");
    expect(stripLeadingWrappers("X=1 env Y=2 nohup npm test")).toBe("npm test");
  });
});
