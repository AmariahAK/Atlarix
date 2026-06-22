import { describe, expect, it } from "vitest";
import {
  parseAssistantMessageParts,
  splitContentPartsAtOffset,
} from "@/lib/chat/assistant-message-parts";
import { groupAssistantDisplayParts } from "@/lib/chat/display-parts-group";
import { splitContentByPlanMarkers } from "@/lib/plan-cards/plan-card-renderer";
import {
  buildCompletedStreamThreadFromAssistantContent,
  enrichStreamThreadFromAssistantContent,
  proseAlreadyRendered,
} from "@/lib/chat/stream-thread";
import { extractVisibleAnswerMarkdown } from "@/lib/chat/answer-display";
import {
  getPersistedToolExpandView,
  persistedToolPartToStreamCard,
} from "@/lib/chat/persisted-tool-card";
import { isToolExpandable } from "@/lib/chat/tool-expand-view";

describe("parseAssistantMessageParts", () => {
  it("orders tool before plan marker before answer markdown", () => {
    const marker =
      "<!-- atlarix-plan-artifact:787bb61d-51c9-4476-9370-ee0d7a6a7832 -->";
    const content = [
      '<atlarix-tool-call tool="read_file" status="running">{}</atlarix-tool-call>',
      '<atlarix-tool-result tool="read_file" status="success">ok</atlarix-tool-result>',
      marker,
      "Final answer for the user.",
    ].join("\n");

    const segments = splitContentByPlanMarkers(content);
    expect(segments.map((s) => s.type)).toEqual([
      "markdown",
      "plan-artifact",
      "markdown",
    ]);

    const parts = parseAssistantMessageParts(content, false);
    const types = parts.map((p) => p.type);

    expect(types.indexOf("tool")).toBeLessThan(types.indexOf("plan_artifact"));
    expect(types.indexOf("plan_artifact")).toBeLessThan(types.indexOf("markdown"));
    const md = parts.find((p) => p.type === "markdown");
    expect(md && md.type === "markdown" ? md.content : "").toContain("Final answer");
  });

  it("dedupes plan artifact markers by planId", () => {
    const id = "787bb61d-51c9-4476-9370-ee0d7a6a7832";
    const marker = `<!-- atlarix-plan-artifact:${id} -->`;
    const parts = parseAssistantMessageParts(`${marker}\n${marker}`, false);
    const plans = parts.filter((p) => p.type === "plan_artifact");
    expect(plans).toHaveLength(1);
  });

  it("parses bare multiline tool envelope into a tool part", () => {
    const envelope = [
      "{",
      '  "success": true,',
      '  "result": "# Repo overview\\n\\n## Top-level\\n- src/"',
      "}",
    ].join("\n");
    const content = `${envelope}\n\nFinal answer for the user.`;
    const parts = parseAssistantMessageParts(content, false);
    const tools = parts.filter((p) => p.type === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0] && tools[0].type === "tool" ? tools[0].toolName : "").toBe(
      "get_repo_overview",
    );
    const md = parts.find((p) => p.type === "markdown");
    expect(md && md.type === "markdown" ? md.content : "").toContain("Final answer");
  });

  it("dedupes consecutive identical tool envelopes", () => {
    const envelope = '{"success":true,"result":"same output"}';
    const parts = parseAssistantMessageParts(
      `${envelope}\n${envelope}\n\nDone.`,
      false,
    );
    expect(parts.filter((p) => p.type === "tool")).toHaveLength(1);
  });

  it("groups consecutive context tools for display", () => {
    const mk = (tool: string, result: string) =>
      [
        `<atlarix-tool-call tool="${tool}" status="running">{}</atlarix-tool-call>`,
        `<atlarix-tool-result tool="${tool}" status="success">${JSON.stringify({ success: true, result })}</atlarix-tool-result>`,
      ].join("\n");
    const content = [
      mk("read_file", "src/a.ts"),
      mk("search_code", "matches"),
      mk("get_repo_overview", "# Repo"),
    ].join("\n");
    const parts = parseAssistantMessageParts(content, false);
    const grouped = groupAssistantDisplayParts(parts);
    expect(grouped.some((g) => g.kind === "context_group")).toBe(true);
    const group = grouped.find((g) => g.kind === "context_group");
    expect(group && group.kind === "context_group" ? group.tools.length : 0).toBe(3);
  });

  it("suppresses trailing answer when markdown parts exist", () => {
    const content = [
      '<atlarix-tool-call tool="read_file" status="running">{}</atlarix-tool-call>',
      "Answer in parts.",
    ].join("\n");
    const parts = parseAssistantMessageParts(content, false);
    const hasMarkdown = parts.some((p) => p.type === "markdown");
    expect(hasMarkdown).toBe(true);
    const trailing = extractVisibleAnswerMarkdown(content);
    expect(
      proseAlreadyRendered(trailing, parts) || hasMarkdown,
    ).toBe(true);
  });

  it("detects when trailing prose is not yet in markdown parts", () => {
    const content = [
      '<atlarix-tool-call tool="read_file" status="running">{}</atlarix-tool-call>',
      '<atlarix-tool-result tool="read_file" status="success">ok</atlarix-tool-result>',
    ].join("\n");
    const parts = parseAssistantMessageParts(content, false);
    const trailing = extractVisibleAnswerMarkdown(
      `${content}\n\nFinal answer for the user.`,
    );
    expect(parts.every((p) => p.type !== "markdown")).toBe(true);
    expect(trailing).toContain("Final answer");
    expect(proseAlreadyRendered(trailing, parts)).toBe(false);
  });

  it("marks tool success during stream when tool-result is in content", () => {
    const content = [
      '<atlarix-tool-call tool="explore_folder" status="running">{}</atlarix-tool-call>',
      '<atlarix-tool-result tool="explore_folder" status="complete">done</atlarix-tool-result>',
    ].join("\n");
    const parts = parseAssistantMessageParts(content, true);
    const tools = parts.filter((p) => p.type === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0] && tools[0].type === "tool" ? tools[0].status : "").toBe(
      "success",
    );
  });

  it("marks tools success after stream ends (not stuck running)", () => {
    const content = [
      '<atlarix-tool-call tool="read_file" status="running">{"path":"src/a.ts"}</atlarix-tool-call>',
      '<atlarix-tool-result tool="read_file" status="success">file contents</atlarix-tool-result>',
      '<atlarix-tool-call tool="search" status="running">{"query":"foo"}</atlarix-tool-call>',
      '<atlarix-tool-result tool="search" status="success">matches</atlarix-tool-result>',
    ].join("\n");
    const parts = parseAssistantMessageParts(content, false);
    const tools = parts.filter((p) => p.type === "tool");
    expect(tools).toHaveLength(2);
    expect(tools.every((t) => t.type === "tool" && t.status === "success")).toBe(
      true,
    );
  });

  it("parses chat-only tagged content with thought, tool, and trailing answer", () => {
    const content = [
      "<think>Planning a web search.</think>",
      '<atlarix-tool-call tool="web_search" status="running">{"query":"weather"}</atlarix-tool-call>',
      '<atlarix-tool-result tool="web_search" status="complete">{"hits":2}</atlarix-tool-result>',
      "Here is the forecast for today.",
    ].join("\n");

    const parts = parseAssistantMessageParts(content, false);
    const types = parts.map((p) => p.type);
    expect(types).toContain("thought");
    expect(types).toContain("tool");
    expect(types.indexOf("thought")).toBeLessThan(types.indexOf("tool"));
    const tools = parts.filter((p) => p.type === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0] && tools[0].type === "tool" ? tools[0].status : "").toBe(
      "success",
    );
    const trailing = extractVisibleAnswerMarkdown(content);
    expect(trailing).toContain("forecast");
    const md = parts.find((p) => p.type === "markdown");
    const inMarkdown =
      md && md.type === "markdown"
        ? md.content.includes("forecast")
        : false;
    expect(inMarkdown || trailing.includes("forecast")).toBe(true);
  });

  it("emits separate thought parts in stream order (thought, markdown, thought, tool)", () => {
    const content = [
      "<think>First thought block.</think>",
      "First answer paragraph.",
      "<think>Second thought after response.</think>",
      '<atlarix-tool-call tool="read_file" status="running">{"path":"src/a.ts"}</atlarix-tool-call>',
      '<atlarix-tool-result tool="read_file" status="success">ok</atlarix-tool-result>',
      "Second answer paragraph.",
    ].join("\n");

    const parts = parseAssistantMessageParts(content, false);
    const types = parts.map((p) => p.type);

    expect(types.filter((t) => t === "thought")).toHaveLength(2);
    expect(types.indexOf("thought")).toBe(0);
    expect(types.indexOf("markdown")).toBeGreaterThan(0);
    expect(types.lastIndexOf("thought")).toBeLessThan(types.indexOf("tool"));
    expect(types.indexOf("tool")).toBeGreaterThan(types.lastIndexOf("thought"));
  });

  it("suppresses write_implementation_plan tool when artifact marker present", () => {
    const marker =
      "<!-- atlarix-plan-artifact:787bb61d-51c9-4476-9370-ee0d7a6a7832 -->";
    const content = [
      marker,
      '<atlarix-tool-call tool="write_implementation_plan" status="success">{}</atlarix-tool-call>',
      '<atlarix-tool-result tool="write_implementation_plan" status="success">{"message":"Plan created."}</atlarix-tool-result>',
    ].join("\n");

    const parts = parseAssistantMessageParts(content, false);
    expect(parts.some((p) => p.type === "tool")).toBe(false);
    expect(parts.some((p) => p.type === "plan_artifact")).toBe(true);
  });

  it("persisted tool card is expandable when resultText is present", () => {
    const content = [
      '<atlarix-tool-call tool="read_file" status="running">{"path":"src/a.ts"}</atlarix-tool-call>',
      '<atlarix-tool-result tool="read_file" status="success">export const x = 1;</atlarix-tool-result>',
    ].join("\n");
    const parts = parseAssistantMessageParts(content, false);
    const tool = parts.find((p) => p.type === "tool");
    expect(tool && tool.type === "tool" ? tool.resultText : "").toContain("export const");
    if (!tool || tool.type !== "tool") return;
    const expand = getPersistedToolExpandView(tool);
    expect(isToolExpandable(expand)).toBe(true);
    const card = persistedToolPartToStreamCard(tool);
    expect(isToolExpandable(card.expand)).toBe(true);
  });

  it("buildCompletedStreamThreadFromAssistantContent preserves tool expand", () => {
    const content = [
      '<atlarix-tool-call tool="read_file" status="running">{}</atlarix-tool-call>',
      '<atlarix-tool-result tool="read_file" status="success">line one\nline two</atlarix-tool-result>',
    ].join("\n");
    const thread = buildCompletedStreamThreadFromAssistantContent(content);
    const tool = thread.find((i) => i.kind === "tool");
    expect(tool?.kind).toBe("tool");
    if (tool?.kind !== "tool") return;
    expect(tool.expand?.kind).not.toBe("none");
  });

  it("enrichStreamThreadFromAssistantContent copies expand from content onto IPC tool", () => {
    const content = [
      '<atlarix-tool-call tool="read_file" status="running">{}</atlarix-tool-call>',
      '<atlarix-tool-result tool="read_file" status="success">detailed file body</atlarix-tool-result>',
    ].join("\n");
    const ipcOnly = [
      {
        kind: "tool" as const,
        id: "read_file",
        toolName: "read_file",
        summary: "Read file",
        status: "done" as const,
        ts: 1,
      },
    ];
    const enriched = enrichStreamThreadFromAssistantContent(ipcOnly, content);
    const tool = enriched.find((i) => i.kind === "tool");
    expect(tool?.kind).toBe("tool");
    if (tool?.kind !== "tool") return;
    expect(tool.detail).toContain("detailed file body");
    expect(tool.expand?.kind).not.toBe("none");
  });
});

