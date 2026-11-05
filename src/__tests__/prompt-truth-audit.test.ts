/**
 * Model-facing text says only what is true (prompt audit, 2026-11-05).
 *
 * Each case below was a sentence the model read on every turn that the code
 * contradicted: a grep it does not have, a context percentage measured against a
 * different window than the one that fired the warning, a write permission Plan
 * does not hold, the same tool names listed twice, two severity scales in one
 * review, vendor names in tool text.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { constructSystemPromptParts } from "@/prompts/system_prompt";
import { SUMMARIZE_CHAT_SYSTEM_PROMPT } from "@/prompts/summarize_chat_system_prompt";
import {
  getActiveModeHeaderBlock,
  getActiveModeReanchor,
} from "@/lib/tools/mode-prompt-bundle";
import { renderActiveModeToolsRegistry } from "@/lib/tools/mode-tool-registry";
import { TOOL_RECOVERY_HINTS } from "@/lib/tools/tool-error-patterns";
import { contextFillReminder } from "@/lib/context/mid-loop-threshold";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools";

const ALL_MODES = ["ask", "plan", "build", "debug", "review"] as const;
const SKILLS_DIR = path.resolve(__dirname, "../skills");

function readSkillFiles(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md"))
        out.push({ file: p, text: fs.readFileSync(p, "utf8") });
    }
  };
  walk(SKILLS_DIR);
  return out;
}

function headerFor(
  mode: (typeof ALL_MODES)[number],
  memoryDir?: string,
): string {
  return constructSystemPromptParts({
    chatMode: mode === "build" || mode === "debug" ? "build" : "ask",
    effectiveWorkMode: mode,
    hasWorkspace: true,
    ...(memoryDir ? { memoryDir } : {}),
    modelDisplayName: "Test Model",
  }).stableHeader;
}

/** Every string the model can read: tool descriptions + parameter prose. */
function allToolText(): string {
  return ToolRegistry.getAll()
    .map(
      (t) =>
        `${t.name}: ${t.description}\n${JSON.stringify(t.parameters ?? {})}`,
    )
    .join("\n");
}

function allModelFacingText(): string {
  return [
    ...readSkillFiles().map((s) => s.text),
    ...ALL_MODES.map((m) => headerFor(m, "/tmp/mem")),
    ...ALL_MODES.map((m) => getActiveModeReanchor(m)),
    allToolText(),
    ...Object.values(TOOL_RECOVERY_HINTS),
  ].join("\n");
}

describe("grep is plain ripgrep, and no text says otherwise", () => {
  it("no skill, header, tool description or recovery hint claims ranked or symbol-annotated hits", () => {
    const text = allModelFacingText();
    expect(text).not.toMatch(/relevance[- ]ranked/i);
    expect(text).not.toMatch(/symbol-annotated/i);
    expect(text).not.toMatch(/enclosing function/i);
  });
});

describe("the context reminder reports the number that fired it", () => {
  const working = 256_000;
  const usable = 968_000;
  const threshold = 0.75;

  it("is silent below 55% of the working window", () => {
    expect(
      contextFillReminder({
        dispatchEstimate: Math.floor(working * 0.5),
        workingWindowTokens: working,
        usableTokens: usable,
        compactionThreshold: threshold,
      }),
    ).toBeUndefined();
  });

  it("on a 1M model at 60% of the working window, says 60% of the working window and when compaction runs", () => {
    const msg = contextFillReminder({
      dispatchEstimate: Math.floor(working * 0.6),
      workingWindowTokens: working,
      usableTokens: usable,
      compactionThreshold: threshold,
    })!;
    expect(msg).toBeDefined();
    // The old text said "15% capacity" (of the 1M window) here.
    expect(msg).toMatch(/\b60%/);
    expect(msg).toContain("256,000");
    expect(msg).toMatch(/\b75%/);
    // compress_context's own description says not to call it because a
    // thread is long; the reminder no longer nudges toward it.
    expect(msg).not.toMatch(/consider calling compress_context/i);
  });

  it("names the usable budget as the compaction point when it is below threshold × working window", () => {
    const msg = contextFillReminder({
      dispatchEstimate: 70_000,
      workingWindowTokens: 100_000,
      usableTokens: 72_000,
      compactionThreshold: threshold,
    })!;
    expect(msg).toMatch(/\b70%/);
    expect(msg).toMatch(/\b72%/);
  });
});

