/**
 * What a chat runs on: its model (with that model's effort) and its work mode.
 *
 * Each chat owns these, as a CLI or editor session already did. The app's global
 * settings (`selectedModel`, `effort`, `deepThinking`, `workModePreference`) are
 * only what a NEW chat starts with: the last thing picked (owner, 2026-10-24).
 * Before 15.11.1 they were the only copy, so picking Haiku or Plan in one chat
 * changed the next turn of every other chat (QA ai-44).
 *
 * Stored on `chat_sessions` (`model` JSON, `work_mode`). NULL reads as the app's
 * default, which is what rows written by an older build still have.
 */
import { z } from "zod";
import { resolveEffectiveWorkMode } from "@/lib/work-mode";
import type { LargeLanguageModel, UserSettings, WorkMode } from "@/lib/schemas";

export const SessionModelChoiceSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  /** Which custom model, when two share a name (the picker's `customModelId`). */
  customModelId: z.number().optional(),
  /** /effort for this model, exactly as the model lists it; absent = its default. */
  effort: z.string().optional(),
  /** The older two-state switch, read when no `effort` is chosen. */
  deepThinking: z.boolean().optional(),
});
export type SessionModelChoice = z.infer<typeof SessionModelChoiceSchema>;

/** The stored column → a choice, or null for NULL / anything unreadable. */
export function parseSessionModel(raw: string | null | undefined): SessionModelChoice | null {
  if (!raw) return null;
  try {
    const parsed = SessionModelChoiceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function serializeSessionModel(choice: SessionModelChoice): string {
  const { provider, name, customModelId, effort, deepThinking } = choice;
  return JSON.stringify({
    provider,
    name,
    ...(customModelId != null ? { customModelId } : {}),
    ...(effort ? { effort } : {}),
    ...(deepThinking !== undefined ? { deepThinking } : {}),
  });
}

/** The model + effort a new chat starts with: the app's current default. */
export function defaultSessionModel(
  settings: Pick<UserSettings, "selectedModel" | "effort" | "deepThinking">,
): SessionModelChoice | null {
  const m = settings.selectedModel;
  if (!m?.provider || !m?.name) return null;
  return {
    provider: m.provider,
    name: m.name,
    ...(m.customModelId != null ? { customModelId: m.customModelId } : {}),
    ...(settings.effort ? { effort: settings.effort } : {}),
    ...(settings.deepThinking !== undefined ? { deepThinking: !!settings.deepThinking } : {}),
  };
}

/** The mode a new chat starts with: what a turn would resolve from the app's settings today. */
export function defaultSessionWorkMode(
  settings: Pick<UserSettings, "intentMode" | "workModePreference" | "selectedChatMode">,
): WorkMode {
  return resolveEffectiveWorkMode({
    intentMode: settings.intentMode,
    workModePreference: settings.workModePreference,
    selectedChatMode: (settings.selectedChatMode ?? "ask") as "ask" | "build" | "agent",
  });
}

/**
 * The settings fields a turn reads for its model's effort, from a chat's choice.
 * `effort: ""` means "the model's default", as the global setting spells it.
 */
export function effortSettingsFor(choice: SessionModelChoice): { effort: string; deepThinking: boolean } {
  return { effort: choice.effort ?? "", deepThinking: !!choice.deepThinking };
}

/** The chat's model as the pickers and model lists name one. */
export function modelOfChoice(choice: SessionModelChoice): LargeLanguageModel {
  return {
    provider: choice.provider,
    name: choice.name,
    ...(choice.customModelId != null ? { customModelId: choice.customModelId } : {}),
  };
}