describe("splitContentPartsAtOffset (native-FC sub-agent seam)", () => {
  const PRE = "Let me check a few things first.";
  const POST = "Now here is the continuation after the sub-agents.";

  it("splits prose around the recorded seam offset", () => {
    const content = `${PRE}${POST}`;
    const { before, after } = splitContentPartsAtOffset(
      content,
      PRE.length,
      true,
    );
    expect(before.map((p) => p.type)).toEqual(["markdown"]);
    expect(after.map((p) => p.type)).toEqual(["markdown"]);
    expect((before[0] as { content: string }).content).toContain("check a few");
    expect((after[0] as { content: string }).content).toContain("continuation");
  });

  it("returns all content before when offset is null (no round seam)", () => {
    const content = `${PRE}${POST}`;
    const { before, after } = splitContentPartsAtOffset(content, null, true);
    expect(after).toEqual([]);
    expect(before.length).toBeGreaterThan(0);
  });

  it("returns all content before when offset is at/after the end", () => {
    const content = `${PRE}`;
    const { before, after } = splitContentPartsAtOffset(
      content,
      content.length,
      true,
    );
    expect(after).toEqual([]);
    expect(before.length).toBeGreaterThan(0);
  });

  it("returns everything after the panel when the seam is at the very start", () => {
    const content = `${POST}`;
    const { before, after } = splitContentPartsAtOffset(content, 0, true);
    expect(before).toEqual([]);
    expect(after.length).toBeGreaterThan(0);
  });
});
