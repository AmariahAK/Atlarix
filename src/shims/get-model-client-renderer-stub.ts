/**
 * Renderer stub for `@/ipc/utils/get_model_client`.
 *
 * The real module instantiates provider SDKs (@ai-sdk/google-vertex →
 * google-auth-library → gaxios, a Node-only HTTP lib) which cannot be bundled
 * into the browser/renderer target. The renderer never DISPATCHES models — that
 * happens in the main process via IPC — it only transitively pulls this module
 * in through the chat-title / summarization chain. So we stub it: the pure
 * model-SELECTION helpers keep working (zero provider deps), and `getModelClient`
 * throws loudly if it's ever actually called in the renderer.
 */
import type { LargeLanguageModel, UserSettings } from "@/lib/schemas";

export function getEffectiveModel(settings: UserSettings): LargeLanguageModel {
  return settings.selectedModel;
}

export function getEffectiveModelForOptions(
  settings: UserSettings,
): LargeLanguageModel {
  return settings.selectedModel;
}

export function getFastModelForCurrentProvider(
  _settings: UserSettings,
  _openRouterFavoriteIds?: string[],
): LargeLanguageModel | null {
  return null;
}

export function getBalancedModelForCurrentProvider(
  _settings: UserSettings,
  _openRouterFavoriteIds?: string[],
): LargeLanguageModel | null {
  return null;
}

export async function getModelClient(): Promise<never> {
  throw new Error(
    "getModelClient() is main-process only — model dispatch must go through IPC, not the renderer.",
  );
}
