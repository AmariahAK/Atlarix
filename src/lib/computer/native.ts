/**
 * The provider's own computer tool, in place of ours, for models whose
 * provider has one (lane.ts). Only the schema the model sees changes: execute
 * and the image result are our tool's, so the activity cards, the deny rules,
 * the stop and the executor are the same in both lanes.
 *
 * Anthropic: the highest computer version the installed SDK has. A model that
 * refuses it (Claude 5.5 on the Anthropic API takes only the newer toolset)
 * falls back to our tool in the same turn; see round-retry and lane.ts.
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
): Promise<Tool> {
  if (lane === "native-anthropic") {
    const { width, height } = await computerDisplaySize();
    return anthropic.tools.computer_20251124({
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
