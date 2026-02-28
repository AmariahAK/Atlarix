/**
 * Generate a simple human-readable description for a beacon using the user's AI (fast model).
 * Used when user clicks "Simplify" in Blueprint beacon details.
 */

import { generateText } from "ai";
import { readSettings } from "@/main/settings";
import { getSummarizationModelAsync } from "@/lib/summarization_model";
import { getModelClient } from "@/ipc/utils/get_model_client";

const SYSTEM = `You are a technical writer. Given a code element (name, kind, and optional technical description), reply with exactly one short sentence (max 15 words) that describes what it does for a developer. No quotes, no preamble.`;

const ROOM_SYSTEM = `You are a technical writer. Given a container or module name and optional path and list of function/component names, reply with exactly one short sentence (max 15 words) that describes what this container does. No quotes, no preamble.`;

const ARCH_SYSTEM = `You are a technical writer. Given a list of container/module names and the number of connections between them, reply with exactly one short sentence (max 25 words) summarizing the high-level architecture. No quotes, no preamble.`;

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

export async function simplifyRoomWithAI(
  label: string,
  pathOrUndefined?: string,
  functionNames?: string[]
): Promise<string | null> {
  try {
    const settings = readSettings();
    const modelConfig = await getSummarizationModelAsync(settings);
    const { modelClient } = await getModelClient(modelConfig, settings);
    const pathPart = pathOrUndefined ? ` Path: ${pathOrUndefined}.` : "";
    const namesPart =
      functionNames && functionNames.length > 0
        ? ` Contains: ${functionNames.slice(0, 12).join(", ")}${functionNames.length > 12 ? "..." : ""}.`
        : "";
    const userContent = `Container: ${label}.${pathPart}${namesPart}`;
    const result = await generateText({
      model: modelClient.model,
      system: ROOM_SYSTEM,
      messages: [{ role: "user", content: userContent }],
      maxTokens: 60,
    });
    const text = result.text.trim().replace(/^["']|["']$/g, "");
    return text.slice(0, 120) || null;
  } catch {
    return null;
  }
}

export async function simplifyArchitectureWithAI(
  roomLabels: string[],
  edgeCount: number
): Promise<string | null> {
  try {
    const settings = readSettings();
    const modelConfig = await getSummarizationModelAsync(settings);
    const { modelClient } = await getModelClient(modelConfig, settings);
    const list = roomLabels.length > 15 ? roomLabels.slice(0, 15).join(", ") + "..." : roomLabels.join(", ");
    const userContent = `Containers: ${list}. Connections: ${edgeCount}.`;
    const result = await generateText({
      model: modelClient.model,
      system: ARCH_SYSTEM,
      messages: [{ role: "user", content: userContent }],
      maxTokens: 80,
    });
    const text = result.text.trim().replace(/^["']|["']$/g, "");
    return text.slice(0, 200) || null;
  } catch {
    return null;
  }
}
