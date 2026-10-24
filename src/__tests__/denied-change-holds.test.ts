/**
 * 15.11.0 (ai-c8, filming; ai-26 over raw ACP): after the user DENIED an edit,
 * the model delegated the same change to a writer sub-agent and accepted its
 * proposal, which asked again; a second "yes" landed the change in the turn the
 * user had denied it. A denied change is refused for the rest of the turn,
 * whoever makes it. Owner: that exact change only.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PermissionInterceptor } from "@/ipc/handlers/permissions/interceptor";
import { deniedChangeResult } from "@/ipc/handlers/chat_stream/permission-ui";

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-denied-")));
const edit = (p: string, content: string) => ({
  operation: "edit_file" as const,
  preview: { path: p, content, type: "update" },
});

function deny(i: PermissionInterceptor, req: ReturnType<typeof edit>): void {
  const id = i.generateOperationId();
  i.bufferOperation(id, req as never, true);
  i.rejectOperation(id);
}

describe("a denied change, later in the same turn", () => {
  const changed = "export const ants = [];\nexport function filterByTunnel() {}\n";

  it("the same change is refused, however its path is written", () => {
    const i = new PermissionInterceptor(ws);
    deny(i, edit(path.join(ws, "src", "ants.js"), changed));
    // A retry, and a sub-agent's proposal accepted with the same result.
    expect(i.isDeniedChange(edit(path.join(ws, "src", "ants.js"), changed) as never)).toBe(true);
    expect(i.isDeniedChange(edit("./src/ants.js", changed) as never)).toBe(true);
    expect(i.isDeniedChange(edit("src/ants.js", changed.replace(/\n/g, "\r\n")) as never)).toBe(true);
  });

  it("a different change to the same file, or another file, is not", () => {
    const i = new PermissionInterceptor(ws);
    deny(i, edit("src/ants.js", changed));
    expect(i.isDeniedChange(edit("src/ants.js", `${changed}// tidied\n`) as never)).toBe(false);
    expect(i.isDeniedChange(edit("src/bees.js", changed) as never)).toBe(false);
  });

  it("a new turn starts with nothing denied", () => {
    deny(new PermissionInterceptor(ws), edit("src/ants.js", changed));
    expect(new PermissionInterceptor(ws).isDeniedChange(edit("src/ants.js", changed) as never)).toBe(false);
  });

  it("the model is told not to route it through a sub-agent", () => {
    const out = JSON.parse(deniedChangeResult(edit("src/ants.js", changed)));
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/denied this exact change to src\/ants\.js/);
    expect(out.error).toMatch(/through a sub-agent/);
  });
});
