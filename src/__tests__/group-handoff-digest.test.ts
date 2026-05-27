import { describe, expect, it } from "vitest";
import { buildGroupHandoffDigest } from "@/lib/chat/group-handoff-digest";

describe("buildGroupHandoffDigest", () => {
  it("appends grouped tool sections to prose", () => {
    const out = buildGroupHandoffDigest(
      [
        { toolName: "read_file", summary: "src/a.ts" },
        { toolName: "grep", summary: "3 matches" },
      ],
      "Main finding.",
    );
    expect(out).toContain("Main finding.");
    expect(out).toContain("Read / explore");
    expect(out).toContain("Search");
  });
});
