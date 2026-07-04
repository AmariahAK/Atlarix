import { describe, expect, it } from "vitest";
import {
  detectVisionCapability,
  registerModelsDevVision,
} from "@/lib/routing/model-capability-profile";
import { extractDelegationDisplaySummary } from "@/lib/agents/register-delegation-tools";
import { exactTokenCountText } from "@/lib/context/token-counter";
import { buildToolModelOutput } from "@/lib/ai/tool-model-output";

/**
 * v14.8.11 post-smoke fix batch (owner-observed in the packaged app):
 * vision detection for native open-weight providers, honest non-vision
 * placeholder, sub-agent popup summary unwrap, tokenizer memo.
 */

describe("vision detection via models.dev modalities", () => {
  it("native DeepSeek v4 (multimodal) is detected once modalities are registered", () => {
    // Before registration: unknown → text-only (the live hallucination case).
    expect(detectVisionCapability("deepseek", "deepseek-v4-pro-test")).toBe(false);
    registerModelsDevVision([
      { providerId: "deepseek", modelId: "deepseek-v4-pro-test", acceptsImages: true },
      { providerId: "deepseek", modelId: "deepseek-old-text-only", acceptsImages: false },
    ]);
    expect(detectVisionCapability("deepseek", "deepseek-v4-pro-test")).toBe(true);
    expect(detectVisionCapability("deepseek", "deepseek-old-text-only")).toBe(false);
  });

  it("bare and vendor-prefixed ids both resolve", () => {
    registerModelsDevVision([
      { providerId: "zai", modelId: "glm-5v-test", acceptsImages: true },
    ]);
    expect(detectVisionCapability(undefined, "glm-5v-test")).toBe(true);
    expect(detectVisionCapability(undefined, "somevendor/glm-5v-test")).toBe(true);
  });

  it("hardcoded native vision providers still short-circuit true", () => {
    expect(detectVisionCapability("anthropic", "anything")).toBe(true);
  });
});

describe("non-vision image placeholder forbids guessing", () => {
  it("tells the model it has NOT seen the image and must not infer from the filename", () => {
    const out = buildToolModelOutput(
      "read_attachment",
      {
        success: true,
        filename: "Screenshot 2026-07-04.png",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUg".repeat(20),
      },
      { builtinProviderId: undefined },
    );
    expect(out?.type).toBe("text");
    const text = (out as { value: string }).value;
    expect(text).toContain("NOT seen this image");
    expect(text).toContain("do not guess");
    expect(text).not.toContain("work from its filename");
  });
});

describe("extractDelegationDisplaySummary", () => {
  const taskXml =
    '<task id="abc" state="completed">\n<summary>Update cron</summary><task_result>**Changes made:** two lines updated.\n\n```diff\n-old\n+new\n```</task_result>\n</task>';

  it("unwraps the registry envelope down to the task_result markdown", () => {
    const envelope = { success: true, result: taskXml, _truncatedOutput: false };
    const { summary, isError } = extractDelegationDisplaySummary(
      envelope,
      JSON.stringify(envelope),
    );
    expect(summary.startsWith("**Changes made:**")).toBe(true);
    expect(summary).toContain("```diff");
    expect(summary).not.toContain('"success":true');
    expect(summary).not.toContain("<task");
    expect(isError).toBe(false);
  });

  it("detects error state through the envelope (the escaped-quote regex bug)", () => {
    const errXml = '<task id="x" state="error">\n<summary>failed</summary>\n</task>';
    const envelope = { success: true, result: errXml, _truncatedOutput: false };
    const { summary, isError } = extractDelegationDisplaySummary(
      envelope,
      JSON.stringify(envelope),
    );
    expect(isError).toBe(true);
    expect(summary).toContain("failed");
  });

  it("plain string results pass through with markup stripped", () => {
    const { summary } = extractDelegationDisplaySummary(taskXml, taskXml);
    expect(summary).toContain("**Changes made:**");
  });
});

describe("tokenizer memo", () => {
  it("repeated counts are identical (memo is transparent)", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(10);
    const first = exactTokenCountText(text);
    const second = exactTokenCountText(text);
    const third = exactTokenCountText(text);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first).toBeGreaterThan(0);
  });

  it("distinct texts get distinct counts (no key collisions)", () => {
    const a = exactTokenCountText("alpha ".repeat(30));
    const b = exactTokenCountText("alpha ".repeat(31));
    expect(a).not.toBe(b);
  });
});