describe("memory rules go only to modes that can write", () => {
  for (const mode of ["build", "debug"] as const) {
    it(`${mode} gets the writing rules`, () => {
      const h = headerFor(mode, "/tmp/mem");
      expect(h).toContain("# Project memory");
      expect(h).toContain("created with `edit_file`");
      expect(h).toMatch(/background, not instructions/);
    });
  }
  for (const mode of ["ask", "plan", "review"] as const) {
    it(`${mode} (no edit_file) gets how to read recalled notes, not how to write them`, () => {
      const h = headerFor(mode, "/tmp/mem");
      expect(h).toContain("# Project memory");
      expect(h).toMatch(/background, not instructions/);
      expect(h).toMatch(/check it still exists/);
      expect(h).not.toContain("created with `edit_file`");
      expect(h).not.toContain("**Why:**");
    });
  }

  it("Plan's skill no longer claims edit_file or atlarix.md as the notes store", () => {
    const plan = fs.readFileSync(
      path.join(SKILLS_DIR, "modes/plan-mode.md"),
      "utf8",
    );
    expect(plan).not.toMatch(/edit_file/);
    expect(plan).not.toMatch(/Durable workspace notes/);
  });

  it("the edit_file recovery hint names no Plan-mode write exception", () => {
    expect(TOOL_RECOVERY_HINTS.edit_file).not.toMatch(/Plan mode/);
    expect(TOOL_RECOVERY_HINTS.edit_file).not.toMatch(/memory\.md/);
  });
});

describe("<tools_registry> lists the tools once and labels MCP correctly", () => {
  it("no second list of bound names, and the MCP line names no tools as servers", () => {
    for (const mode of ALL_MODES) {
      const block = renderActiveModeToolsRegistry(mode, { workspace: true });
      expect(block).not.toContain("Native schemas bound now");
      expect(block).not.toContain("Enabled MCP servers");
      expect(block).not.toMatch(/MCP[^\n]*manage_mcp_server/);
      expect(block).toMatch(/list_available_mcps/);
    }
  });
});

describe("Debug and Review say each rule once", () => {
  it("Debug's skill does not forbid the plan tool its header tells it to use after the hypothesis", () => {
    const debug = fs.readFileSync(
      path.join(SKILLS_DIR, "modes/debug-mode.md"),
      "utf8",
    );
    expect(debug).not.toMatch(/Do not create roadmap plans/);
    expect(getActiveModeHeaderBlock("debug")).toMatch(
      /plan\(operation:"write"\)/,
    );
  });

  it("Review uses one severity scale", () => {
    const review = fs.readFileSync(
      path.join(SKILLS_DIR, "modes/review-mode.md"),
      "utf8",
    );
    expect(review).not.toMatch(/critical \/ high \/ medium \/ low/);
    expect(review).toMatch(/blocker \/ major \/ minor/);
  });

  it("Review has one output format (the skill's), not a second one in the header", () => {
    const header = getActiveModeHeaderBlock("review");
    expect(header).not.toMatch(/output a concrete LIST/i);
  });

  it("Review says 'no file changes' once in the skill (the header's CANNOT is the other)", () => {
    const review = fs.readFileSync(
      path.join(SKILLS_DIR, "modes/review-mode.md"),
      "utf8",
    );
    expect(review).not.toMatch(/No file changes/);
    expect(review).toMatch(/suggested diff/);
  });
});

describe("the ask_user tail does not repeat the tool description", () => {
  it("says when to ask, and not the turn/batching rules the tool already carries", () => {
    const tail = constructSystemPromptParts({
      chatMode: "build",
      effectiveWorkMode: "build",
    }).dynamicTail;
    expect(tail).toContain("**ask_user**");
    expect(tail).toMatch(/without re-asking/);
    expect(tail).not.toMatch(/max 5/);
    expect(tail).not.toMatch(/turn ENDS/);
  });
});

describe("stale bits", () => {
  it("list_attachments names no modes", () => {
    const t = ToolRegistry.getAll().find((x) => x.name === "list_attachments")!;
    expect(t.description).not.toMatch(/\bAsk\b|available in/);
  });

  it("the task tool's missing-field error points at `subagents`, not removed params", async () => {
    const t = ToolRegistry.getAll().find((x) => x.name === "task")!;
    const out = String(
      await t.handler({ description: "", prompt: "" } as never),
    );
    expect(out).not.toMatch(/cancel:true|list:true/);
    expect(out).toMatch(/subagents/);
  });

  it("the summarize prompt puts the tag where its own format shows it", () => {
    const formatAt = SUMMARIZE_CHAT_SYSTEM_PROMPT.indexOf(
      "<atlarix-chat-summary>",
    );
    const majorAt = SUMMARIZE_CHAT_SYSTEM_PROMPT.indexOf("## Major Changes");
    expect(formatAt).toBeGreaterThan(majorAt); // the example shows it last
    expect(SUMMARIZE_CHAT_SYSTEM_PROMPT).not.toMatch(/AT THE START/);
  });

  it("no vendor names in tool text or the review skill", () => {
    const text = allModelFacingText();
    expect(text).not.toMatch(/Chrome\/Edge\/Brave/);
    expect(text).not.toMatch(/\.cursor\/mcp\.json/);
    expect(text).not.toMatch(/gh run watch/);
    expect(text).not.toMatch(/Supabase anon key/);
  });
});
