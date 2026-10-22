/**
 * Two ways a read-only command hung a headless run (QA A2 + A3, 2026-10-22):
 *
 * A2. `find /tmp/x` passing a chmod-000 folder prints
 *     `find: /tmp/x/locked: Permission denied`. That is the folder's own mode,
 *     not the sandbox (which never confines reads), yet it raised a "give write
 *     access" card.
 * A3. That card came from the interceptor itself, which only reaches app
 *     windows; the headless and automation auto-approvers never saw it, and the
 *     wait has no timeout, so `atlarix run` blocked until --timeout (none by
 *     default). An unattended run now answers every card it raises with a denial
 *     the model reads. The card is also system-scope now, like the folder-grant
 *     card: an unattended run must never grant itself a folder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PermissionInterceptor } from "@/ipc/handlers/permissions/interceptor";
import type { CommandResult } from "@/ipc/utils/runShellCommand";

type Escalating = {
  maybeEscalateSandboxDenial: (
    result: CommandResult,
    ctx: {
      commandToRun: string;
      workingDir: string;
      sandboxOpts: Record<string, unknown> | undefined;
      operationId: string;
      allowRetry: boolean;
    },
  ) => Promise<CommandResult | null>;
  getPendingOperations: () => Array<{ id: string; request: { preview?: Record<string, unknown> } }>;
  waitForApproval: (id: string, opts?: { abortSignal?: AbortSignal }) => Promise<string>;
  setUnattended?: (on: boolean) => void;
};

const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;
let tmp: string;
let ws: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-esc-")));
  ws = path.join(tmp, "ws");
  fs.mkdirSync(ws);
  fs.mkdirSync(path.join(tmp, "locked"));
  fs.mkdirSync(path.join(tmp, "writeonly"));
  fs.mkdirSync(path.join(tmp, "outside"));
  if (canChmod) {
    fs.chmodSync(path.join(tmp, "locked"), 0o000);
    fs.chmodSync(path.join(tmp, "writeonly"), 0o300);
  }
});
afterAll(() => {
  for (const d of ["locked", "writeonly"]) fs.chmodSync(path.join(tmp, d), 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function interceptor(signal?: AbortSignal): Escalating {
  return new PermissionInterceptor(ws, undefined, undefined, 1, "ask", signal) as unknown as Escalating;
}

const failed = (stderr: string): CommandResult =>
  ({ success: false, stdout: "", stderr, exitCode: 1 }) as unknown as CommandResult;

const ctx = (command: string) => ({
  commandToRun: command,
  workingDir: ws,
  sandboxOpts: {},
  operationId: "op_test",
  allowRetry: true,
});

/** Settles within `ms`, or "blocked". */
async function within<T>(p: Promise<T>, ms = 300): Promise<T | "blocked"> {
  return Promise.race([p, new Promise<"blocked">((r) => setTimeout(() => r("blocked"), ms))]);
}

describe.runIf(canChmod)("A2: a folder's own permissions are not the sandbox", () => {
  it("chmod 000 (unreadable, unwritable): no card", async () => {
    const i = interceptor();
    const out = await within(
      i.maybeEscalateSandboxDenial(failed(`find: ${path.join(tmp, "locked")}: Permission denied`), ctx(`find ${tmp}`)),
    );
    expect(out).not.toBe("blocked");
    expect(i.getPendingOperations()).toHaveLength(0);
  });

  it("chmod 300 (writable but unreadable): no card for a read error", async () => {
    const i = interceptor();
    const out = await within(
      i.maybeEscalateSandboxDenial(failed(`find: ${path.join(tmp, "writeonly")}: Permission denied`), ctx(`find ${tmp}`)),
    );
    expect(out).not.toBe("blocked");
    expect(i.getPendingOperations()).toHaveLength(0);
  });
});

describe("a real sandbox denial", () => {
  const denial = () => failed(`touch: ${path.join(tmp, "outside", "x.txt")}: Operation not permitted`);

  it("still raises ONE card when someone can answer it, marked system-scope", async () => {
    const ac = new AbortController();
    const i = interceptor(ac.signal);
    const pending = i.maybeEscalateSandboxDenial(denial(), ctx("touch x"));
    expect(await within(pending)).toBe("blocked");
    const ops = i.getPendingOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.request.preview?.systemScope).toBe(true);
    ac.abort();
    await pending.catch(() => {});
  });

  it("A3: an unattended run is denied at once, and the model is told why", async () => {
    const i = interceptor();
    i.setUnattended?.(true);
    const out = await within(i.maybeEscalateSandboxDenial(denial(), ctx("touch x")));
    expect(out).not.toBe("blocked");
    expect(i.getPendingOperations()).toHaveLength(0);
    const text = out && out !== "blocked" ? `${out.stdout ?? ""}${out.stderr ?? ""}` : "";
    expect(text).toMatch(/No one is here to approve/);
  });

  it("A3: any card waited on in an unattended run is rejected, not left blocking", async () => {
    const i = interceptor();
    i.setUnattended?.(true);
    expect(await within(i.waitForApproval("op_other"))).toBe("rejected");
  });
});
