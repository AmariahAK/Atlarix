/**
 * The editor chat's decisions that need no browser: the model picker's groups
 * and search, the / and @ menus, Add a provider, the Problems context, and an
 * edit's diff (it used to compare line SETS, losing order and repeated lines).
 */
import { describe, expect, it } from "vitest";
import { rankFiles } from "../../packages/vscode/src/files";
import { problemsText } from "../../packages/vscode/src/problems";
import {
  chipProvider,
  diffRows,
  filterCommands,
  filterGroups,
  flatOptions,
  matchProviders,
  mentionAt,
  providerModelCount,
  recordsAnswer,
  slashQuery,
  toGroups,
} from "../../packages/vscode/webview/logic";

const groups = toGroups([
  { group: "recent", name: "Recent", options: [{ value: "openai/gpt-5", name: "GPT-5" }] },
  { group: "compass", name: "Atlarix", options: [{ value: "compass/auto", name: "Auto", description: "Free" }] },
  {
    group: "deepseek",
    name: "DeepSeek",
    options: [
      { value: "deepseek/deepseek-flash", name: "DeepSeek Flash", description: "128K context" },
      { value: "deepseek/deepseek-pro", name: "DeepSeek Pro" },
    ],
  },
]);

describe("the model picker", () => {
  it("takes flat or grouped options", () => {
    expect(toGroups([{ value: "a/b", name: "B" }])).toEqual([{ group: "", name: "", options: [{ value: "a/b", name: "B" }] }]);
    expect(flatOptions(groups)).toHaveLength(4);
  });

  it("searches names, ids and providers, every word", () => {
    expect(filterGroups(groups, "flash").flatMap((g) => g.options.map((o) => o.value))).toEqual(["deepseek/deepseek-flash"]);
    expect(filterGroups(groups, "deepseek pro").flatMap((g) => g.options.map((o) => o.value))).toEqual(["deepseek/deepseek-pro"]);
    expect(filterGroups(groups, "gpt")[0]?.name).toBe("Recent");
    expect(filterGroups(groups, "nothing-like-this")).toEqual([]);
    expect(filterGroups(groups, "")).toHaveLength(3);
  });

  it("counts a provider's models for Models & keys", () => {
    expect(providerModelCount(groups, "deepseek")).toBe(2);
    expect(providerModelCount(groups, "openai")).toBe(1);
    expect(providerModelCount(groups, "groq")).toBe(0);
  });

  it("names the chip's provider from the row's _meta, wherever the row is listed", () => {
    const withMeta = toGroups([
      // Under Recent, not its provider: the group can't say where it's from.
      { group: "recent", name: "Recent", options: [{ value: "openrouter/qwen", name: "Qwen3", _meta: { atlarix: { provider: "OpenRouter" } } }] },
      { group: "compass", name: "Atlarix", options: [{ value: "compass/auto", name: "Auto", description: "Free" }] },
    ]);
    expect(chipProvider(withMeta, "openrouter/qwen")).toBe("OpenRouter");
    // Atlarix keeps the plan: no provider beside it.
    expect(chipProvider(withMeta, "compass/auto")).toBeNull();
    expect(chipProvider(withMeta, "missing/model")).toBeNull();
    // An older agent sends no _meta: nothing, not a guess from the group.
    expect(chipProvider(groups, "deepseek/deepseek-flash")).toBeNull();
  });
});

describe("the / and @ menus", () => {
  const cmds = [{ name: "compact" }, { name: "status" }, { name: "undo" }, { name: "billing" }];
  it("/ matches commands from the start of the box, no space yet", () => {
    expect(slashQuery("/co")).toBe("/co");
    expect(slashQuery("/compact now")).toBeNull();
    expect(slashQuery("fix /co")).toBeNull();
    expect(filterCommands(cmds, "/").map((c) => c.name)).toEqual(["compact", "status", "undo", "billing"]);
    expect(filterCommands(cmds, "/u").map((c) => c.name)).toEqual(["undo", "status"]);
  });

  it("@ starts a mention at the start of the box or after a space, not inside an email", () => {
    expect(mentionAt("@src", 4)).toEqual({ start: 0, query: "src" });
    expect(mentionAt("look at @rea", 12)).toEqual({ start: 8, query: "rea" });
    expect(mentionAt("me@example.com", 14)).toBeNull();
    expect(mentionAt("look at @", 9)).toEqual({ start: 8, query: "" });
  });

  it("files: a name that starts with the query first, then contains it, then the path", () => {
    const files = [{ label: "src/lib/reader.ts" }, { label: "docs/README.md" }, { label: "src/read/index.ts" }, { label: "src/thread.ts" }];
    expect(rankFiles(files, "read", 10).map((f) => f.label)).toEqual(["docs/README.md", "src/lib/reader.ts", "src/thread.ts", "src/read/index.ts"]);
    expect(rankFiles(files, "", 2)).toHaveLength(2);
  });
});

