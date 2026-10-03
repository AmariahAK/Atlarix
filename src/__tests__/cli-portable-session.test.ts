/**
 * /export and /import's shared shape (src/cli/sessions/portable.ts): an
 * Atlarix transcript becomes user/assistant messages with what the agent did,
 * Markdown reads like the conversation, --sanitize keeps secrets out, and a
 * file is only taken for an Atlarix export when it says it is one.
 */
import { describe, expect, it } from "vitest";
import {
  exportFileName,
  fromAtlarixMessages,
  messageContent,
  parsePortable,
  sanitize,
  toMarkdown,
} from "@/cli/sessions/portable";
import { parseCommandLine, matchCommands } from "@/cli/tui/commands";
import { parseExportArgs, describeTrigger } from "@/cli/tui/screens";

const now = new Date("2026-10-02T10:00:00Z");

describe("portable sessions", () => {
  it("turns a transcript into user and assistant messages, tools included", () => {
    const doc = fromAtlarixMessages(
      [
        { id: 1, role: "user", content: "what does a.ts export?" },
        { id: 2, role: "assistant", content: "It exports `a`." },
      ],
      { title: null, workspace: "/w", now },
    );
    expect(doc).toMatchObject({ format: "atlarix-session", version: 1, source: "atlarix", title: "what does a.ts export?" });
    expect(doc.messages).toEqual([
      { role: "user", text: "what does a.ts export?" },
      { role: "assistant", text: "It exports `a`." },
    ]);
  });

  it("writes Markdown a person reads as the conversation", () => {
    const md = toMarkdown({
      format: "atlarix-session",
      version: 1,
      title: "Fix it",
      source: "atlarix",
      workspace: "/w",
      exportedAt: now.toISOString(),
      messages: [
        { role: "user", text: "fix the test" },
        { role: "assistant", text: "Fixed.", tools: [{ name: "Edit", target: "a.ts" }, { name: "Run", target: "npm test", failed: true }] },
      ],
    });
    expect(md).toContain("# Fix it");
    expect(md).toContain("## You\n\nfix the test");
    expect(md).toContain("- ● Edit `a.ts`\n- ✗ Run `npm test`");
    expect(md).toContain("Fixed.");
  });

  it("an imported assistant turn says what it did, then what it said", () => {
    expect(messageContent({ role: "assistant", text: "Done.", tools: [{ name: "Read", target: "a.ts" }] })).toBe("● Read a.ts\n\nDone.");
    expect(messageContent({ role: "user", text: "hi" })).toBe("hi");
  });

  it("--sanitize removes the home folder, emails and key-shaped strings", () => {
    const out = sanitize("in /Users/me/proj, key sk-ant-abcdefghijklmnopqrstu, mail me@x.io, ghp_" + "a".repeat(30), "/Users/me");
    expect(out).toBe("in ~/proj, key [redacted key], mail [email], [redacted key]");
  });

  it("reads back only Atlarix exports", () => {
    expect(parsePortable('{"format":"atlarix-session","version":1,"messages":[]}')).not.toBeNull();
    expect(parsePortable('{"messages":[]}')).toBeNull();
    expect(parsePortable("not json")).toBeNull();
  });

  it("names the file after the session", () => {
    expect(exportFileName("Fix the login bug!", "md", now)).toBe("atlarix-fix-the-login-bug-2026-10-02.md");
    expect(exportFileName("", "json", now)).toBe("atlarix-session-2026-10-02.json");
  });
});

describe("command lines", () => {
  it("splits a command from its arguments, and only for real commands", () => {
    expect(parseCommandLine("/export notes.md --sanitize")).toEqual({ name: "/export", rest: "notes.md --sanitize" });
    expect(parseCommandLine("/resume")).toEqual({ name: "/resume", rest: "" });
    expect(parseCommandLine("/nope")).toBeNull();
    expect(parseCommandLine("explain /export")).toBeNull();
  });

  it("the palette closes once arguments are being typed", () => {
    expect(matchCommands("/ex").map((c) => c.name)).toContain("/export");
    expect(matchCommands("/export notes.md")).toEqual([]);
    // The exact name wins over a longer one it prefixes (/mode, not /model).
    expect(matchCommands("/mode")[0]!.name).toBe("/mode");
    expect(matchCommands("/mod").map((c) => c.name)).toEqual(["/model", "/mode"]);
  });

  it("/export's arguments", () => {
    expect(parseExportArgs("")).toEqual({ json: false, sanitize: false, file: undefined });
    expect(parseExportArgs("out.json --sanitize")).toEqual({ json: true, sanitize: true, file: "out.json" });
    expect(parseExportArgs("--json")).toEqual({ json: true, sanitize: false, file: undefined });
  });

  it("describes a trigger in words", () => {
    expect(describeTrigger({ kind: "schedule", cron: "0 9 * * 1-5" })).toBe("weekday mornings");
    expect(describeTrigger({ kind: "schedule", cron: "30 8 * * *" })).toBe("cron 30 8 * * * (8:30 AM)");
    expect(describeTrigger({ kind: "mcp", serverId: 1, tool: "list_issues", intervalMinutes: 15 })).toBe("checks list_issues every 15 min");
  });
});
