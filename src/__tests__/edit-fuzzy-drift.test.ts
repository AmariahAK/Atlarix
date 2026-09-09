import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "@/lib/tools";

/**
 * v12 TODO 1.4: fuzzy edit drift is surfaced, not silent.
 *
 * When edit_file's old_content only matches via a non-exact strategy, the
 * permission payload carries a `notice` that reaches the model as the tool
 * result's `output` (interceptor.ts:829-831 → build-branch.ts), and the card
 * `description` includes it, with the matched line number.
 *
 * The notice must name the strategy that actually matched. Reporting every
 * fuzzy strategy as "indent/EOL tolerance" was worse than saying nothing: an
 * escape-normalized match read as an indentation problem and sent the model
 * hunting the wrong cause for ~25 turns.
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
  it("names the strategy that matched, with the matched line", async () => {
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
    // The notice must name the strategy that ACTUALLY matched. It used to say
    // "indent/EOL tolerance" for every fuzzy strategy, which misreported an
    // escape-normalized match as an indentation problem.
    expect(result.preview.notice).toContain("line-trimmed matching");
    expect(result.preview.notice).toContain("at line 5");
    expect(result.preview.description).toContain("line-trimmed matching");
    // new_content already carries the file's real 4-space indent, so the
    // re-anchor pass is a no-op and the replacement applies as provided.
    expect(result.preview.content).toContain("    value = 2");
    expect(result.preview.content).not.toMatch(/\n {2}value = 2/);
  });

  it("re-anchors drifted new_content to the file's actual indentation", async () => {
    // Model supplies BOTH old and new at 2 spaces; the file uses 4. The fuzzy
    // match must not write the model's 2-space indent into the file.
    const result: any = await ToolRegistry.execute("edit_file", {
      path: "src/config.py",
      operation: "replace",
      old_content: "  value = 1\n  return value",
      new_content: "  value = 2\n  return value",
      description: "Bump value",
      workspace: ws,
      chatMode: "build",
    });

    expect(result.__permission_required).toBe(true);
    expect(result.preview.notice).toContain(
      "re-anchored to the file's actual indentation",
    );
    expect(result.preview.content).toContain("    value = 2\n    return value");
    expect(result.preview.content).not.toContain("\n  value = 2");
  });

  it("re-anchors space-indented model input onto a tab-indented file (live Go corruption case)", async () => {
    fs.writeFileSync(
      path.join(ws, "src", "chat_tui.go"),
      "func update() {\n" +
        "\t\t\tif pending {\n" +
        "\t\t\t\tunsend()\n" +
        "\t\t\t} else if cancelRequested() {\n" +
        "\t\t\t\tcancel()\n" +
        "\t\t\t\treturn quit\n" +
        "\t\t\t}\n" +
        "}\n",
    );
    const result: any = await ToolRegistry.execute("edit_file", {
      path: "src/chat_tui.go",
      operation: "replace",
      old_content:
        "        } else if cancelRequested() {\n            cancel()\n            return quit",
      new_content:
        "        } else if cancelRequested() {\n            snapshot()\n            cancel()\n            return quit",
      description: "Add snapshot on cancel",
      workspace: ws,
      chatMode: "build",
    });

    expect(result.__permission_required).toBe(true);
    expect(result.preview.notice).toContain("re-anchored");
    // Mapped lines keep their real tab depth; the novel line extrapolates to
    // body depth (4 tabs). No space indentation may leak into the file.
    expect(result.preview.content).toContain(
      "\t\t\t} else if cancelRequested() {",
    );
    expect(result.preview.content).toContain("\t\t\t\tsnapshot()");
    expect(result.preview.content).toContain("\t\t\t\tcancel()");
    expect(result.preview.content).not.toMatch(/\n {2,}\S/);
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
