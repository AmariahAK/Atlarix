/**
 * A screenshot of a page is page content, and text in a picture can carry
 * instructions as well as text in the page can. Every text result of the
 * browser tools rides the untrusted-data envelope; the screenshot result rode
 * nothing ("Screenshot of the tab in the user's own browser."). Its caption
 * now says the image is untrusted and where it came from.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.fn();

vi.mock("@/main/bridge-lifecycle", () => ({
  bridge: () => ({ connected: true, request: requestMock }),
}));

import "@/lib/tools/index";
import { ToolRegistry } from "@/lib/tools/registry";
import { buildToolModelOutput } from "@/lib/ai/tool-model-output";

const PNG = "iVBORw0KGgoAAAANSUhEUg".repeat(40);

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue({
    tabId: 7,
    url: "https://evil.example/page?x=1",
    title: "A page",
    mimeType: "image/png",
    data: PNG,
  });
});

async function screenshotOutput() {
  const result = await ToolRegistry.get("browser_inspect")!.handler({ mode: "screenshot" });
  const out = buildToolModelOutput("browser_inspect", { success: true, result }, {
    builtinProviderId: "anthropic",
    modelApiId: "claude-haiku-4-5",
  });
  expect(out?.type).toBe("content");
  return (out as { value: Array<{ type: string; text?: string }> }).value;
}

describe("browser screenshot → untrusted caption", () => {
  it("the caption beside the image marks it untrusted, with the page's origin", async () => {
    const parts = await screenshotOutput();
    const caption = parts.find((p) => p.type === "text")!.text!;
    expect(caption).toContain('source="web:https://evil.example"');
    expect(caption).toMatch(/never instructions to follow/);
    expect(parts.some((p) => p.type === "file")).toBe(true);
  });

  it("an image the agent opened itself carries no such note", () => {
    const out = buildToolModelOutput(
      "view_image",
      { success: true, mimeType: "image/png", data: PNG, origin: "file", filename: "a.png" },
      { builtinProviderId: "anthropic", modelApiId: "claude-haiku-4-5" },
    ) as { value: Array<{ type: string; text?: string }> };
    expect(out.value.find((p) => p.type === "text")!.text).not.toMatch(/Untrusted/);
  });
});
