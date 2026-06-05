import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "@/lib/tools";

/**
 * v12 TODO 1.4: fuzzy edit drift is surfaced, not silent.
 *
 * When edit_file's old_content only matches with indent/EOL tolerance, the
 * permission payload must carry a `notice` (→ model tool result `output` via
 * the interceptor) and the card `description` must include it, with the
 * matched line number.
 */

let ws: string;

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-fuzzy-edit-"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "src", "config.py"),
    "import os\n\n\ndef load():\n    value = 1\n    return value\n",
  );
});

afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe("edit_file fuzzy drift signal", () => {
  it("surfaces an indent-tolerance notice with the matched line", async () => {
    const result: any = await ToolRegistry.execute("edit_file", {
      path: "src/config.py",
      operation: "replace",
      // Wrong indentation (2 spaces instead of 4) — exact match fails, the
      // per-line trimStart() retry lands at line 5.
      old_content: "  value = 1\n  return value",
      new_content: "    value = 2\n    return value",
      description: "Bump value",
      workspace: ws,
      chatMode: "build",
    });

    expect(result.__permission_required).toBe(true);
    expect(result.preview.notice).toContain("indent/EOL tolerance at line 5");
    expect(result.preview.description).toContain("indent/EOL tolerance");
    // The replacement uses the caller's new_content verbatim.
    expect(result.preview.content).toContain("    value = 2");
  });

  it("exact matches carry no notice", async () => {
    const result: any = await ToolRegistry.execute("edit_file", {
      path: "src/config.py",
      operation: "replace",
      old_content: "    value = 1\n    return value",
      new_content: "    value = 3\n    return value",
      description: "Bump value",
      workspace: ws,
      chatMode: "build",
    });

    expect(result.__permission_required).toBe(true);
    expect(result.preview.notice).toBeUndefined();
    expect(result.preview.description).not.toContain("tolerance");
  });
});
