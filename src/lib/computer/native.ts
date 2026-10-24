/**
 * The provider's own computer tool, in place of ours, for models whose
 * provider has one (lane.ts). Only the schema the model sees changes: execute
 * and the image result are our tool's, so the activity cards, the deny rules,
 * the stop and the executor are the same in both lanes.
 *
 * Anthropic: the version lane.ts picks for the model (the newest the SDK has,
 * until a refusal names another). A model that refuses every one (Claude 5.5
 * on the Anthropic API takes only the newer toolset) gets our tool, in the same
 * turn; see round-retry.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { Tool } from "ai";
import { computerDisplaySize } from "@/lib/tools/computer";
import type { ComputerLane } from "./lane";

type Own = Pick<Tool, "execute" | "toModelOutput">;

export async function nativeComputerTool(
  lane: Exclude<ComputerLane, "own">,
  own: Own,
  /** native-anthropic: the version to declare (lane.ts `anthropicComputerVersion`). */
  version?: string,
): Promise<Tool> {
  if (lane === "native-anthropic") {
    const { width, height } = await computerDisplaySize();
    const make = anthropic.tools[(version ?? "computer_20251124") as "computer_20251124"];
    return make({
      displayWidthPx: width,
      displayHeightPx: height,
      execute: own.execute as never,
      toModelOutput: own.toModelOutput as never,
    }) as Tool;
  }
  return openai.tools.computer({
    execute: own.execute as never,
    toModelOutput: ({ input, output }: { input: unknown; output: unknown }) => {
      const o = output as { mimeType?: string; data?: string; error?: string };
      if (!o?.data) {
        // OpenAI takes only a screenshot back; without one the model gets the
        // reason as text and the API decides.
        return { type: "text", value: o?.error ?? "The action failed." };
      }
      return {
        type: "json",
        value: {
          output: { type: "computer_screenshot", imageUrl: `data:${o.mimeType};base64,${o.data}` },
          // The switch is the user's consent to act (owner, 2026-10-23).
          acknowledgedSafetyChecks: (input as { pendingSafetyChecks?: unknown[] })?.pendingSafetyChecks ?? [],
        },
      };
    },
  } as never) as Tool;
}
