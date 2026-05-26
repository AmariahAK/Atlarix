import { describe, expect, it } from "vitest";
import { parseAssistantMessageParts } from "@/lib/chat/assistant-message-parts";
import { groupAssistantDisplayParts } from "@/lib/chat/display-parts-group";
import { splitContentByPlanMarkers } from "@/lib/plan-cards/plan-card-renderer";

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
});
