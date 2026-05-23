import { describe, expect, it } from "vitest";
import {
  parsePlanChangesFromContent,
  deriveFilesFromPlanMarkdown,
  groupChangesByAction,
} from "@/lib/plan-changes/plan-changes";

describe("plan-changes", () => {
  it("parses atlarix-changes HTML comment", () => {
    const content = `Hello
<!-- atlarix-changes:{"files":[{"path":"lib/a.ts","action":"CREATE"}],"risks":["secret leak"]} -->
`;
    const parsed = parsePlanChangesFromContent(content);
    expect(parsed?.files).toEqual([{ path: "lib/a.ts", action: "CREATE" }]);
    expect(parsed?.risks).toEqual(["secret leak"]);
  });

  it("derives file paths from plan markdown", () => {
    const md = `## Steps
1. [ ] Update src/auth/payment.ts
2. [ ] Add lib/stripe.ts
`;
    const files = deriveFilesFromPlanMarkdown(md);
    expect(files.map((f) => f.path)).toContain("src/auth/payment.ts");
    expect(files.map((f) => f.path)).toContain("lib/stripe.ts");
  });

  it("groups files by action", () => {
    const grouped = groupChangesByAction([
      { path: "a.ts", action: "MODIFY" },
      { path: "b.ts", action: "CREATE" },
    ]);
    expect(grouped.MODIFY).toEqual(["a.ts"]);
    expect(grouped.CREATE).toEqual(["b.ts"]);
  });
});