describe("Add a provider", () => {
  const providers = [
    { id: "openai", name: "OpenAI", hasKey: true },
    { id: "openrouter", name: "OpenRouter", hasKey: false },
    { id: "groq", name: "Groq", hasKey: false },
    { id: "nebius", name: "Nebius AI Studio (OpenAI models)", hasKey: false },
  ];
  it("offers providers without a key, names that start with it first", () => {
    expect(matchProviders(providers, "open").map((p) => p.id)).toEqual(["openrouter", "nebius"]);
    expect(matchProviders(providers, "")).toEqual([]);
  });
});

describe("Problems as context", () => {
  it("errors before warnings, the open file first, info dropped, capped", () => {
    const r = problemsText(
      [
        { file: "b.ts", active: false, items: [{ line: 3, column: 1, severity: 0, message: "Cannot find name 'x'.", source: "ts" }] },
        { file: "a.ts", active: true, items: [{ line: 9, column: 2, severity: 1, message: "Unused" }, { line: 1, column: 1, severity: 2, message: "info" }] },
      ],
      50,
    );
    expect(r?.label).toBe("Problems (1 error, 1 warning)");
    expect(r?.body.split("\n")).toEqual(["a.ts:9:2 warning: Unused", "b.ts:3:1 error [ts]: Cannot find name 'x'."]);
    expect(problemsText([{ file: "a.ts", active: true, items: [{ line: 1, column: 1, severity: 3, message: "hint" }] }], 50)).toBeNull();
    const many = problemsText([{ file: "a.ts", active: false, items: Array.from({ length: 5 }, (_, i) => ({ line: i + 1, column: 1, severity: 0, message: "e" })) }], 2);
    expect(many?.body).toContain("… and 3 more");
  });
});

describe("an edit's diff", () => {
  it("keeps order and repeated lines, with context and gaps", () => {
    const old = ["a", "b", "x", "c", "d", "e", "f", "g", "x", "h"].join("\n");
    const neu = ["a", "b", "y", "c", "d", "e", "f", "g", "x", "x", "h"].join("\n");
    const rows = diffRows(old, neu, 1);
    expect(rows).toEqual([
      { kind: "ctx", text: "b" },
      { kind: "del", text: "x" },
      { kind: "add", text: "y" },
      { kind: "ctx", text: "c" },
      { kind: "gap", text: "⋯" },
      { kind: "ctx", text: "x" },
      { kind: "add", text: "x" },
      { kind: "ctx", text: "h" },
    ]);
  });
});

describe("an answered card's record in the chat", () => {
  // QA E9: every answer showed twice, the panel's record and Atlarix's own line.
  it("is left to Atlarix when it says what you approved (a command, a file, outside the folder)", () => {
    expect(recordsAnswer({ command: "git reset --hard" }, "1:t:run_command_0", false)).toBe(false);
    expect(recordsAnswer({ path: "src/a.ts" }, "1:t:edit_file_0", false)).toBe(false);
    expect(recordsAnswer({ outside: "/tmp/x" }, "approval:op1", false)).toBe(false);
  });

  it("is left to the call's own card for a No inside it", () => {
    expect(recordsAnswer({ path: "src/a.ts" }, "1:t:edit_file_0", true)).toBe(false);
  });

  it("is kept where nothing else says it: a No on a card of its own, and cards Atlarix does not confirm", () => {
    expect(recordsAnswer({ command: "rm -rf build" }, "approval:op2", true)).toBe(true);
    expect(recordsAnswer({ details: ["When: every day"] }, "approval:op3", false)).toBe(true);
    expect(recordsAnswer(undefined, "mcp-consent:7", true)).toBe(true);
  });
});
