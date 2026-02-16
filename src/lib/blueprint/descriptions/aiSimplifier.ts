/**
 * Generate a simple human-readable description for a beacon using the user's AI (fast model).
 * Used when user clicks "Simplify" in Blueprint beacon details.
 */

import { generateText } from "ai";
import { readSettings } from "@/main/settings";
import { getSummarizationModelAsync } from "@/lib/summarization_model";
import { getModelClient } from "@/ipc/utils/get_model_client";

const SYSTEM = `You are a technical writer. Given a code element (name, kind, and optional technical description), reply with exactly one short sentence (max 15 words) that describes what it does for a developer. No quotes, no preamble.`;

export async function simplifyDescriptionWithAI(
  name: string,
  kind: string,
  technicalDescription?: string
): Promise<string | null> {
  try {
    const settings = readSettings();
    const modelConfig = await getSummarizationModelAsync(settings);
    const { modelClient } = await getModelClient(modelConfig, settings);
    const userContent = technicalDescription
      ? `${kind}: ${name}. Technical: ${technicalDescription}`
      : `${kind}: ${name}`;
    const result = await generateText({
      model: modelClient.model,
      system: SYSTEM,
      messages: [{ role: "user", content: userContent }],
      maxTokens: 50,
    });
    const text = result.text.trim().replace(/^["']|["']$/g, "");
    return text.slice(0, 120) || null;
  } catch {
    return null;
  }
}
