/**
 * `atlarix acp`: an approval as the editor's Allow/Deny (src/cli/acp/permissions.ts),
 * and the prompt blocks as a CLI prompt (src/cli/acp/content.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  approvalMode,
  approvalOptions,
  approvalToolCall,
  mcpConsentDecision,
} from "@/cli/acp/permissions";
import { promptInput } from "@/cli/acp/content";
import type { PendingApproval } from "@/cli/agent/session";

const edit: PendingApproval = {
  operationId: "op1",
  request: {
    operation: "edit_file",
    preview: {
      path: "README.md",
      type: "update",
      oldContent: "# pulse\n",
      content: "# pulse\n\n## Usage\n",
      description: "Add a Usage section",
      fileParentDir: "docs",
    },
  },
};

const command: PendingApproval = {
  operationId: "op2",
  request: { operation: "run_command", preview: { command: "npm test", description: "Run the tests" } },
};

describe("approval → request_permission", () => {
  it("an edit carries the whole-file diff and the TUI's choices", () => {
    const call = approvalToolCall(edit);
    expect(call).toMatchObject({ toolCallId: "approval:op1", kind: "edit", status: "pending" });
    expect(call.title).toBe("Edit this file: README.md");
    expect(call.content?.[0]).toEqual({ type: "diff", path: "README.md", oldText: "# pulse\n", newText: "# pulse\n\n## Usage\n" });
    expect(approvalOptions(edit).map((o) => [o.optionId, o.kind])).toEqual([
      ["once", "allow_once"],
      ["always_allow_file", "allow_always"],
      ["always_allow_directory", "allow_always"],
      ["deny", "reject_once"],
    ]);
  });

  it("a command shows the command; no 'always' when it cannot be remembered", () => {
    expect(approvalToolCall(command)).toMatchObject({ kind: "execute", title: "Run npm test" });
    const once: PendingApproval = {
      operationId: "op3",
      request: { preview: { command: "rm -rf build", canAlwaysAllow: false } },
    };
    expect(approvalOptions(once).map((o) => o.optionId)).toEqual(["once", "deny"]);
  });

  it("the editor's answer becomes an approval mode; dismissed or unknown is a No", () => {
    expect(approvalMode(edit, { outcome: "selected", optionId: "always_allow_file" })).toBe("always_allow_file");
    expect(approvalMode(edit, { outcome: "selected", optionId: "always_allow" })).toBe("deny");
    expect(approvalMode(edit, { outcome: "cancelled" })).toBe("deny");
    expect(mcpConsentDecision({ outcome: "selected", optionId: "accept-once" })).toBe("accept-once");
    expect(mcpConsentDecision({ outcome: "cancelled" })).toBe("decline");
  });
});

describe("prompt blocks → CLI prompt", () => {
  it("text, an attached file inline, a linked file as a workspace mention, an image saved", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "acp-content-"));
    const r = promptInput(
      [
        { type: "text", text: "Explain this" },
        { type: "resource", resource: { uri: "file:///ws/src/a.ts", text: "export const a = 1;" } },
        { type: "resource_link", uri: "file:///ws/src/b.ts", name: "b.ts" },
        { type: "resource_link", uri: "file:///elsewhere/c.ts", name: "c.ts" },
        { type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" },
      ],
      "/ws",
      scratch,
    );
    expect(r.text).toBe(
      "Explain this\n\n[/ws/src/a.ts]\nexport const a = 1;\n\n@file:src/b.ts\n\n@file:/elsewhere/c.ts",
    );
    expect(r.images).toHaveLength(1);
    expect(fs.readFileSync(r.images[0]!.path, "utf8")).toBe("png");
    expect(r.images[0]!.mime).toBe("image/png");
  });
});
