import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `manage_mcp_server` proposes; the USER authorises.
 *
 * The tool exists so the model can bring an MCP config across from another tool —
 * realistically by reading a `.mcp.json` out of a repo it just cloned. That makes every
 * proposal untrusted content, and the approval card the only real gate, so the property
 * these tests protect is: **nothing is written by the tool itself.** Every mutation goes
 * back as a `__permission_required` envelope and happens in
 * `PermissionInterceptor.executeMcpServerWrite` after a card is accepted.
 *
 * There were no tests for MCP server writes at all before this file, which is part of
 * why several bugs in the update handler went unnoticed for as long as they did.
 */

const rows: Array<Record<string, unknown>> = [];

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

const insertSpy = vi.fn();
const updateSpy = vi.fn();
const deleteSpy = vi.fn();

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => rows, then: undefined }),
      }),
    }),
    insert: (...a: unknown[]) => {
      insertSpy(...a);
      return { values: () => ({ returning: async () => [{ id: 1 }] }) };
    },
    update: (...a: unknown[]) => {
      updateSpy(...a);
      return { set: () => ({ where: async () => undefined }) };
    },
    delete: (...a: unknown[]) => {
      deleteSpy(...a);
      return { where: async () => undefined };
    },
  },
}));

const { ToolRegistry } = await import("@/lib/tools/registry");
await import("@/lib/tools/mcp");

const tool = () => ToolRegistry.get("manage_mcp_server")!;

const call = (args: Record<string, unknown>) =>
  tool().handler({ workspaceId: 7, ...args }) as Promise<
    Record<string, unknown>
  >;

beforeEach(() => {
  rows.length = 0;
  insertSpy.mockClear();
  updateSpy.mockClear();
  deleteSpy.mockClear();
});

describe("manage_mcp_server — proposes, never writes", () => {
  it("asks first and writes nothing when adding", async () => {
    const res = await call({
      operation: "add",
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });

    expect(res.__permission_required).toBe(true);
    expect(res.operation).toBe("mcp_server_write");
    // The whole contract: the handler touched no table.
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  /**
   * The single most important assertion in this file. `automationAutoApprove` waves
   * through any buffered request whose preview is neither `isDangerous` nor
   * `systemScope` — so without this flag, an automation running unattended on a
   * schedule could install a stdio server, which is arbitrary process execution, with
   * nobody watching.
   */
  it("marks every operation systemScope, so an unattended run cannot approve it", async () => {
    for (const args of [
      { operation: "add", name: "a", transport: "stdio", command: "x" },
      { operation: "edit", name: "existing", command: "y" },
      { operation: "delete", name: "existing" },
    ]) {
      rows.length = 0;
      if (args.operation !== "add") {
        rows.push({
          id: 3,
          name: "existing",
          transport: "stdio",
          command: "old",
          args: null,
          url: null,
        });
      }
      const res = await call(args);
      expect(
        (res.preview as { systemScope?: boolean } | undefined)?.systemScope,
      ).toBe(true);
    }
  });

  it("carries the literal command and argv, so the card can show what runs", async () => {
    const res = await call({
      operation: "add",
      name: "gh",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server-github"],
    });
    const preview = res.preview as { command?: string; args?: string[] };
    expect(preview.command).toBe("npx");
    expect(preview.args).toEqual(["-y", "server-github"]);
  });

  it("confines env VALUES to the payload, and shows the card only names", async () => {
    const res = await call({
      operation: "add",
      name: "gh",
      transport: "stdio",
      command: "npx",
      env: { GITHUB_TOKEN: "ghp_secret_value_here" },
    });
    const preview = res.preview as {
      envKeys?: string[];
      input?: { envJson?: Record<string, string> };
    };

    // What the CARD reads: names only. A value rendered on an approval card is a
    // value on screen and in anything that captures the UI.
    expect(preview.envKeys).toEqual(["GITHUB_TOKEN"]);
    expect(JSON.stringify(preview.envKeys)).not.toContain("ghp_secret");

    /**
     * The value itself is unavoidably present under `input`, because the executor has
     * no other source for it — it must write the row after approval, and by then the
     * tool call is over.
     *
     * Stated rather than hidden: this is the same exposure as reading the config in the
     * first place, which is accepted (the model tells the user to rotate the key). What
     * this pins is the CONFINEMENT — if a value ever shows up outside `input`, it has
     * reached a surface that was never meant to carry one.
     */
    expect(preview.input?.envJson?.GITHUB_TOKEN).toBe("ghp_secret_value_here");
    const withoutInput = { ...preview, input: undefined };
    expect(JSON.stringify(withoutInput)).not.toContain("ghp_secret_value_here");
  });

  it("refuses SSE by name instead of storing a row that can never connect", async () => {
    // SSE appears in other tools' configs. Substituting a transport, or accepting it
    // and failing later at the moment of use, both hide the cause.
    const res = await call({
      operation: "add",
      name: "remote",
      transport: "sse",
      url: "https://example.com/sse",
    });
    expect(res.__permission_required).toBeUndefined();
    expect(String(res.error)).toContain("sse");
    expect(String(res.error)).toContain("stdio");
  });

  it("refuses a stdio server with no command, and http with no url", async () => {
    expect(
      String(
        (await call({ operation: "add", name: "x", transport: "stdio" })).error,
      ),
    ).toContain("command");
    expect(
      String(
        (await call({ operation: "add", name: "x", transport: "http" })).error,
      ),
    ).toContain("url");
  });

  it("reports a missing server rather than proposing a change to nothing", async () => {
    const res = await call({ operation: "delete", name: "ghost" });
    expect(res.__permission_required).toBeUndefined();
    expect(String(res.error)).toContain("ghost");
  });

  it("refuses to add a name that already exists, and points at edit", async () => {
    rows.push({ id: 1, name: "github", transport: "stdio", command: "npx" });
    const res = await call({
      operation: "add",
      name: "github",
      transport: "stdio",
      command: "npx",
    });
    expect(res.__permission_required).toBeUndefined();
    expect(String(res.error)).toContain("edit");
  });

  it("says so instead of asking the user to approve a no-op edit", async () => {
    rows.push({
      id: 4,
      name: "github",
      transport: "stdio",
      command: "npx",
      args: null,
      url: null,
    });
    const res = await call({
      operation: "edit",
      name: "github",
      command: "npx",
    });
    expect(res.__permission_required).toBeUndefined();
    expect(res.success).toBe(true);
  });

  it("shows the delta on an edit", async () => {
    rows.push({
      id: 5,
      name: "github",
      transport: "stdio",
      command: "old-binary",
      args: null,
      url: null,
    });
    const res = await call({
      operation: "edit",
      name: "github",
      command: "new-binary",
    });
    const preview = res.preview as { changes?: string[] };
    expect(preview.changes?.join(" ")).toContain("old-binary");
    expect(preview.changes?.join(" ")).toContain("new-binary");
  });

  it("names every operation it accepts in its own description", async () => {
    // Drift here is silent: the model only attempts what the description advertises.
    const desc = tool().description;
    for (const op of ["add", "edit", "delete"]) {
      expect(desc).toContain(op);
    }
    // And it must say the thing that makes the tool safe to offer at all.
    expect(desc.toLowerCase()).toContain("approval");
  });
});
