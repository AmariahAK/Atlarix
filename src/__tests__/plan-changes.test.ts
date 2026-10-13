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

/**
 * QA (app) #15: the Plan panel's "What's changing" read "Modify: src/tally.js,
 * src/tally.test.js, src/tally.js, src/tally.js" — one entry per approval —
 * and left out bin/tally.js (created) and package.json. The plan names its
 * files in backticks, which the path pattern did not accept, so the panel fell
 * back to the pending approvals, undeduplicated.
 */
import { resolvePlanChanges } from "@/lib/plan-changes/plan-changes";

const QA_PLAN = `Add a small \`--top N\` CLI and fix the broken word-count core.

1. [x] Fix \`src/tally.js\` — tokenize (lowercase, strip punctuation/newlines, empty → no words) and sort descending.
2. [x] Add \`bin/tally.js\` — shebang ESM script parsing \`--top N\` (default 10), reading stdin, printing \`word count\` lines.
3. [x] Wire up \`package.json\` — add \`"bin": { "tally": "bin/tally.js" }\`.
4. [x] Verify — \`npm test\` passes (4 tests) and manual \`--top 2\` pipe check prints \`a 3\` then \`b 2\`.`;

describe("what a plan is changing (QA #15)", () => {
  it("reads paths written in backticks, and an added file as created", () => {
    expect(deriveFilesFromPlanMarkdown(QA_PLAN)).toEqual([
      { path: "src/tally.js", action: "MODIFY" },
      { path: "bin/tally.js", action: "CREATE" },
      { path: "package.json", action: "MODIFY" },
    ]);
  });

  it("lists each file once: the plan's files, plus what the approvals touch beyond them", () => {
    const changes = resolvePlanChanges([], QA_PLAN, [
      { path: "src/tally.js", operation: "update" },
      { path: "src/tally.test.js", operation: "update" },
      { path: "src/tally.js", operation: "update" },
      { path: "src/tally.js", operation: "update" },
    ]);
    expect(changes?.files).toEqual([
      { path: "src/tally.js", action: "MODIFY" },
      { path: "bin/tally.js", action: "CREATE" },
      { path: "package.json", action: "MODIFY" },
      { path: "src/tally.test.js", action: "MODIFY" },
    ]);
  });

  it("approvals alone are deduplicated too", () => {
    const changes = resolvePlanChanges([], "No files named here.", [
      { path: "a.ts", operation: "update" },
      { path: "a.ts", operation: "update" },
      { path: "b.ts", operation: "create" },
    ]);
    expect(changes?.files).toEqual([
      { path: "a.ts", action: "MODIFY" },
      { path: "b.ts", action: "CREATE" },
    ]);
  });

  it("the model's own changes comment still wins", () => {
    const changes = resolvePlanChanges(
      [{ role: "assistant", content: '<!-- atlarix-changes:{"files":[{"path":"x.ts","action":"DELETE"}]} -->' }],
      QA_PLAN,
      [],
    );
    expect(changes?.files).toEqual([{ path: "x.ts", action: "DELETE" }]);
  });
});

// QA (app) #35: "(README.md is a one-liner; no change needed.)" put README.md
// under "What's changing".
describe("a file the plan says won't change (QA #35)", () => {
  it("is not listed", () => {
    const md = `## Changes

- [x] **\`src/tally.js\`** — add a \`minLength\` parameter.
- [x] **\`docs/USAGE.md\`** — update the Usage block. (README.md is a one-liner; no change needed.)
- [ ] Leave \`package.json\` as-is. Update \`bin/tally.js\` to pass it through.`;
    expect(deriveFilesFromPlanMarkdown(md).map((f) => f.path)).toEqual([
      "src/tally.js",
      "docs/USAGE.md",
      "bin/tally.js",
    ]);
  });
});
