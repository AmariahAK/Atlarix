import { describe, expect, it } from "vitest";
import { filterEntries, mentionAt, mentionInsert } from "@/cli/agent/file-index";
import { parseShellInput, placeShellRuns, withShellContext, type ShellRun } from "@/cli/agent/shell-mode";
import type { Cell } from "@/cli/agent/transcript";

const run = (over: Partial<ShellRun> = {}): ShellRun => ({
  id: "r1",
  command: "npm test",
  output: "1 failed\n",
  exitCode: 1,
  status: "success",
  afterMessageId: "",
  delivered: false,
  ...over,
});

describe("!command", () => {
  it("only a leading ! with something after it is a command", () => {
    expect(parseShellInput("!ls -la")).toBe("ls -la");
    expect(parseShellInput("  ! git status ")).toBe("git status");
    expect(parseShellInput("!")).toBeNull();
    expect(parseShellInput("why does ! fail")).toBeNull();
  });

  it("the next message carries the runs the agent has not seen, and only those", () => {
    const prompt = withShellContext("fix that", [run(), run({ id: "r0", delivered: true, command: "old" })]);
    expect(prompt).toContain("$ npm test");
    expect(prompt).toContain("(exit code 1)");
    expect(prompt).toContain("1 failed");
    expect(prompt).not.toContain("old");
    expect(prompt.endsWith("fix that")).toBe(true);
    expect(withShellContext("hi", [run({ status: "running" })])).toBe("hi");
  });

  it("keeps the END of long output, where the errors are", () => {
    const output = "start\n" + "x".repeat(40_000) + "\nTHE ERROR";
    const prompt = withShellContext("p", [run({ output })]);
    expect(prompt).toContain("THE ERROR");
    expect(prompt).not.toContain("start\n");
    expect(prompt).toContain("earlier characters cut");
  });

  it("a run sits after the message it followed, in order", () => {
    const cells: Cell[] = [
      { kind: "user", id: "1:u", text: "a" },
      { kind: "markdown", id: "2:0", text: "b" },
      { kind: "user", id: "3:u", text: "c" },
    ];
    const placed = placeShellRuns(cells, [
      run({ id: "x", afterMessageId: "2" }),
      run({ id: "y", afterMessageId: "2" }),
      run({ id: "z", afterMessageId: "" }),
    ]);
    expect(placed.map((c) => c.id)).toEqual(["shell:z", "1:u", "2:0", "shell:x", "shell:y", "3:u"]);
    const t = placed[3]!;
    expect(t.kind === "tool" && t.tool.status).toBe("error"); // exit 1
  });
});

describe("@ completion", () => {
  const entries = ["src/", "src/auth/", "README.md", "src/auth/login.ts", "src/app/blog-login-page.tsx", "docs/login-notes.md"];

  it("finds the @query being typed, not an email address", () => {
    expect(mentionAt("look at @src/au")).toBe("src/au");
    expect(mentionAt("@")).toBe("");
    expect(mentionAt("mail me@example.com")).toBeNull();
    expect(mentionAt("@done and more")).toBeNull();
  });

  it("names that start with the query first, then contain it, then paths, then fuzzy", () => {
    expect(filterEntries(entries, "login")).toEqual(["src/auth/login.ts", "docs/login-notes.md", "src/app/blog-login-page.tsx"]);
    expect(filterEntries(entries, "auth")[0]).toBe("src/auth/");
    expect(filterEntries(entries, "sal")).toContain("src/auth/login.ts");
    expect(filterEntries(entries, "")).toEqual(["src/", "README.md"]);
  });

  it("a path with spaces is quoted", () => {
    expect(mentionInsert("my docs/a b.md")).toBe('"my docs/a b.md" ');
    expect(mentionInsert("a.ts")).toBe("a.ts ");
  });
});
